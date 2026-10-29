use anyhow::{Result, bail};
use axum::{
    Extension, Json, Router,
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::any,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    net::TcpListener,
    sync::{Mutex, OwnedSemaphorePermit, Semaphore},
};
use workspace_contracts::{Metadata, ServiceError};
use workspace_domain::{Credential, Operation, Repository, Workspace, secret};
use workspace_meta_client::{ClientConfig, private_file};

#[derive(Clone, Deserialize)]
#[serde(tag = "transport", rename_all = "camelCase", deny_unknown_fields)]
pub enum MetaBinding {
    InProcess {
        #[serde(rename = "authorityId")]
        authority_id: String,
    },
    Remote {
        client: ClientConfig,
    },
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub bind: SocketAddr,
    pub workspace_id: String,
    pub authority_id: String,
    pub import_id: String,
    pub metadata: MetaBinding,
    pub insecure_loopback: bool,
    pub console_origins: Vec<String>,
    pub recover_gateway_owner: Option<String>,
    #[serde(default)]
    pub product: Option<workspace_product::Config>,
}
impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let result: Self = serde_json::from_slice(&private_file(path)?)
            .map_err(|_| anyhow::anyhow!("Invalid private Workspace configuration"))?;
        result.validate()?;
        Ok(result)
    }
    pub fn validate(&self) -> Result<()> {
        let result = self;
        if !result.insecure_loopback
            || !result.bind.ip().is_loopback()
            || !result.bind.is_ipv4()
            || result.workspace_id != "ws_agentlab"
            || !result.authority_id.starts_with("region:")
            || result.import_id.is_empty()
        {
            bail!(
                "The Workspace migration profile requires explicit IPv4 loopback and regional identity"
            );
        }
        match &result.metadata {
            MetaBinding::InProcess { authority_id } if authority_id != &result.authority_id => {
                bail!("Wrong metadata authority")
            }
            MetaBinding::Remote { client } if client.authority_id != result.authority_id => {
                bail!("Wrong metadata authority")
            }
            _ => {}
        }
        for origin in &result.console_origins {
            let url = reqwest::Url::parse(origin)?;
            if url.scheme() != "http"
                || !["localhost", "127.0.0.1"].contains(&url.host_str().unwrap_or_default())
                || url.origin().ascii_serialization() != *origin
            {
                bail!("Console origins must be exact HTTP loopback origins");
            }
        }
        if let Some(product) = &self.product {
            product.validate()?;
        }
        Ok(())
    }
}
#[derive(Clone)]
struct App {
    workspace: Arc<Workspace>,
    product: Option<Arc<workspace_product::Product>>,
    config: Config,
    sessions: Arc<Mutex<BTreeMap<String, Instant>>>,
    capacity: Arc<Semaphore>,
}
pub struct WorkspaceServer {
    pub workspace: Arc<Workspace>,
    listener: TcpListener,
    app: App,
}
impl WorkspaceServer {
    pub async fn open(config: Config, metadata: Arc<dyn Metadata>) -> Result<Self> {
        config.validate()?;
        let listener = TcpListener::bind(config.bind).await?;
        let repository = Repository::open(
            metadata,
            &config.authority_id,
            &config.workspace_id,
            &config.import_id,
            config.recover_gateway_owner.as_deref(),
        )
        .await?;
        let workspace = Arc::new(Workspace::new(repository));
        let product = if let Some(config) = config.product.clone() {
            match workspace_product::Product::new(workspace.clone(), config).await {
                Ok(p) => Some(Arc::new(p)),
                Err(e) => {
                    let _ = workspace.close().await;
                    return Err(e.into());
                }
            }
        } else {
            None
        };
        Ok(Self {
            workspace: workspace.clone(),
            listener,
            app: App {
                workspace,
                product,
                config,
                sessions: Arc::new(Mutex::new(BTreeMap::new())),
                capacity: Arc::new(Semaphore::new(8)),
            },
        })
    }
    pub async fn serve(
        self,
        stop: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> Result<()> {
        let router = Router::new()
            .fallback(any(handle))
            .layer(middleware::from_fn_with_state(self.app.clone(), policy))
            .with_state(self.app);
        axum::serve(self.listener, router)
            .with_graceful_shutdown(stop)
            .await?;
        Ok(())
    }
}
fn error(error: ServiceError) -> Response {
    let message = match error.code.as_str() {
        "UNAUTHENTICATED" => "Start a local demo session or provide a workspace API key.",
        "INVALID_KEY" => "API key is invalid, expired, or revoked.",
        "OWNER_REQUIRED" => "This action requires the local owner session.",
        "NOT_FOUND" => "Workspace or endpoint not found.",
        _ => "The operation could not be completed.",
    };
    let id = uuid::Uuid::new_v4().to_string();
    let mut response = (
        StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(json!({"error":{"code":error.code,"message":message,"requestId":id}})),
    )
        .into_response();
    response.headers_mut().insert(
        "X-Request-Id",
        HeaderValue::from_str(&id).expect("UUID header"),
    );
    response
}
fn reject(status: u16, code: &str) -> ServiceError {
    ServiceError::new(status, code)
}
async fn policy(State(app): State<App>, mut request: Request, next: Next) -> Response {
    let headers = request.headers();
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let hostname = host.split(':').next().unwrap_or_default();
    let origin = headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let allowed = origin
        .as_ref()
        .is_none_or(|o| app.config.console_origins.contains(o) || o == &format!("http://{host}"));
    let mut response = if !["localhost", "127.0.0.1"].contains(&hostname) {
        error(reject(403, "LOCAL_ONLY"))
    } else if !allowed {
        error(reject(403, "ORIGIN_DENIED"))
    } else if request.method() == Method::OPTIONS {
        let method = headers
            .get("access-control-request-method")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        let requested = headers
            .get("access-control-request-headers")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        if origin.is_none()
            || !["GET", "POST", "PUT", "PATCH", "DELETE"].contains(&method)
            || requested
                .split(',')
                .map(|v| v.trim().to_ascii_lowercase())
                .filter(|v| !v.is_empty())
                .any(|v| {
                    ![
                        "content-type",
                        "authorization",
                        "idempotency-key",
                        "if-none-match",
                    ]
                    .contains(&v.as_str())
                })
        {
            error(reject(403, "PREFLIGHT_DENIED"))
        } else {
            let mut response = StatusCode::NO_CONTENT.into_response();
            response.headers_mut().insert(
                "Access-Control-Allow-Methods",
                HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE"),
            );
            response.headers_mut().insert(
                "Access-Control-Allow-Headers",
                HeaderValue::from_static(
                    "content-type, authorization, idempotency-key, if-none-match",
                ),
            );
            response
        }
    } else {
        match app.capacity.clone().try_acquire_owned() {
            Ok(permit) => {
                request.extensions_mut().insert(Arc::new(permit));
                next.run(request).await
            }
            Err(_) => error(reject(429, "API_BUSY")),
        }
    };
    let output = response.headers_mut();
    output.insert("Vary", HeaderValue::from_static("Origin"));
    output.insert("Cache-Control", HeaderValue::from_static("no-store"));
    output.insert(
        "X-Content-Type-Options",
        HeaderValue::from_static("nosniff"),
    );
    if !output.contains_key("X-Request-Id") {
        output.insert(
            "X-Request-Id",
            HeaderValue::from_str(&uuid::Uuid::new_v4().to_string()).expect("UUID header"),
        );
    }
    if allowed && let Some(origin) = origin.and_then(|s| HeaderValue::from_str(&s).ok()) {
        output.insert("Access-Control-Allow-Origin", origin);
        output.insert(
            "Access-Control-Allow-Credentials",
            HeaderValue::from_static("true"),
        );
        output.insert(
            "Access-Control-Expose-Headers",
            HeaderValue::from_static("X-Request-Id"),
        );
    }
    response
}
async fn handle(
    State(app): State<App>,
    Extension(permit): Extension<Arc<OwnedSemaphorePermit>>,
    request: Request,
) -> Response {
    let cancellation = tokio_util::sync::CancellationToken::new();
    let _on_disconnect = cancellation.clone().drop_guard();
    let result = tokio::spawn(async move {
        let _permit = permit;
        dispatch(app, request, cancellation).await
    })
    .await;
    match result {
        Ok(Ok(response)) => response,
        Ok(Err(e)) => error(e),
        Err(_) => error(reject(503, "API_UNAVAILABLE")),
    }
}
async fn dispatch(
    app: App,
    request: Request,
    cancellation: tokio_util::sync::CancellationToken,
) -> std::result::Result<Response, ServiceError> {
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    let headers = request.headers().clone();
    let prefix = format!("/api/v1/workspaces/{}", app.config.workspace_id);
    if path == "/openapi.json" && method == Method::GET && app.product.is_some() {
        return Ok((
            [("Content-Type", "application/json")],
            include_str!("../../../public/openapi.json"),
        )
            .into_response());
    }
    let query: BTreeMap<String, String> =
        reqwest::Url::parse(&format!("http://localhost{}", request.uri()))
            .map_err(|_| reject(400, "INVALID_PATH"))?
            .query_pairs()
            .into_owned()
            .collect();
    // Reject another Workspace before reading metadata or constructing a principal.
    if path != "/api/health"
        && path != "/api/session"
        && path != "/api/v1/workspaces"
        && path != prefix
        && !path.starts_with(&(prefix.clone() + "/"))
    {
        return Err(reject(404, "NOT_FOUND"));
    }
    if path == "/api/health" && method == Method::GET {
        app.workspace.health().await?;
        if let Some(product) = &app.product {
            return Ok(Json(json!({"status":"ok","mode":product.mode().await?,"filesProvider":product.providers.config.files_provider})).into_response());
        }
        return Ok(Json(json!({"status":"ok","mode":"demo","filesProvider":"local","migrationProfile":"workspace-keys-only"})).into_response());
    }
    let bytes = tokio::time::timeout(
        Duration::from_secs(10),
        to_bytes(
            request.into_body(),
            if path.contains("/file-exports") {
                8 * 1024 * 1024
            } else {
                1024 * 1024
            },
        ),
    )
    .await
    .map_err(|_| reject(408, "REQUEST_TIMEOUT"))?
    .map_err(|_| reject(413, "BODY_TOO_LARGE"))?;
    let body = || {
        if !headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("application/json"))
        {
            return Err(reject(415, "JSON_REQUIRED"));
        }
        let value = if bytes.is_empty() {
            json!({})
        } else {
            serde_json::from_slice::<Value>(&bytes).map_err(|_| reject(400, "INVALID_JSON"))?
        };
        if !value.is_object() {
            return Err(reject(400, "INVALID_BODY"));
        }
        Ok(value)
    };
    if path == "/api/session" && method == Method::POST {
        body()?;
        app.workspace.health().await?;
        let token = secret(32)?;
        let now = Instant::now();
        let mut sessions = app.sessions.lock().await;
        sessions.retain(|_, expires| *expires > now);
        if sessions.len() >= 4096 {
            return Err(reject(429, "SESSION_BUSY"));
        }
        sessions.insert(token.clone(), now + Duration::from_secs(28800));
        let mut response =
            Json(json!({"workspaceId":app.config.workspace_id,"mode":"demo"})).into_response();
        response.headers_mut().insert(
            "Set-Cookie",
            HeaderValue::from_str(&format!(
                "aw_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800"
            ))
            .expect("hex cookie"),
        );
        return Ok(response);
    }
    let credential = credential(&app, &headers).await?;
    let route = path.strip_prefix(&prefix).unwrap_or_default();
    let operation = if path == "/api/v1/workspaces" && method == Method::GET {
        Operation::ListWorkspaces
    } else {
        match (method.as_str(), route) {
            ("GET", "") if path == prefix => Operation::GetWorkspace,
            ("GET", "/keys") => Operation::ListKeys,
            ("POST", "/keys") => Operation::CreateKey(body()?),
            ("PATCH", "/settings") => Operation::UpdateSettings(body()?),
            ("GET", "/events") => Operation::ListEvents,
            ("DELETE", path)
                if path.starts_with("/keys/")
                    && !path[6..].is_empty()
                    && !path[6..].contains('/') =>
            {
                Operation::RevokeKey(path[6..].to_owned())
            }
            _ => {
                if let Some(product) = &app.product {
                    let raw_upload = method == Method::PUT && route == "/files/content";
                    let input = if raw_upload {
                        if headers.get("content-type").and_then(|v| v.to_str().ok())
                            != Some("application/octet-stream")
                        {
                            return Err(reject(415, "BINARY_REQUIRED"));
                        }
                        json!({})
                    } else if [Method::POST, Method::PUT, Method::PATCH, Method::DELETE]
                        .contains(&method)
                    {
                        body()?
                    } else {
                        json!({})
                    };
                    let actor = headers
                        .get("cookie")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default();
                    let condition = headers
                        .get(if raw_upload {
                            "if-none-match"
                        } else {
                            "idempotency-key"
                        })
                        .and_then(|v| v.to_str().ok());
                    let (status, reply) = tokio::select! {
                        result=product.handle(workspace_product::Request {credential:credential.clone(),actor,method:method.as_str(),route,query:&query,input,raw:&bytes,condition})=>result?,
                        _=cancellation.cancelled()=>return Err(reject(499,if route.contains("analys")||route.contains("tabular-preview"){"ANALYSIS_CANCELED"}else{"SQL_CANCELED"})),
                    };
                    credential_for_response(&app, &headers, &credential).await?;
                    return product_response(status, reply);
                }
                return Err(reject(404, "NOT_FOUND"));
            }
        }
    };
    let response = app.workspace.call(credential, operation).await?;
    Ok((
        StatusCode::from_u16(response.status).expect("domain response status"),
        Json(response.body),
    )
        .into_response())
}
async fn credential(
    app: &App,
    headers: &HeaderMap,
) -> std::result::Result<Credential, ServiceError> {
    if let Some(header) = headers.get("authorization") {
        let token = header
            .to_str()
            .ok()
            .and_then(|s| s.strip_prefix("Bearer "))
            .filter(|s| !s.is_empty() && !s.chars().any(char::is_whitespace))
            .ok_or_else(|| reject(401, "INVALID_KEY"))?;
        return Ok(Credential::Bearer(token.to_owned()));
    }
    let token = headers
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| {
            s.split(';')
                .map(str::trim)
                .find_map(|v| v.strip_prefix("aw_session="))
        });
    if let Some(token) = token
        && app
            .sessions
            .lock()
            .await
            .get(token)
            .is_some_and(|expires| *expires > Instant::now())
    {
        return Ok(Credential::LocalDemoOwner);
    }
    Err(reject(401, "UNAUTHENTICATED"))
}

async fn credential_for_response(
    app: &App,
    headers: &HeaderMap,
    input: &Credential,
) -> std::result::Result<(), ServiceError> {
    credential(app, headers).await?;
    workspace_domain::principal(&app.workspace.repository().read().await?, input)?;
    Ok(())
}
fn product_response(
    status: u16,
    reply: workspace_product::Reply,
) -> std::result::Result<Response, ServiceError> {
    match reply {
        workspace_product::Reply::Json(value) => Ok((
            StatusCode::from_u16(status).map_err(|_| reject(500, "INTERNAL_ERROR"))?,
            Json(value),
        )
            .into_response()),
        workspace_product::Reply::Download {
            response,
            size,
            filename,
        } => {
            use futures::StreamExt;
            let stream = futures::stream::try_unfold(
                (response.bytes_stream(), 0u64),
                move |(mut input, received)| async move {
                    match input.next().await {
                        Some(Ok(chunk)) if received + chunk.len() as u64 <= size => {
                            let n = received + chunk.len() as u64;
                            Ok(Some((chunk, (input, n))))
                        }
                        Some(_) => Err(std::io::Error::other("File download could not complete")),
                        None if received == size => Ok(None),
                        None => Err(std::io::Error::other("File download could not complete")),
                    }
                },
            );
            let mut response = axum::body::Body::from_stream(stream).into_response();
            response.headers_mut().insert(
                "Content-Type",
                HeaderValue::from_static("application/octet-stream"),
            );
            response.headers_mut().insert(
                "Content-Length",
                HeaderValue::from_str(&size.to_string())
                    .map_err(|_| reject(502, "INVALID_PROVIDER_RESPONSE"))?,
            );
            let filename = percent_encoding::utf8_percent_encode(
                &filename,
                percent_encoding::NON_ALPHANUMERIC,
            )
            .to_string();
            response.headers_mut().insert(
                "Content-Disposition",
                HeaderValue::from_str(&format!("attachment; filename*=UTF-8''{filename}"))
                    .map_err(|_| reject(502, "INVALID_PROVIDER_RESPONSE"))?,
            );
            Ok(response)
        }
    }
}
