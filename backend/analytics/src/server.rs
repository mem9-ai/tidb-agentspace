use crate::config::private_file;
use crate::{
    Attribution, Batch, Job,
    config::{Config, token},
    database::Database,
    store::Store,
};
use anyhow::Result;
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;
use std::{sync::Arc, time::Duration};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;
use workspace_contracts::ServiceError;

pub struct Service {
    config: Config,
    state: Arc<App>,
}
struct App {
    store: Store,
    db: Arc<Database>,
    token: String,
    capacity: Arc<Semaphore>,
    campaigns: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Native {
    jobs: Vec<Job>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Attribute {
    workspace: String,
    attribution: Attribution,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Range {
    from: String,
    to: String,
}
fn error(error: ServiceError) -> Response {
    (
        StatusCode::from_u16(error.status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE),
        Json(json!({"error":{"code":error.code}})),
    )
        .into_response()
}
fn authorize(app: &App, headers: &HeaderMap) -> workspace_contracts::Result<()> {
    let candidate = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if headers.contains_key("origin")
        || candidate.len() != app.token.len()
        || !bool::from(candidate.as_bytes().ct_eq(app.token.as_bytes()))
        || headers
            .get("x-analytics-authority")
            .and_then(|v| v.to_str().ok())
            != Some(app.store.authority())
    {
        return Err(ServiceError::new(403, "ANALYTICS_PRODUCER_REQUIRED"));
    }
    Ok(())
}
async fn handle(State(app): State<Arc<App>>, request: Request) -> Response {
    let result = async {
        authorize(&app, request.headers())?;
        let _permit = app
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| ServiceError::new(429, "ANALYTICS_BUSY"))?;
        let path = request.uri().path().to_owned();
        if request
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            != Some("application/json")
        {
            return Err(ServiceError::new(415, "JSON_REQUIRED"));
        }
        let body = to_bytes(request.into_body(), 32 * 1024)
            .await
            .map_err(|_| ServiceError::new(413, "ANALYTICS_BATCH_TOO_LARGE"))?;
        let invalid = |_| ServiceError::new(422, "INVALID_ANALYTICS_INPUT");
        match path.as_str() {
            "/analytics/v1/native" => {
                let batch: Native = serde_json::from_slice(&body).map_err(invalid)?;
                if batch.jobs.is_empty() || batch.jobs.len() > 64 {
                    return Err(ServiceError::new(422, "INVALID_ANALYTICS_INPUT"));
                }
                for job in &batch.jobs {
                    job.validate()?;
                }
                app.store.server_batch(batch.jobs).await?;
            }
            "/analytics/v1/browser" => {
                let batch: Batch = serde_json::from_slice(&body).map_err(invalid)?;
                batch.validate(&app.campaigns)?;
                app.store
                    .browser(batch, chrono::Utc::now().timestamp())
                    .await?;
            }
            "/analytics/v1/attribution" => {
                let value: Attribute = serde_json::from_slice(&body).map_err(invalid)?;
                app.store
                    .attribute(&value.workspace, value.attribution)
                    .await?;
            }
            "/analytics/v1/summary" => {
                let range: Range = serde_json::from_slice(&body).map_err(invalid)?;
                let parse = |s: &str| {
                    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                        .map_err(|_| ServiceError::new(422, "INVALID_ANALYTICS_RANGE"))
                };
                let summary = app
                    .store
                    .summary(
                        parse(&range.from)?,
                        parse(&range.to)?,
                        chrono::Utc::now().timestamp(),
                    )
                    .await?;
                return Ok(Json(
                    serde_json::to_value(summary)
                        .map_err(|_| ServiceError::new(503, "ANALYTICS_UNAVAILABLE"))?,
                )
                .into_response());
            }
            _ => return Err(ServiceError::new(404, "NOT_FOUND")),
        }
        Ok((
            StatusCode::ACCEPTED,
            Json(json!({"accepted":true,"durability":"queued"})),
        )
            .into_response())
    }
    .await;
    match result {
        Ok(response) => response,
        Err(e) => error(e),
    }
}
impl Service {
    pub async fn open(config: Config, initialize: bool) -> Result<Self> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        config.validate()?;
        let db = Arc::new(Database::open(&config, initialize).await?);
        let store = Store::new(
            db.clone(),
            &config.authority_id,
            private_file(&config.pseudonym_key_file)?,
        )?;
        let state = Arc::new(App {
            store,
            db,
            token: token(&config.token_file)?,
            capacity: Arc::new(Semaphore::new(8)),
            campaigns: config.campaigns.clone(),
        });
        Ok(Self { config, state })
    }
    pub async fn close(&self) -> Result<()> {
        self.state.db.close().await
    }
    pub async fn serve(
        self,
        stop: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> Result<()> {
        let router = Router::new().route("/health", get(|State(app): State<Arc<App>>| async move {
            (if app.db.available() { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE }, Json(json!({"profile":"analytics_single_writer","durability":"best_effort_async"})))
        }))
            .route("/analytics/v1/{kind}", post(handle)).with_state(self.state.clone());
        if let Some(tls) = &self.config.tls {
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
            .ok_or_else(|| anyhow::anyhow!("Missing analytics TLS key"))?;
            let tls =
                rustls::ServerConfig::builder_with_protocol_versions(&[&rustls::version::TLS13])
                    .with_client_cert_verifier(verifier)
                    .with_single_cert(certs, key)?;
            let handle = axum_server::Handle::new();
            let shutdown = handle.clone();
            tokio::spawn(async move {
                stop.await;
                shutdown.graceful_shutdown(Some(Duration::from_secs(5)));
            });
            axum_server::bind_rustls(
                self.config.bind,
                axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(tls)),
            )
            .handle(handle)
            .serve(router.into_make_service())
            .await?;
        } else {
            axum::serve(
                tokio::net::TcpListener::bind(self.config.bind).await?,
                router,
            )
            .with_graceful_shutdown(stop)
            .await?;
        }
        self.close().await
    }
}
