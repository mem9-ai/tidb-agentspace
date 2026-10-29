mod http_policy;
mod sso;
use anyhow::{Result, bail};
use axum::{
    Extension, Json, Router,
    body::to_bytes,
    extract::{ConnectInfo, Request, State},
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
    #[serde(default)]
    pub initialize_workspace: bool,
    pub metadata: MetaBinding,
    pub insecure_loopback: bool,
    #[serde(default)]
    pub public_origins: Vec<String>,
    #[serde(default)]
    pub public_path: String,
    #[serde(default)]
    pub sso: Option<sso::Config>,
    pub console_origins: Vec<String>,
    pub recover_writer_owner: Option<String>,
    #[serde(default)]
    pub product: Option<workspace_product::Config>,
}
impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let mut result: Self = serde_json::from_slice(&private_file(path)?)
            .map_err(|_| anyhow::anyhow!("Invalid private Workspace configuration"))?;
        if result.sso.is_none() {
            result.sso = sso::Config::environment()?;
        }
        if let Ok(path) = std::env::var("WORKSPACE_PUBLIC_PATH") {
            result.public_path = path;
        }
        for name in ["TIDB_PUBLIC_ORIGIN", "WORKSPACE_TRUSTED_ORIGINS"] {
            if let Ok(value) = std::env::var(name) {
                result.public_origins.extend(
                    value
                        .split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned),
                );
            }
        }
        result.validate()?;
        Ok(result)
    }
    pub fn validate(&self) -> Result<()> {
        let result = self;
        if (result.insecure_loopback && !result.bind.ip().is_loopback())
            || !result.bind.is_ipv4()
            || result.workspace_id.is_empty()
            || !result.authority_id.starts_with("region:")
        {
            bail!("The Workspace API requires explicit IPv4 loopback and regional identity");
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
        http_policy::validate(self)?;
        if let Some(product) = &self.product {
            product.validate()?;
        }
        Ok(())
    }
}
#[derive(Clone)]
struct Session {
    expires: Instant,
    credential: Credential,
}
#[derive(Clone)]
struct App {
    workspace: Arc<Workspace>,
    product: Option<Arc<workspace_product::Product>>,
    config: Config,
    sessions: Arc<Mutex<BTreeMap<String, Session>>>,
    sso: Option<Arc<sso::Runtime>>,
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
            config.initialize_workspace,
            config.recover_writer_owner.as_deref(),
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
        let sso = config
            .sso
            .clone()
            .map(sso::Runtime::new)
            .transpose()?
            .map(Arc::new);
        Ok(Self {
            workspace: workspace.clone(),
            listener,
            app: App {
                workspace,
                product,
                config,
                sso,
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
        axum::serve(
            self.listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(stop)
        .await?;
        Ok(())
    }
}
fn error(error: ServiceError) -> Response {
    let message = match error.code.as_str() {
        "UNAUTHENTICATED" => "Sign in or provide a scoped Workspace Key.",
        "INVALID_KEY" => "API key is invalid, expired, or revoked.",
        "OWNER_REQUIRED" => "This action requires the workspace owner session.",
        "SSO_REQUIRED" => "Sign in with your TiDB Account.",
        "SSO_NOT_AUTHORIZED" => "This account is not authorized for this workspace.",
        "SSO_VERIFICATION_FAILED" => "Could not verify the TiDB Account sign-in.",
        "SSO_STATE_INVALID" | "SSO_STATE_MISMATCH" => "Start TiDB Account sign-in again.",
        "SSO_UNAVAILABLE" => "TiDB Account sign-in is unavailable.",
        "SSO_RATE_LIMITED" => "Too many sign-in attempts. Try again shortly.",
        "NOT_FOUND" => "Workspace or endpoint not found.",
        "INVALID_IMPORT" => "Choose a database, a CSV/Parquet source and explicit parsing options.",
        "IMPORT_TARGET_MISMATCH" => {
            "This review belongs to a different database. Parse and review again."
        }
        "IMPORT_PREPARATION_UNAVAILABLE" => {
            "This review expired or is unavailable. Parse and review again."
        }
        "IMPORT_ALREADY_COMMITTED" => {
            "This review already started a write. Inspect its destination before importing again."
        }
        "INVALID_IMPORT_FIELDS" => {
            "Check selected fields, unique column names and compatible data types before creating a table."
        }
        "SQL_TABLE_EXISTS" | "EXPORT_TARGET_EXISTS" => {
            "A table with this name already exists. Choose a new table name; existing data was not replaced."
        }
        "EXPORT_INCOMPLETE" => {
            "The table was created but its data write was not confirmed. Inspect the table before repeating an import."
        }
        "EXPORT_RECORD_FAILED" => {
            "The data write may have completed, but its activity record was not confirmed. Inspect the destination before repeating it."
        }
        "FILE_CHANGED" => "The source file changed after review. Parse and review again.",
        "ANALYSIS_FAILED" => {
            "This file could not be parsed or analyzed. Check its format and parsing options, or choose another file."
        }
        "ANALYSIS_OUTPUT_LIMIT" => {
            "The parsed data exceeds the row, column or result-size limit. Reduce the input before importing."
        }
        "FILE_TOO_LARGE" | "ANALYSIS_INPUT_LIMIT" => {
            "The file exceeds the current size limit. Choose a smaller file."
        }
        "EXPORT_TOO_LARGE" => {
            "The reviewed data exceeds the current import/export limit. Reduce the input before trying again."
        }
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
    let origin = headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let policy_result = http_policy::allowed(&app.config, headers, request.method());
    let allowed = policy_result.is_ok();
    let mut response = if let Err(e) = policy_result {
        error(e)
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
    let path = request
        .uri()
        .path()
        .strip_prefix(&format!("{}/", app.config.public_path))
        .map(|p| format!("/{p}"))
        .unwrap_or_else(|| request.uri().path().to_owned());
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
    if path.starts_with("/api/auth/") {
        return Ok(auth_route(
            &app,
            &path,
            &method,
            &headers,
            &query,
            request
                .extensions()
                .get::<ConnectInfo<SocketAddr>>()
                .map(|v| v.0),
        )
        .await);
    }
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
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|v| v.0.ip());
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
    .map_err(|_| {
        reject(
            413,
            if path.ends_with("/database-imports/prepare-upload") {
                "FILE_TOO_LARGE"
            } else {
                "BODY_TOO_LARGE"
            },
        )
    })?;
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
        if app.sso.is_some() {
            return Err(reject(403, "SSO_REQUIRED"));
        }
        if !app.config.insecure_loopback || !peer.is_some_and(|ip| ip.is_loopback()) {
            return Err(reject(403, "LOCAL_ONLY"));
        }
        app.workspace.health().await?;
        let token = secret(32)?;
        let now = Instant::now();
        let mut sessions = app.sessions.lock().await;
        sessions.retain(|_, session| session.expires > now);
        if sessions.len() >= 4096 {
            return Err(reject(429, "SESSION_BUSY"));
        }
        sessions.insert(
            token.clone(),
            Session {
                expires: now + Duration::from_secs(28800),
                credential: Credential::SessionOwner {
                    id: "local-owner".into(),
                    actor: "You".into(),
                    expires_at: chrono::Utc::now().timestamp() + 28800,
                },
            },
        );
        let mut response =
            Json(json!({"workspaceId":app.config.workspace_id,"mode":"demo"})).into_response();
        response.headers_mut().insert(
            "Set-Cookie",
            HeaderValue::from_str(&format!(
                "aw_session={token}; HttpOnly; SameSite=Strict; Path={}/; Max-Age=28800",
                app.config.public_path
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
                    let raw_upload = (method == Method::PUT && route == "/files/content")
                        || (method == Method::POST && route == "/database-imports/prepare-upload");
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
                    let actor = cookie(&headers, "aw_session").unwrap_or_default();
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
        && let Some(session) = app.sessions.lock().await.get(token)
        && session.expires > Instant::now()
    {
        return Ok(session.credential.clone());
    }
    Err(reject(401, "UNAUTHENTICATED"))
}

async fn credential_for_response(
    app: &App,
    headers: &HeaderMap,
    input: &Credential,
) -> std::result::Result<(), ServiceError> {
    credential(app, headers).await?;
    app.workspace.authenticate(input).await?;
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

fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .map(str::trim)
        .find_map(|v| v.strip_prefix(&format!("{name}=")))
}
fn redirect(location: &str) -> Response {
    (StatusCode::FOUND, [("Location", location)]).into_response()
}
fn set_cookie(response: &mut Response, value: String) {
    if let Ok(value) = HeaderValue::from_str(&value) {
        response.headers_mut().append("Set-Cookie", value);
    }
}
async fn auth_route(
    app: &App,
    path: &str,
    method: &Method,
    headers: &HeaderMap,
    query: &BTreeMap<String, String>,
    peer: Option<SocketAddr>,
) -> Response {
    if path == "/api/auth/config" && *method == Method::GET {
        return Json(if app.sso.is_some(){json!({"enabled":true,"provider":"tidbcloud","label":"Continue with TiDB Account","loginPath":"/api/auth/tidbcloud/login","logoutPath":"/api/auth/tidbcloud/logout"})}else{json!({"enabled":false})}).into_response();
    }
    let secure = if app.config.sso.as_ref().is_some_and(|c| c.secure()) {
        " Secure;"
    } else {
        ""
    };
    let session_cookie = |token: &str, age: u32| {
        format!(
            "aw_session={token}; HttpOnly; SameSite=Strict;{secure} Path={}/; Max-Age={age}",
            app.config.public_path
        )
    };
    if path == "/api/auth/tidbcloud/logout" && [Method::GET, Method::POST].contains(method) {
        if let Some(token) = cookie(headers, "aw_session") {
            app.sessions.lock().await.remove(token);
        }
        let mut response = if *method == Method::GET && app.sso.is_some() {
            redirect(
                &app.config
                    .sso
                    .as_ref()
                    .expect("configured")
                    .post_login(&app.config.public_path),
            )
        } else {
            Json(json!({"loggedOut":true})).into_response()
        };
        set_cookie(&mut response, session_cookie("", 0));
        return response;
    }
    let Some(sso) = &app.sso else {
        return error(reject(404, "SSO_NOT_CONFIGURED"));
    };
    let flow_cookie = |token: &str, age: u32| {
        format!(
            "aw_sso_flow={token}; HttpOnly; SameSite=Lax;{secure} Path={}/api/auth/tidbcloud; Max-Age={age}",
            app.config.public_path
        )
    };
    if path == "/api/auth/tidbcloud/login" && *method == Method::GET {
        // Forwarded/Host headers never establish the source address for throttling.
        let source = peer
            .map(|p| p.ip().to_string())
            .unwrap_or_else(|| "unknown".into());
        return match sso.login(&source).await {
            Ok((url, flow)) => {
                let mut r = redirect(&url);
                set_cookie(&mut r, flow_cookie(&flow, 600));
                r
            }
            Err(e) => error(e),
        };
    }
    if path == "/api/auth/tidbcloud/callback" && *method == Method::GET {
        let result = sso
            .callback(cookie(headers, "aw_sso_flow").unwrap_or_default(), query)
            .await;
        let mut response = match result {
            Err(e) => error(e),
            Ok(credential) => {
                let now = Instant::now();
                let mut sessions = app.sessions.lock().await;
                sessions.retain(|_, s| s.expires > now);
                if let Some(old) = cookie(headers, "aw_session") {
                    sessions.remove(old);
                }
                if sessions.len() >= 4096 {
                    error(reject(429, "SESSION_BUSY"))
                } else {
                    match secret(32) {
                        Err(e) => error(e),
                        Ok(token) => {
                            sessions.insert(
                                token.clone(),
                                Session {
                                    expires: now + Duration::from_secs(28800),
                                    credential,
                                },
                            );
                            let mut r = redirect(&sso.config.post_login(&app.config.public_path));
                            set_cookie(&mut r, session_cookie(&token, 28800));
                            r
                        }
                    }
                }
            }
        };
        set_cookie(&mut response, flow_cookie("", 0));
        return response;
    }
    error(reject(404, "NOT_FOUND"))
}
