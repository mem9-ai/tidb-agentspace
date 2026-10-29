use crate::config::{Config, private_file};
use crate::engine::{Engine, Failure, Request};
use axum::{
    Extension,
    extract::Request as HttpRequest,
    middleware::{self, Next},
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use subtle::ConstantTimeEq;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
#[derive(Clone)]
struct App {
    engine: Arc<Engine>,
    token: Arc<Vec<u8>>,
    authority: String,
    installation: String,
    capacity: Arc<Semaphore>,
}
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        (StatusCode::from_u16(self.0).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),Json(json!({"error":{"code":self.1,"message":"Metadata request could not be completed."}}))).into_response()
    }
}
fn authorize(app: &App, headers: &HeaderMap) -> Result<(), Failure> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !bool::from(app.token.as_slice().ct_eq(token.as_bytes())) {
        return Err(Failure(401, "META_UNAUTHORIZED"));
    }
    if headers
        .get("x-meta-authority")
        .and_then(|v| v.to_str().ok())
        != Some(&app.authority)
    {
        return Err(Failure(403, "META_AUTHORITY_MISMATCH"));
    }
    if headers
        .get("x-meta-installation")
        .and_then(|v| v.to_str().ok())
        != Some(&app.installation)
    {
        return Err(Failure(403, "META_INSTALLATION_MISMATCH"));
    }
    Ok(())
}
async fn guard(State(app): State<App>, mut request: HttpRequest, next: Next) -> Response {
    if let Err(error) = authorize(&app, request.headers()) {
        return error.into_response();
    }
    let permit = match app.capacity.clone().try_acquire_owned() {
        Ok(permit) => Arc::new(permit),
        Err(_) => return Failure(429, "META_BUSY").into_response(),
    };
    request.extensions_mut().insert(permit);
    next.run(request).await
}
async fn health(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>, Failure> {
    authorize(&app, &headers)?;
    app.engine.check_health().await.map(Json)
}
async fn command(
    State(app): State<App>,
    headers: HeaderMap,
    Extension(permit): Extension<Arc<OwnedSemaphorePermit>>,
    bytes: Bytes,
) -> Result<Json<Value>, Failure> {
    authorize(&app, &headers)?;
    let request: Request =
        serde_json::from_slice(&bytes).map_err(|_| Failure(400, "META_INVALID_REQUEST"))?;
    // Accepted transactions finish and retain their receipt after a client disconnect.
    tokio::spawn(async move {
        let _permit = permit;
        app.engine.execute(request).await
    })
    .await
    .map_err(|_| Failure(503, "META_UNAVAILABLE"))?
    .map(Json)
}
pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {_=term.recv()=>{},_=tokio::signal::ctrl_c()=>{}}
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// A real metadata authority, reusable by a standalone server or an embedding host.
pub struct MetaService {
    state: App,
    config: Config,
}
impl MetaService {
    pub async fn open(
        config: Config,
        initialize: bool,
        recover: Option<&str>,
    ) -> anyhow::Result<Self> {
        config.validate()?;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let token = String::from_utf8(private_file(&config.token_file)?)?
            .trim()
            .as_bytes()
            .to_vec();
        if token.len() < 32 {
            anyhow::bail!("Service token must contain at least 32 bytes");
        }
        let engine = Engine::open(config.clone(), initialize, recover).await.map_err(|_| anyhow::anyhow!("Metadata startup failed: verify installation, encryption, storage and exclusive ownership; no state was seeded automatically"))?;
        Ok(Self {
            state: App {
                engine: Arc::new(engine),
                token: Arc::new(token),
                authority: config.authority_id.clone(),
                installation: config.installation_id.clone(),
                capacity: Arc::new(Semaphore::new(8)),
            },
            config,
        })
    }
    pub async fn close(&self) -> anyhow::Result<()> {
        self.state.engine.close().await
    }
    pub async fn serve(
        &self,
        stop: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> anyhow::Result<()> {
        let app = Router::new()
            .route("/health", get(health))
            .route("/v1/meta", post(command))
            .layer(DefaultBodyLimit::max(19 * 1024 * 1024))
            .layer(middleware::from_fn_with_state(self.state.clone(), guard))
            .with_state(self.state.clone());
        println!(
            "Metadata service {} listening on {}",
            self.config.authority_id, self.config.bind
        );
        if self.config.insecure_loopback {
            let listener = tokio::net::TcpListener::bind(self.config.bind).await?;
            axum::serve(listener, app)
                .with_graceful_shutdown(stop)
                .await?;
        } else {
            let tls = self
                .config
                .tls
                .as_ref()
                .expect("validated TLS configuration");
            let mut roots = rustls::RootCertStore::empty();
            for cert in rustls_pemfile::certs(&mut std::io::Cursor::new(std::fs::read(
                &tls.client_ca_file,
            )?)) {
                roots.add(cert?)?;
            }
            let verifier =
                rustls::server::WebPkiClientVerifier::builder(Arc::new(roots)).build()?;
            let certs = rustls_pemfile::certs(&mut std::io::Cursor::new(std::fs::read(
                &tls.certificate_file,
            )?))
            .collect::<Result<Vec<_>, _>>()?;
            let key = rustls_pemfile::private_key(&mut std::io::Cursor::new(private_file(
                &tls.private_key_file,
            )?))?
            .ok_or_else(|| anyhow::anyhow!("Missing TLS key"))?;
            let tls_config =
                rustls::ServerConfig::builder_with_protocol_versions(&[&rustls::version::TLS13])
                    .with_client_cert_verifier(verifier)
                    .with_single_cert(certs, key)?;
            let handle = axum_server::Handle::new();
            let shutdown = handle.clone();
            tokio::spawn(async move {
                stop.await;
                shutdown.graceful_shutdown(Some(Duration::from_secs(20)));
            });
            axum_server::bind_rustls(
                self.config.bind,
                axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(tls_config)),
            )
            .handle(handle)
            .serve(app.into_make_service())
            .await?;
        }
        Ok(())
    }
}
impl workspace_contracts::Metadata for MetaService {
    fn execute(&self, request: Request) -> workspace_contracts::Call<'_> {
        let engine = self.state.engine.clone();
        let capacity = self.state.capacity.clone();
        Box::pin(async move {
            let permit = capacity
                .try_acquire_owned()
                .map_err(|_| workspace_contracts::ServiceError::new(429, "META_BUSY"))?;
            tokio::spawn(async move {
                let _permit = permit;
                engine
                    .execute(request)
                    .await
                    .map_err(|e| workspace_contracts::ServiceError::new(e.0, e.1))
            })
            .await
            .map_err(|_| workspace_contracts::ServiceError::new(503, "META_COMMIT_UNKNOWN"))?
        })
    }
    fn health(&self) -> workspace_contracts::Call<'_> {
        Box::pin(async {
            self.state
                .engine
                .check_health()
                .await
                .map_err(|e| workspace_contracts::ServiceError::new(e.0, e.1))
        })
    }
}
