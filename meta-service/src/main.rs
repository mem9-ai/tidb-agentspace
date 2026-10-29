mod config;
mod engine;
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
use config::{Config, private_file};
use engine::{Engine, Failure, Request};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
#[derive(Clone)]
struct App {
    engine: Arc<Mutex<Engine>>,
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
    let e = app.engine.lock().await;
    e.barrier().await?;
    Ok(Json(e.health()))
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
    // Detached execution preserves the commit serialization boundary after a client disconnect.
    tokio::spawn(async move {
        let _permit = permit;
        app.engine.lock().await.execute(request).await
    })
    .await
    .map_err(|_| Failure(503, "META_UNAVAILABLE"))?
    .map(Json)
}
async fn shutdown() {
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
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let i = args.iter().position(|v| v == "--config").ok_or_else(|| {
        anyhow::anyhow!(
            "Use --config <private-file> [--initialize] [--recover-owner <stopped-owner-id>]"
        )
    })?;
    let path = args
        .get(i + 1)
        .ok_or_else(|| anyhow::anyhow!("Missing config path"))?;
    let config = Config::load(std::path::Path::new(path))?;
    let token = String::from_utf8(private_file(&config.token_file)?)?
        .trim()
        .as_bytes()
        .to_vec();
    if token.len() < 32 {
        anyhow::bail!("Service token must contain at least 32 bytes");
    }
    let recover = args
        .iter()
        .position(|v| v == "--recover-owner")
        .and_then(|i| args.get(i + 1));
    let engine=Engine::open(config.clone(),args.iter().any(|v|v=="--initialize"),recover.map(String::as_str)).await.map_err(|_|anyhow::anyhow!("Metadata startup failed: verify installation, encryption, storage and exclusive ownership; no state was seeded automatically"))?;
    let state = App {
        engine: Arc::new(Mutex::new(engine)),
        token: Arc::new(token),
        authority: config.authority_id.clone(),
        installation: config.installation_id.clone(),
        capacity: Arc::new(Semaphore::new(8)),
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/meta", post(command))
        .layer(DefaultBodyLimit::max(19 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state.clone());
    println!(
        "Metadata service {} listening on {}",
        config.authority_id, config.bind
    );
    if config.insecure_loopback {
        let listener = tokio::net::TcpListener::bind(config.bind).await?;
        axum::serve(listener, app)
            .with_graceful_shutdown(shutdown())
            .await?;
    } else {
        let tls = config.tls.as_ref().expect("validated TLS configuration");
        let mut roots = rustls::RootCertStore::empty();
        for cert in rustls_pemfile::certs(&mut std::io::Cursor::new(std::fs::read(
            &tls.client_ca_file,
        )?)) {
            roots.add(cert?)?;
        }
        let verifier = rustls::server::WebPkiClientVerifier::builder(Arc::new(roots)).build()?;
        let certs = rustls_pemfile::certs(&mut std::io::Cursor::new(std::fs::read(
            &tls.certificate_file,
        )?))
        .collect::<Result<Vec<_>, _>>()?;
        let key = rustls_pemfile::private_key(&mut std::io::Cursor::new(private_file(
            &tls.private_key_file,
        )?))?
        .ok_or_else(|| anyhow::anyhow!("Missing TLS key"))?;
        let config =
            rustls::ServerConfig::builder_with_protocol_versions(&[&rustls::version::TLS13])
                .with_client_cert_verifier(verifier)
                .with_single_cert(certs, key)?;
        let tls = axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(config));
        let handle = axum_server::Handle::new();
        let stop = handle.clone();
        tokio::spawn(async move {
            shutdown().await;
            stop.graceful_shutdown(Some(Duration::from_secs(20)));
        });
        let bind = state.engine.lock().await.config.bind;
        axum_server::bind_rustls(bind, tls)
            .handle(handle)
            .serve(app.into_make_service())
            .await?;
    }
    state.engine.lock().await.close().await?;
    Ok(())
}
