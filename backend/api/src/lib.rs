pub mod access_signer;
pub mod analytics;
pub mod global_api;
mod global_local_sessions;
pub mod global_login;
pub mod guest_cleanup;
pub mod guest_entry;
pub mod history_audit;
pub mod history_maintenance;
pub mod history_query;
pub mod history_queue;
pub mod history_request;
mod http_policy;
pub mod managed_workspaces;
pub mod policy_command;
pub mod policy_transport;
pub mod portal_ticket;
pub mod region_connection;
pub mod region_security;
pub mod regional_account;
pub mod regional_guest;
mod security_clock;
pub mod signed_access;
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
pub struct GuestConfig {
    pub global_authority_id: String,
    pub workspace_limit: usize,
}

#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlobalEntry {
    pub api_origin: String,
    pub api_path_prefix: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub analytics: Option<analytics::Settings>,
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
    #[serde(default)]
    pub guest: Option<GuestConfig>,
    #[serde(default)]
    pub security: Option<region_security::Config>,
    #[serde(default)]
    pub managed_workspace_limit: Option<usize>,
    pub global_entry: Option<GlobalEntry>,
}
fn guest_environment(value: &str) -> Result<Option<GuestConfig>> {
    match value {
        "true" => Ok(Some(GuestConfig {
            global_authority_id: "global".into(),
            workspace_limit: 128,
        })),
        "false" => Ok(None),
        _ => bail!("WORKSPACE_GUEST_ENABLED must be true or false"),
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let mut result: Self = serde_json::from_slice(&private_file(path)?)
            .map_err(|_| anyhow::anyhow!("Invalid private Workspace configuration"))?;
        if result.sso.is_none() && result.security.is_none() {
            result.sso = sso::Config::environment()?;
        }
        if let Ok(value) = std::env::var("WORKSPACE_GUEST_ENABLED") {
            result.guest = guest_environment(&value)?;
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
        if let Some(settings) = &self.analytics {
            settings.service.validate(self.insecure_loopback)?;
            anyhow::ensure!(
                self.security
                    .as_ref()
                    .is_none_or(|s| s.regional_signing_key_file != settings.service.token_file),
                "Dedicated analytics producer token required"
            );
        }
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
        if let Some(guest) = &self.guest
            && (guest.global_authority_id != "global"
                || guest.workspace_limit == 0
                || guest.workspace_limit > 4096
                || !matches!(&self.metadata, MetaBinding::InProcess { .. })
                || self.sso.is_none()
                || self.public_origins.is_empty())
        {
            bail!(
                "Guest requires explicit co-located Global/Region authorities, SSO and trusted public origins"
            );
        }
        if let Some(global) = &self.global_entry {
            let origin = sso::endpoint(&global.api_origin, self.bind.ip().is_loopback())?;
            anyhow::ensure!(
                origin.origin().ascii_serialization() == global.api_origin
                    && (global.api_path_prefix.is_empty()
                        || global.api_path_prefix.starts_with('/')
                            && global
                                .api_path_prefix
                                .split('/')
                                .skip(1)
                                .all(|p| !p.is_empty()
                                    && p.bytes()
                                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)))),
                "Invalid Global entry"
            );
            if let Some(security) = &self.security {
                anyhow::ensure!(
                    security.global_issuer
                        == format!("{}{}", global.api_origin, global.api_path_prefix),
                    "Global entry must match the pinned issuer"
                );
            }
        }
        http_policy::validate(self)?;
        if let Some(product) = &self.product {
            product.validate()?;
        }
        anyhow::ensure!(
            self.managed_workspace_limit
                .is_none_or(|limit| self.security.is_some() && (1..=4096).contains(&limit)),
            "Managed Token hosts require a bounded pool and security configuration"
        );
        if let Some(security) = &self.security {
            anyhow::ensure!(
                security.control.bind != self.bind,
                "Control and public API listeners must differ"
            );
            anyhow::ensure!(
                self.public_origins.contains(&security.public_origin)
                    || self.insecure_loopback
                        && security.public_origin == format!("http://{}", self.bind),
                "Region security origin must match the trusted public API"
            );
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
    analytics: Option<analytics::Client>,
    workspace: Arc<Workspace>,
    product: Option<Arc<workspace_product::Product>>,
    config: Config,
    sessions: Arc<Mutex<BTreeMap<String, Session>>>,
    sso: Option<Arc<sso::Runtime>>,
    capacity: Arc<Semaphore>,
    guest_runtime: Option<Arc<GuestRuntime>>,
    current_guest: Option<regional_guest::AuthorizedGuest>,
    current_account: Option<regional_account::AuthorizedAccount>,
    security: Option<Arc<region_security::Runtime>>,
    token_credential: Option<Credential>,
    portal_sessions: Option<global_api::PortalSessions>,
    history_queue: history_queue::HistoryQueue,
}

/// Explicit co-located integration. Separate services require authenticated control transport;
/// hosted rollout also requires independent account routing and crash recovery.
pub struct GuestRuntime {
    pub guest_enabled: bool,
    pub entry: Arc<guest_entry::GuestEntry>,
    pub region: Arc<regional_guest::RegionalGuest>,
    pub account: Arc<regional_account::RegionalAccount>,
    pub account_onboarding: Option<Arc<global_login::GlobalGuest>>,
    pub workspaces: Arc<managed_workspaces::ManagedWorkspaces>,
    pub cleanup: Arc<workspace_identity::cleanup::Queue>,
    pub cleanup_processor: Arc<guest_cleanup::GuestCleanup>,
    pub cleanup_slots: Arc<Semaphore>,
}
pub struct WorkspaceServer {
    global_mount: Option<(String, Router, Router)>,
    global_reconciler: Option<global_api::RegionReconciler>,
    pub workspace: Arc<Workspace>,
    listener: TcpListener,
    app: App,
    history_worker: history_queue::HistoryQueueWorker,
}
impl WorkspaceServer {
    /// Create the internal Region history worker using the same authenticated metadata
    /// connection and managed Workspace registry as this listener.
    pub fn history_scheduler(
        &self,
        metadata: Arc<dyn Metadata>,
    ) -> Result<workspace_domain::observability::HistoryScheduler> {
        use workspace_domain::observability::{HistoryMaintenance, HistoryScheduler};
        let queue = HistoryMaintenance::new(metadata, &self.app.config.authority_id)?;
        let managed = self
            .app
            .guest_runtime
            .as_ref()
            .map(|runtime| runtime.workspaces.clone());
        let processor = history_maintenance::HistoryProcessor::new(self.workspace.clone(), managed);
        Ok(HistoryScheduler::new(queue, Arc::new(processor)))
    }

    pub async fn open(config: Config, metadata: Arc<dyn Metadata>) -> Result<Self> {
        Self::open_with_guest(config, metadata, None).await
    }

    pub async fn open_with_guest(
        mut config: Config,
        metadata: Arc<dyn Metadata>,
        guest_runtime: Option<Arc<GuestRuntime>>,
    ) -> Result<Self> {
        config.validate()?;
        anyhow::ensure!(
            config.managed_workspace_limit.is_none() || guest_runtime.is_some(),
            "Managed Token configuration requires its regional Workspace registry"
        );
        if guest_runtime
            .as_ref()
            .is_some_and(|runtime| config.security.is_none() || runtime.guest_enabled)
            && (config.sso.is_none()
                || (!config.insecure_loopback
                    && (!matches!(&config.metadata, MetaBinding::InProcess { .. })
                        || config.public_origins.is_empty())))
        {
            bail!("Guest requires an explicitly configured trusted host");
        }
        let listener = TcpListener::bind(config.bind).await?;
        // Managed hosts no longer open the historical shared customer Workspace. The
        // health sentinel is internal and never selected by an authenticated API request.
        if guest_runtime.is_some() {
            config.workspace_id = "system-host-health".into();
            config.initialize_workspace = true;
            config.recover_writer_owner = None;
        }
        let analytics = config
            .analytics
            .as_ref()
            .filter(|c| c.enabled)
            .and_then(|c| {
                analytics::Client::new(&c.service, &config.authority_id)
                    .map_err(|_| {
                        eprintln!("Analytics producer unavailable; product serving continues.")
                    })
                    .ok()
            });
        let metadata_port_for_security = metadata.clone();
        let repository = Repository::open(
            metadata,
            &config.authority_id,
            &config.workspace_id,
            config.initialize_workspace,
            config.recover_writer_owner.as_deref(),
        )
        .await?;
        if let Err(error) = repository.discard_regional_keys().await {
            let _ = repository.close().await;
            return Err(error.into());
        }
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
        let security = if let Some(settings) = config.security.clone() {
            Some(
                region_security::Runtime::open(
                    settings,
                    if guest_runtime.is_some() {
                        None
                    } else {
                        Some(config.workspace_id.clone())
                    },
                    metadata_port_for_security,
                    &config.authority_id,
                    &config.public_path,
                    config.insecure_loopback,
                )
                .await?,
            )
        } else {
            None
        };
        let sso = config
            .sso
            .clone()
            .map(sso::Runtime::new)
            .transpose()?
            .map(Arc::new);
        let history_processor = Arc::new(history_maintenance::HistoryProcessor::new(
            workspace.clone(),
            guest_runtime
                .as_ref()
                .map(|runtime| runtime.workspaces.clone()),
        ));
        let (history_queue, history_worker) = history_queue::HistoryQueue::new(
            256,
            1024,
            64,
            history_processor,
            Duration::from_secs(1),
        )
        .expect("bounded history queue configuration");
        Ok(Self {
            global_mount: None,
            global_reconciler: None,
            workspace: workspace.clone(),
            listener,
            history_worker,
            app: App {
                analytics,
                workspace,
                product,
                config,
                sso,
                sessions: Arc::new(Mutex::new(BTreeMap::new())),
                capacity: Arc::new(Semaphore::new(8)),
                guest_runtime,
                current_guest: None,
                current_account: None,
                security,
                token_credential: None,
                portal_sessions: None,
                history_queue,
            },
        })
    }
    pub fn with_global(mut self, mut global: global_api::GlobalServer) -> Self {
        global = global
            .with_shared_region_origins(self.app.config.bind, &self.app.config.public_origins);
        if let Some(runtime) = &self.app.guest_runtime
            && runtime.guest_enabled
        {
            global = global.with_colocated_guests(
                &self.app.config.authority_id,
                runtime.region.clone(),
                self.app.config.bind,
                &self.app.config.public_origins,
            );
        }
        if self.app.sso.is_some() && self.app.guest_runtime.is_some() {
            self.app.portal_sessions = global.portal_sessions(&self.app.config.public_path);
        }
        self.app.config.global_entry = Some(GlobalEntry {
            api_origin: global.origin().into(),
            api_path_prefix: global.mount_path().into(),
        });
        self.global_reconciler = global.reconciler();
        self.global_mount = Some((
            global.mount_path().into(),
            global.router(),
            global.agent_entry_router(&self.app.config.public_path),
        ));
        self
    }
    pub async fn serve(
        self,
        stop: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> Result<()> {
        let (history_stop, history_receiver) = tokio::sync::watch::channel(false);
        let history_task = tokio::spawn(self.history_worker.run(history_receiver));
        let mut connection = self
            .app
            .security
            .as_ref()
            .and_then(|r| r.region_connection());
        if let Some(connection) = &mut connection {
            connection.analytics = self.app.analytics.clone();
        }
        let control = self
            .app
            .security
            .as_ref()
            .filter(|_| connection.is_none())
            .map(|r| r.control())
            .transpose()?;
        let gateway_prefix = self.app.config.public_path.clone();
        let router = Router::new()
            .fallback(any(handle))
            .layer(middleware::from_fn_with_state(self.app.clone(), policy))
            .with_state(self.app);
        let router = if let Some((path, global, entry)) = self.global_mount {
            // Gateways may preserve the public path or remove the Region prefix. Both
            // mounts share the same Global authority, public issuer and cookie paths.
            let router = router.merge(entry);
            let router = router.nest_service(&path, global.clone());
            match path.strip_prefix(&gateway_prefix) {
                Some(relative)
                    if relative.starts_with('/') && relative != path && relative != "/" =>
                {
                    router.nest_service(relative, global)
                }
                _ => router,
            }
        } else {
            router
        };
        let cancellation = tokio_util::sync::CancellationToken::new();
        let stop_signal = cancellation.clone();
        tokio::spawn(async move {
            stop.await;
            stop_signal.cancel();
        });
        let control_stop = cancellation.clone();
        let task = control.map(|server| {
            tokio::spawn(async move { server.serve(control_stop.cancelled_owned()).await })
        });
        let connection_stop = cancellation.clone();
        let connection_task = connection.map(|connection| {
            tokio::spawn(async move {
                crate::region_connection::connect(
                    connection.config,
                    connection.descriptor,
                    connection.installer,
                    connection.initializer,
                    connection.analytics,
                    connection_stop,
                )
                .await
            })
        });
        let reconcile_task = self
            .global_reconciler
            .map(|reconciler| tokio::spawn(reconciler.run(cancellation.clone())));
        let result = axum::serve(
            self.listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(cancellation.clone().cancelled_owned())
        .await;
        cancellation.cancel();
        let _ = history_stop.send(true);
        let _ = history_task.await;
        if let Some(task) = task {
            task.await??;
        }
        if let Some(task) = connection_task {
            task.await??;
        }
        if let Some(task) = reconcile_task {
            task.await?;
        }
        result?;
        Ok(())
    }
}
fn error(error: ServiceError) -> Response {
    let message = match error.code.as_str() {
        "UNAUTHENTICATED" => "Sign in or provide a scoped Region access Token.",
        "EXCHANGE_KEY_AT_GLOBAL" => {
            "Exchange your Workspace Key at Global for a Region Token. Raw Keys cannot access Region data."
        }
        "REGION_POLICY_NOT_APPLIED" => {
            "The Region has not confirmed this Key's permissions. Inspect the Key status before requesting a Region Token again."
        }
        "CLIENT_BINDING_REQUIRED" | "CLIENT_PROOF_REQUIRED" => {
            "Provide the enrolled client's public-key binding and request proof."
        }
        "REFRESH_OUTCOME_UNKNOWN" | "ISSUANCE_OUTCOME_UNKNOWN" => {
            "Credential issuance may have completed. Inspect its status or reauthenticate; do not repeat the request automatically."
        }
        "CLOCK_ROLLBACK"
        | "TRUSTED_CLOCK_UNAVAILABLE"
        | "POLICY_ROLLBACK"
        | "POLICY_CHECKPOINT_UNAVAILABLE" => {
            "The regional security checkpoint needs operator recovery."
        }
        "INVALID_KEY" => "API key is invalid, expired, or revoked.",
        "OWNER_REQUIRED" => "This action requires the workspace owner session.",
        "AUDIT_UNAVAILABLE" => {
            "Audit history is unavailable. This action did not start; try again when history is available."
        }
        "SSO_REQUIRED" => "Sign in with your TiDB Account.",
        "SSO_NOT_AUTHORIZED" => "This account is not authorized for this workspace.",
        "SSO_VERIFICATION_FAILED" => "Could not verify the TiDB Account sign-in.",
        "SSO_STATE_INVALID" | "SSO_STATE_MISMATCH" => "Start TiDB Account sign-in again.",
        "SSO_UNAVAILABLE" => "TiDB Account sign-in is unavailable.",
        "SSO_RATE_LIMITED" => "Too many sign-in attempts. Try again shortly.",
        "RESOURCE_INDEX_MIGRATING" => {
            "Workspace resources are being indexed. No resource was created; try again shortly."
        }
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
        "PRECONDITION_FAILED" => {
            "The file changed or is missing. Read its metadata again and review the new version before updating."
        }
        "INVALID_PRECONDITION" => {
            "Send one strong If-Match version or If-None-Match: *, never both."
        }
        "FILE_VERSION_UNAVAILABLE" => {
            "This provider did not return an atomic revision. Conditional updates are unavailable; no write was sent."
        }
        "READ_ONLY_SQL_REQUIRED" => {
            "Use the supported read-only SELECT/CTE/VALUES subset. Writes, locks, unknown functions and session commands require a different operation or explicit write permission."
        }
        "RESOURCE_DELETING" => {
            "Resource removal has started. Inspect its resource detail and deletion phase; do not retry data operations."
        }
        "RESOURCE_DELETE_UNSUPPORTED" => {
            "This provider does not support resource deletion through this API. The resource and credentials are unchanged."
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
    let unsupported_deletion = error.code == "RESOURCE_DELETE_UNSUPPORTED";
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
    if unsupported_deletion {
        response
            .headers_mut()
            .insert("Allow", HeaderValue::from_static("GET"));
    }
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
    let bearer_request = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("Bearer "));
    let raw_path = request.uri().path();
    let path = raw_path
        .strip_prefix(&app.config.public_path)
        .unwrap_or(raw_path);
    // Existing Pod probes use a loopback Host. Only the actual local peer's read-only
    // health route gets this exception; forwarding headers and data routes never do.
    let local_readiness = request.method() == Method::GET
        && path == "/api/health"
        && request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .is_some_and(|p| p.0.ip().is_loopback());
    let mut policy_result =
        http_policy::allowed(&app.config, headers, request.method(), local_readiness);
    if app.security.is_some()
        && [
            "authorization",
            "origin",
            "host",
            "cookie",
            "content-type",
            "dpop",
        ]
        .iter()
        .any(|name| headers.get_all(*name).iter().count() > 1)
    {
        policy_result = Err(reject(400, "DUPLICATE_HEADER"));
    }
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
                        "if-match",
                    ]
                    .contains(&v.as_str())
                        && !(v == "dpop" && app.security.is_some())
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
                HeaderValue::from_static(if app.security.is_some() {
                    "content-type, authorization, idempotency-key, if-none-match, if-match, dpop"
                } else {
                    "content-type, authorization, idempotency-key, if-none-match, if-match"
                }),
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
    if app.security.is_some() && response.status() == StatusCode::UNAUTHORIZED && bearer_request {
        response
            .headers_mut()
            .insert("WWW-Authenticate", HeaderValue::from_static("Bearer"));
    }
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
            HeaderValue::from_static("X-Request-Id, ETag, Location"),
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
    let request_id = uuid::Uuid::new_v4();
    let started_at = chrono::Utc::now();
    let started = Instant::now();
    let result = tokio::spawn(async move {
        let _permit = permit;
        dispatch(app, request, cancellation, request_id, started_at, started).await
    })
    .await;
    let mut response = match result {
        Ok(Ok(response)) => response,
        Ok(Err(e)) => error(e),
        Err(_) => error(reject(503, "API_UNAVAILABLE")),
    };
    response.headers_mut().insert(
        "X-Request-Id",
        HeaderValue::from_str(&request_id.to_string()).expect("UUID header"),
    );
    response
}
async fn dispatch(
    mut app: App,
    request: Request,
    cancellation: tokio_util::sync::CancellationToken,
    request_id: uuid::Uuid,
    started_at: chrono::DateTime<chrono::Utc>,
    started: Instant,
) -> std::result::Result<Response, ServiceError> {
    let mut path = request
        .uri()
        .path()
        .strip_prefix(&format!("{}/", app.config.public_path))
        .map(|p| format!("/{p}"))
        .unwrap_or_else(|| request.uri().path().to_owned());
    let method = request.method().clone();
    let headers = request.headers().clone();
    let portal_request = path.starts_with("/api/portal/v1/");
    // The browser-facing interface has its own authentication boundary. The actual
    // domain operation is shared with the Agent API, not reimplemented in the Portal.
    if let Some(tail) = path.strip_prefix("/api/portal/v1/") {
        if headers.contains_key("authorization") {
            return Err(reject(401, "PORTAL_SESSION_REQUIRED"));
        }
        path = format!("/api/v1/{tail}");
    } else if path == "/api/portal/v1/workspaces" {
        if headers.contains_key("authorization") {
            return Err(reject(401, "PORTAL_SESSION_REQUIRED"));
        }
        path = "/api/v1/workspaces".into();
    }
    if path == "/openapi.json" && method == Method::GET && app.product.is_some() {
        return Ok((
            [("Content-Type", "application/json")],
            include_str!("../../../public/openapi.json"),
        )
            .into_response());
    }
    if path == "/owner-openapi.json" && method == Method::GET && app.product.is_some() {
        return Ok((
            [("Content-Type", "application/json")],
            include_str!("../../../public/owner-openapi.json"),
        )
            .into_response());
    }
    let history_request = method == Method::GET
        && path
            .strip_prefix("/api/v1/workspaces/")
            .and_then(|tail| tail.split_once('/'))
            .is_some_and(|(_, route)| matches!(route, "audit-history" | "request-history"));
    let mut query = BTreeMap::new();
    let mut duplicate_history_query = false;
    for (name, value) in reqwest::Url::parse(&format!("http://localhost{}", request.uri()))
        .map_err(|_| reject(400, "INVALID_PATH"))?
        .query_pairs()
        .into_owned()
    {
        duplicate_history_query |= query.insert(name, value).is_some() && history_request;
    }
    if path == "/api/portal/auth/session-exchanges" && method == Method::POST {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Exchange {
            ticket: String,
        }
        let origin = headers
            .get("origin")
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| reject(403, "ORIGIN_DENIED"))?;
        if !app
            .config
            .public_origins
            .iter()
            .chain(&app.config.console_origins)
            .any(|allowed| allowed == origin)
        {
            return Err(reject(403, "ORIGIN_DENIED"));
        }
        if headers.contains_key("authorization") {
            return Err(reject(401, "PORTAL_SESSION_REQUIRED"));
        }
        let security = app
            .security
            .as_ref()
            .ok_or_else(|| reject(404, "NOT_FOUND"))?;
        let runtime = app
            .guest_runtime
            .as_ref()
            .ok_or_else(|| reject(404, "NOT_FOUND"))?;
        let bytes = tokio::time::timeout(
            Duration::from_secs(10),
            to_bytes(request.into_body(), 16 * 1024),
        )
        .await
        .map_err(|_| reject(408, "BODY_TIMEOUT"))?
        .map_err(|_| reject(413, "BODY_TOO_LARGE"))?;
        let input: Exchange =
            serde_json::from_slice(&bytes).map_err(|_| reject(400, "INVALID_REQUEST"))?;
        let claims = security.consume_portal_ticket(&input.ticket).await?;
        let cookie = runtime
            .account
            .establish(
                &claims.workspace_id,
                &claims.identity_issuer,
                &claims.identity_subject,
            )
            .await?;
        let mut response = Json(json!({"workspaceId":claims.workspace_id})).into_response();
        response.headers_mut().append("Set-Cookie", cookie);
        response
            .headers_mut()
            .insert("Cache-Control", HeaderValue::from_static("no-store"));
        return Ok(response);
    }
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
    if let Some(security) = &app.security
        && let Some((workspace, tail)) = path
            .strip_prefix("/api/v1/workspaces/")
            .and_then(|v| v.split_once('/'))
        && matches!(
            tail.split('/').next(),
            Some("refresh-families" | "token-issuances" | "access-tokens")
        )
    {
        let bytes = tokio::time::timeout(
            Duration::from_secs(10),
            to_bytes(request.into_body(), 16 * 1024),
        )
        .await
        .map_err(|_| reject(408, "BODY_TIMEOUT"))?
        .map_err(|_| reject(413, "BODY_TOO_LARGE"))?;
        return security
            .route(workspace, &format!("/{tail}"), &method, &headers, &bytes)
            .await?
            .ok_or_else(|| reject(404, "NOT_FOUND"));
    }
    if !portal_request
        && (path == "/api/v1/workspaces" || path.starts_with("/api/v1/workspaces/"))
        && !headers.contains_key("authorization")
        && !history_request
    {
        return Err(reject(401, "AGENT_TOKEN_REQUIRED"));
    }
    // An authenticated regional cookie selects exactly one managed Workspace.
    // A valid TiDB Account session takes precedence when both cookies exist.
    let legacy_account_session = if let Some(token) = cookie(&headers, "aw_session") {
        app.sessions
            .lock()
            .await
            .get(token)
            .is_some_and(|session| session.expires > Instant::now())
    } else {
        false
    };
    let regional_account = if path != "/api/health"
        && path != "/api/session"
        && !headers.contains_key("authorization")
        && let Some(runtime) = &app.guest_runtime
        && regional_account::RegionalAccount::has_cookie(&headers)
    {
        match runtime.account.authenticate(&headers).await {
            Ok(account) => Some(account),
            Err(e) if e.status == 401 || e.code == "POLICY_DENIED" => None,
            Err(e) => return Err(e),
        }
    } else {
        None
    };
    let listed_workspace = if path == "/api/v1/workspaces"
        && app.guest_runtime.is_some()
        && let Some(security) = &app.security
        && let Some(token) = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .filter(|v| v.split('.').count() == 3)
    {
        Some(security.workspace_for_token(token).await?)
    } else {
        None
    };
    let guest_lease = if path != "/api/health" && path != "/api/session" {
        if let Some(runtime) = &app.guest_runtime
            && let Some(account) = regional_account
        {
            let permitted = format!("/api/v1/workspaces/{}", account.workspace_id);
            if path != "/api/v1/workspaces"
                && path != permitted
                && !path.starts_with(&(permitted + "/"))
            {
                return Err(reject(404, "NOT_FOUND"));
            }
            let lease = runtime
                .workspaces
                .acquire(&account.workspace_id, &account.credential)
                .await?;
            app.workspace = lease.workspace();
            app.product = lease.product();
            app.config.workspace_id = account.workspace_id.clone();
            app.current_account = Some(account);
            Some(lease)
        } else if let Some(runtime) = &app.guest_runtime
            && !legacy_account_session
            && !headers.contains_key("authorization")
            && regional_guest::RegionalGuest::has_cookie(&headers)
        {
            let guest = runtime.region.authenticate(&headers).await?;
            let permitted = format!("/api/v1/workspaces/{}", guest.workspace_id);
            if path != "/api/v1/workspaces"
                && path != permitted
                && !path.starts_with(&(permitted + "/"))
            {
                return Err(reject(404, "NOT_FOUND"));
            }
            let lease = runtime
                .workspaces
                .acquire(&guest.workspace_id, &guest.credential)
                .await?;
            app.workspace = lease.workspace();
            app.product = lease.product();
            app.config.workspace_id = guest.workspace_id.clone();
            app.current_guest = Some(guest);
            Some(lease)
        } else if let Some(runtime) = &app.guest_runtime
            && headers.contains_key("authorization")
            && let Some(workspace_id) = path
                .strip_prefix("/api/v1/workspaces/")
                .and_then(|tail| tail.split('/').next())
                .or(listed_workspace.as_deref())
            && uuid::Uuid::parse_str(workspace_id).is_ok_and(|id| id.to_string() == workspace_id)
        {
            // The URL selects only a candidate. The Key and Region policy must authenticate
            // before the pool returns a lease or any application operation is run.
            let token = headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "));
            let key = if let Some(security) = &app.security
                && let Some(token) = token.filter(|v| v.split('.').count() == 3)
            {
                let value = security.authenticate(workspace_id, token).await?;
                app.token_credential = Some(value.clone());
                value
            } else {
                credential(&app, &headers).await?
            };
            let lease = runtime.workspaces.acquire(workspace_id, &key).await?;
            app.workspace = lease.workspace();
            app.product = lease.product();
            app.config.workspace_id = workspace_id.to_owned();
            Some(lease)
        } else {
            None
        }
    } else {
        None
    };
    // Never expose the historical shared Workspace through an old session or Key on a
    // managed host, including when Global/Region onboarding is temporarily unavailable.
    if path != "/api/health"
        && path != "/api/session"
        && (app.guest_runtime.is_some() && guest_lease.is_none()
            || app.sso.is_some()
                && !app.config.insecure_loopback
                && app.guest_runtime.is_none()
                && app.security.is_none())
    {
        return Err(reject(401, "UNAUTHENTICATED"));
    }
    let prefix = format!("/api/v1/workspaces/{}", app.config.workspace_id);
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
            if path.ends_with("/file-exports") || path.ends_with("/file-export-preparations") {
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
        sessions.retain(|_, session| {
            if session.expires <= now {
                session.credential.revoke();
                false
            } else {
                true
            }
        });
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
                    workspace_id: app.config.workspace_id.clone(),
                    policy_generation: None,
                    expires_at: chrono::Utc::now().timestamp() + 28800,
                    revoked: Arc::new(std::sync::atomic::AtomicBool::new(false)),
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
    let route = path.strip_prefix(&prefix).unwrap_or_default();
    if let Some(security) = &app.security
        && let Some(mut response) = security
            .route(&app.config.workspace_id, route, &method, &headers, &bytes)
            .await?
    {
        response.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        );
        return Ok(response);
    }
    let credential = credential(&app, &headers).await?;
    if history_request {
        use workspace_domain::observability::HistoryStream;
        if !app.workspace.authenticate(&credential).await?.owner {
            return Err(reject(403, "OWNER_REQUIRED"));
        }
        if duplicate_history_query {
            return Err(reject(400, "INVALID_HISTORY_QUERY"));
        }
        let (stream, days) = match route {
            "/audit-history" => (HistoryStream::Audit, 30),
            "/request-history" => (HistoryStream::Requests, 7),
            _ => return Err(reject(404, "NOT_FOUND")),
        };
        let filter = history_query::HistoryQuery::parse(&query, stream)?;
        let page = app
            .workspace
            .owner_history_page(&credential, stream, filter.filter())
            .await?;
        credential_for_response(&app, &headers, &credential).await?;
        let diagnostic_health = if matches!(stream, HistoryStream::Requests) {
            app.history_queue.health(&app.config.workspace_id)
        } else {
            None
        };
        let health_status = match &diagnostic_health {
            Some(value) if value.degraded => "degraded",
            Some(_) => "unknown",
            None => "unavailable",
        };
        let loss_detected_at = diagnostic_health
            .and_then(|value| value.last_loss)
            .map(|value| value.to_rfc3339());
        let coverage = if matches!(stream, HistoryStream::Requests) {
            json!({"status":"partial", "startedAt":page["coverageStartedAt"], "operations":["workspace", "resources", "files", "query", "other"], "exclusions":["Global requests are not included", "Requests rejected before Workspace authentication or body parsing are not included", "Requests whose safe actor identity is unavailable are not included", "Requests rejected because audit intent could not be recorded are not included", "Diagnostic writes may be delayed or lost"]})
        } else {
            json!({"status":"partial", "startedAt":page["coverageStartedAt"], "operations":["workspace.update", "resource.create", "resource.delete", "resource.retry", "file.write", "file.delete", "query.execute", "database.import"], "exclusions":["Global Key activity is not included", "Some failures and access denials are recorded as unknown", "Resource creation and setup acknowledgements do not confirm provider outcomes", "Targets for denied or unresolved operations are not shown"]})
        };
        // The process-local queue cannot prove loss totals across a restart.
        let mut response = Json(json!({
            "data": page["data"],
            "nextCursor": page["nextCursor"],
            "coverage": coverage,
            "retention": {"maxAgeDays":days, "maxRecords":100000, "earliestAt":page["earliestAt"], "truncated":page["truncated"]},
            "health": {"status":health_status, "droppedCount":null, "lossDetectedAt":loss_detected_at}
        })).into_response();
        response
            .headers_mut()
            .insert("Cache-Control", HeaderValue::from_static("no-store"));
        return Ok(retain_guest_lease(response, guest_lease));
    }
    // Diagnostics are best-effort; inability to construct a safe identity must not
    // change the application operation or persist untrusted credential text.
    let actor = app.workspace.history_actor_snapshot(&credential).ok();
    let history = actor.as_ref().and_then(|actor| {
        history_request::HistoryRequest::start_at(
            actor.clone(),
            request_id,
            method.as_str(),
            route,
            started_at,
            started,
        )
    });
    let workspace_id = app.workspace.repository().workspace_id().to_owned();
    let mut parsed_for_audit = if matches!(
        (method.as_str(), route),
        (
            "POST",
            "/queries" | "/database-imports" | "/result-exports" | "/file-exports"
        ) | ("PUT", "/files")
    ) {
        Some(body())
    } else {
        None
    };
    let empty_audit_input = Value::Null;
    let audit_input = parsed_for_audit
        .as_ref()
        .and_then(|result| result.as_ref().ok())
        .unwrap_or(&empty_audit_input);
    let write_capable = match &credential {
        Credential::Scoped(authorization) => authorization
            .snapshot()
            .is_ok_and(|principal| principal.scope("queries:execute").is_ok()),
        Credential::SessionOwner { .. } | Credential::LocalDemoOwner => true,
        Credential::Bearer(_) => false,
    };
    let analytics_operation =
        if method == Method::PUT && route == "/files" && audit_input["purpose"] == "report" {
            Some("report_saved")
        } else {
            analytics::operation(method.as_str(), route)
        };
    let audit_action = if route == "/queries" && !write_capable {
        None
    } else {
        history_audit::action(method.as_str(), route, audit_input)
    };
    let target_candidate =
        history_audit::target_candidate(method.as_str(), route, &query, audit_input);
    let proven_scope_denial = audit_action.is_some_and(|action| {
        app.workspace
            .history_principal_snapshot(&credential)
            .is_ok_and(|principal| history_audit::scope_denied(action, &principal))
    });
    let audit_guard = if let Some(action) = audit_action {
        let actor = actor
            .as_ref()
            .ok_or_else(|| reject(503, "AUDIT_UNAVAILABLE"))?;
        let intent = workspace_domain::observability::AuditIntent {
            request_id: Some(request_id),
            actor_kind: actor.kind,
            actor_id: &actor.id,
            action,
            target_id: None,
        };
        Some(
            tokio::time::timeout(
                Duration::from_secs(5),
                workspace_domain::observability::AuditGuard::begin(
                    app.workspace.repository(),
                    intent,
                ),
            )
            .await
            .map_err(|_| reject(503, "AUDIT_UNAVAILABLE"))?
            .map_err(|_| reject(503, "AUDIT_UNAVAILABLE"))?,
        )
    } else {
        None
    };
    let result = async {
    let operation = if path == "/api/v1/workspaces" && method == Method::GET {
        Operation::ListWorkspaces
    } else {
        match (method.as_str(), route) {
            ("GET", "") if path == prefix => Operation::GetWorkspace,
            ("PATCH", "/settings") => Operation::UpdateSettings(body()?),
            ("GET", "/events") => Operation::ListEvents,
            _ => {
                if let Some(product) = &app.product {
                    let parts = route
                        .split('/')
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>();
                    let retired = matches!(
                        route,
                        "/database-imports/prepare"
                            | "/database-imports/prepare-upload"
                            | "/file-exports/prepare"
                    ) || matches!(
                        parts.as_slice(),
                        ["resources", _, "setup" | "table"] | ["resources", _, "table", "rows"]
                    ) || (method == Method::DELETE && route == "/files");
                    if retired {
                        app.workspace.authenticate(&credential).await?;
                        return Err(reject(404, "NOT_FOUND"));
                    }
                    let table_name = if method == Method::GET
                        && matches!(
                            parts.as_slice(),
                            ["resources", _, "tables", _] | ["resources", _, "tables", _, "rows"]
                        ) {
                        Some(decode_table_name(parts[3])?)
                    } else {
                        None
                    };
                    let binary_upload = method == Method::POST
                        && route == "/database-import-preparations"
                        && headers.get("content-type").and_then(|v| v.to_str().ok())
                            == Some("application/octet-stream");
                    let raw_upload =
                        (method == Method::PUT && route == "/files/content") || binary_upload;
                    let input = if raw_upload {
                        if headers.get("content-type").and_then(|v| v.to_str().ok())
                            != Some("application/octet-stream")
                        {
                            return Err(reject(415, "BINARY_REQUIRED"));
                        }
                        json!({})
                    } else if (method == Method::DELETE
                        && (route.starts_with("/resources/")
                            || route == "/files/entry"
                            || route.contains("-preparations/")))
                        || (method == Method::POST && route.ends_with("/setup-attempts"))
                    {
                        if !bytes.is_empty() {
                            return Err(reject(400, "INVALID_BODY"));
                        }
                        json!({})
                    } else if [Method::POST, Method::PUT, Method::PATCH, Method::DELETE]
                        .contains(&method)
                    {
                        match parsed_for_audit.take() {
                            Some(parsed) => parsed?,
                            None => body()?,
                        }
                    } else {
                        json!({})
                    };
                    let actor = app
                        .current_account
                        .as_ref()
                        .map(|account| account.actor_id.as_str())
                        .or_else(|| {
                            app.current_guest
                                .as_ref()
                                .map(|guest| guest.actor_id.as_str())
                        })
                        .unwrap_or_else(|| cookie(&headers, "aw_session").unwrap_or_default());
                    let precondition =
                        |name: &str| -> std::result::Result<Option<&str>, ServiceError> {
                            let mut values = headers.get_all(name).iter();
                            let value = values.next();
                            if values.next().is_some() {
                                return Err(reject(400, "INVALID_PRECONDITION"));
                            }
                            value
                                .map(|v| {
                                    v.to_str().map_err(|_| reject(400, "INVALID_PRECONDITION"))
                                })
                                .transpose()
                        };
                    let if_match = precondition("if-match")?;
                    let if_none_match = precondition("if-none-match")?;
                    let condition = headers.get("idempotency-key").and_then(|v| v.to_str().ok());
                    let (status, reply) = tokio::select! {
                        result=product.handle(workspace_product::Request {credential:credential.clone(),actor,method:method.as_str(),route,query:&query,input,raw:&bytes,condition,if_match,if_none_match,binary_upload,table_name})=>result?,
                        _=cancellation.cancelled()=>return Err(reject(499,if route.contains("analys")||route.contains("tabular-preview"){"ANALYSIS_CANCELED"}else{"SQL_CANCELED"})),
                    };
                    credential_for_response(&app, &headers, &credential).await?;
                    let created_id = if method == Method::POST
                        && (status == 201 || (status == 200 && route == "/sales-sample-attempts"))
                    {
                        match &reply {
                            workspace_product::Reply::Json(v) => {
                                if route.ends_with("-preparations") {
                                    v["id"].as_str()
                                } else {
                                    v["data"]["id"].as_str()
                                }
                                .map(str::to_owned)
                            }
                            _ => None,
                        }
                    } else {
                        None
                    };
                    let mut output = product_response(status, reply)?;
                    if method == Method::PUT && status == 201 && route.starts_with("/tutorials/") {
                        output.headers_mut().insert(
                            "Location",
                            HeaderValue::from_str(route.rsplit('/').next().unwrap_or_default())
                                .map_err(|_| reject(500, "INTERNAL_ERROR"))?,
                        );
                    }
                    if let Some(id) = created_id {
                        output.headers_mut().insert(
                            "Location",
                            HeaderValue::from_str(&format!(
                                "{}/{id}",
                                route.rsplit('/').next().unwrap_or_default()
                            ))
                            .map_err(|_| reject(500, "INTERNAL_ERROR"))?,
                        );
                    }
                    if method == Method::DELETE && route.starts_with("/resources/") && status == 202
                    {
                        output.headers_mut().insert(
                            "Location",
                            HeaderValue::from_str(&path)
                                .map_err(|_| reject(500, "INTERNAL_ERROR"))?,
                        );
                    }
                    return Ok(retain_guest_lease(output, guest_lease));
                }
                return Err(reject(404, "NOT_FOUND"));
            }
        }
    };
    let response = app.workspace.call(credential, operation).await?;
    Ok(retain_guest_lease(
        (
            StatusCode::from_u16(response.status).expect("domain response status"),
            Json(response.body),
        )
            .into_response(),
        guest_lease,
    ))
    }.await;
    if let (Some(guard), Some(action)) = (audit_guard, audit_action) {
        use workspace_domain::observability::{AuditAction, AuditOutcome};
        let outcome = if cancellation.is_cancelled() {
            AuditOutcome::Unknown
        } else {
            match &result {
                Err(error) if error.status == 403 && proven_scope_denial => AuditOutcome::Denied,
                // A failure can follow provider I/O or a committed local mutation. Without a
                // proven pre-effect denial, do not invent a denial or failure.
                Err(_) => AuditOutcome::Unknown,
                Ok(response) if response.status().as_u16() >= 500 => AuditOutcome::Unknown,
                Ok(response) if response.status().as_u16() >= 400 => AuditOutcome::Failed,
                Ok(response)
                    if response.status().as_u16() == 202
                        || matches!(
                            action,
                            AuditAction::ResourceCreate | AuditAction::ResourceRetry
                        ) =>
                {
                    AuditOutcome::Unknown
                }
                Ok(_) => AuditOutcome::Succeeded,
            }
        };
        let target = match &result {
            Ok(response) if response.status().as_u16() < 400 => match action {
                AuditAction::WorkspaceUpdate => Some(workspace_id.clone()),
                AuditAction::ResourceCreate => response
                    .headers()
                    .get("Location")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.strip_prefix("resources/"))
                    .map(str::to_owned),
                _ => target_candidate,
            },
            _ => None,
        };
        // A finished customer effect must not be retried because a history write timed out.
        // Dropping the guard preserves an unknown outcome for later reconciliation.
        let _ = tokio::time::timeout(
            Duration::from_millis(500),
            guard.finish_with_target(outcome, target.as_deref()),
        )
        .await;
    }
    if let (Some(store), Some(actor), Some(operation)) =
        (&app.analytics, &actor, analytics_operation)
    {
        let status = match &result {
            Ok(r) => r.status().as_u16(),
            Err(e) => e.status,
        };
        let kind = if matches!(
            actor.kind,
            workspace_domain::observability::ActorKind::WorkspaceKey
        ) {
            "api"
        } else if app.current_guest.is_some() {
            "guest"
        } else {
            "account"
        };
        store.record(
            &request_id.to_string(),
            &workspace_id,
            kind,
            operation,
            (200..300).contains(&status),
        );
    }
    if let Some(history) = history {
        let completion = if cancellation.is_cancelled() {
            workspace_domain::observability::HttpCompletion::Canceled
        } else {
            workspace_domain::observability::HttpCompletion::Responded(match &result {
                Ok(response) => response.status().as_u16(),
                Err(error) => error.status,
            })
        };
        let _ = app
            .history_queue
            .try_record(&workspace_id, history.finish(completion));
    }
    result
}

fn retain_guest_lease(
    response: Response,
    lease: Option<Arc<managed_workspaces::ManagedWorkspace>>,
) -> Response {
    let Some(lease) = lease else {
        return response;
    };
    response.map(|body| {
        use futures::StreamExt;
        let stream = futures::stream::unfold((body.into_data_stream(), lease), |(mut input, lease)| async move {
            input.next().await.map(|item| (item, (input, lease)))
        });
        axum::body::Body::from_stream(stream)
    })
}
async fn credential(
    app: &App,
    headers: &HeaderMap,
) -> std::result::Result<Credential, ServiceError> {
    if let Some(credential) = &app.token_credential {
        return Ok(credential.clone());
    }
    if let Some(header) = headers.get("authorization") {
        let token = header
            .to_str()
            .ok()
            .and_then(|s| s.strip_prefix("Bearer "))
            .filter(|s| !s.is_empty() && !s.chars().any(char::is_whitespace))
            .ok_or_else(|| reject(401, "INVALID_KEY"))?;
        if let Some(security) = &app.security
            && token.split('.').count() == 3
        {
            return security.authenticate(&app.config.workspace_id, token).await;
        }
        return Err(reject(
            401,
            if token.starts_with("awk_") {
                "EXCHANGE_KEY_AT_GLOBAL"
            } else {
                "INVALID_CREDENTIAL"
            },
        ));
    }
    if let Some(runtime) = &app.guest_runtime
        && app.current_account.is_some()
    {
        let account = runtime.account.authenticate(headers).await?;
        if account.workspace_id != app.config.workspace_id {
            return Err(reject(401, "UNAUTHENTICATED"));
        }
        return Ok(account.credential);
    }
    if let Some(runtime) = &app.guest_runtime
        && app.current_guest.is_some()
    {
        let guest = runtime.region.authenticate(headers).await?;
        if guest.workspace_id != app.config.workspace_id {
            return Err(reject(401, "UNAUTHENTICATED"));
        }
        return Ok(guest.credential);
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
    if !matches!(input, Credential::Scoped(_)) {
        credential(app, headers).await?;
    }
    app.workspace.authenticate(input).await?;
    Ok(())
}

fn decode_table_name(segment: &str) -> std::result::Result<String, ServiceError> {
    let bytes = segment.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit()
            {
                return Err(reject(400, "INVALID_TABLE_NAME"));
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    percent_encoding::percent_decode_str(segment)
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|_| reject(400, "INVALID_TABLE_NAME"))
}

fn product_response(
    status: u16,
    reply: workspace_product::Reply,
) -> std::result::Result<Response, ServiceError> {
    match reply {
        workspace_product::Reply::Empty => Ok(StatusCode::NO_CONTENT.into_response()),
        workspace_product::Reply::Entity { value, etag } => {
            let mut response = (
                StatusCode::from_u16(status).map_err(|_| reject(500, "INTERNAL_ERROR"))?,
                Json(value),
            )
                .into_response();
            response.headers_mut().insert(
                "ETag",
                HeaderValue::from_str(&etag)
                    .map_err(|_| reject(502, "INVALID_PROVIDER_RESPONSE"))?,
            );
            response
                .headers_mut()
                .insert("Cache-Control", HeaderValue::from_static("no-store"));
            Ok(response)
        }
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
        let legacy_account = if let Some(token) = cookie(headers, "aw_session") {
            app.sessions
                .lock()
                .await
                .get(token)
                .is_some_and(|session| session.expires > Instant::now())
        } else {
            false
        };
        let account = if let Some(runtime) = &app.guest_runtime
            && regional_account::RegionalAccount::has_cookie(headers)
        {
            match runtime.account.authenticate(headers).await {
                Ok(account) => Some(account.workspace_id),
                Err(e) if e.status == 401 || e.code == "POLICY_DENIED" => None,
                Err(e) => return error(e),
            }
        } else {
            None
        };
        let guest = if account.is_none()
            && !legacy_account
            && let Some(runtime) = &app.guest_runtime
            && regional_guest::RegionalGuest::has_cookie(headers)
        {
            match runtime.region.authenticate(headers).await {
                Ok(guest) => Some(guest.workspace_id),
                Err(e) if e.status == 401 || e.code == "POLICY_DENIED" => None,
                Err(e) => return error(e),
            }
        } else {
            None
        };
        let mut config = if app.sso.is_some() {
            json!({"enabled":true,"provider":"tidbcloud","label":"Continue with TiDB Account","loginPath":"/api/auth/tidbcloud/login","logoutPath":"/api/auth/tidbcloud/logout","guestEnabled":app.guest_runtime.as_ref().is_some_and(|runtime| runtime.guest_enabled),"guestCleanupEnabled":app.guest_runtime.is_some()})
        } else {
            json!({"enabled":false,"guestEnabled":false})
        };
        if let Some(global) = &app.config.global_entry {
            config["globalApi"] = json!(global);
            config["regionId"] = json!(app.config.authority_id);
        }
        if let Some(id) = account {
            config["sessionKind"] = json!("account");
            config["workspaceId"] = json!(id);
        } else if legacy_account {
            config["sessionKind"] = json!("account");
            if app.guest_runtime.is_none() {
                config["workspaceId"] = json!(app.config.workspace_id);
            }
        } else if let Some(id) = guest {
            config["sessionKind"] = json!("guest");
            config["workspaceId"] = json!(id);
        } else {
            config["workspaceId"] = Value::Null;
        }
        return (
            [(axum::http::header::CACHE_CONTROL, "no-store")],
            Json(config),
        )
            .into_response();
    }
    if path == "/api/auth/guest" && *method == Method::POST {
        let Some(runtime) = &app.guest_runtime else {
            return error(reject(404, "NOT_FOUND"));
        };
        if !runtime.guest_enabled {
            return error(reject(404, "NOT_FOUND"));
        }
        let Some(peer) = peer else {
            return error(reject(403, "LOCAL_ONLY"));
        };
        return match runtime.entry.enter(headers, peer.ip()).await {
            Ok(result) => {
                if result.set_cookie.is_some() {
                    if let Some(store) = &app.analytics {
                        store.record(
                            "workspace_ready",
                            &result.workspace_id,
                            "guest",
                            "workspace_ready",
                            true,
                        );
                    }
                    if let Some(global) = &app.portal_sessions {
                        global
                            .trial(headers, &result.workspace_id, &app.config.authority_id)
                            .await;
                    }
                }
                let mut body = json!({"workspaceId":result.workspace_id});
                if result.set_cookie.is_some()
                    && let Some(product) = &app.product
                    && let Some(region) =
                        product.capabilities()["filesystem"]["regions"][0].as_str()
                {
                    body["initialFileSystemRegion"] = json!(region);
                }
                let mut response = Json(body).into_response();
                if let Some(value) = result.set_cookie {
                    response.headers_mut().append("Set-Cookie", value);
                }
                response
            }
            Err(e) => error(e),
        };
    }
    if path == "/api/auth/guest/logout" && *method == Method::POST {
        if let Some(runtime) = &app.guest_runtime
            && regional_account::RegionalAccount::has_cookie(headers)
        {
            match runtime.account.authenticate(headers).await {
                Ok(_) => return error(reject(403, "GUEST_REQUIRED")),
                Err(e) if e.status == 401 || e.code == "POLICY_DENIED" => {}
                Err(e) => return error(e),
            }
        }
        if let Some(token) = cookie(headers, "aw_session")
            && app
                .sessions
                .lock()
                .await
                .get(token)
                .is_some_and(|session| session.expires > Instant::now())
        {
            return error(reject(403, "GUEST_REQUIRED"));
        }
        let Some(runtime) = &app.guest_runtime else {
            return error(reject(404, "NOT_FOUND"));
        };
        return match runtime
            .region
            .request_logout_cleanup(headers, &runtime.cleanup)
            .await
        {
            Ok((guest_cookie, workspace)) => {
                if let Ok(permit) = runtime.cleanup_slots.clone().try_acquire_owned() {
                    let queue = runtime.cleanup.clone();
                    let processor = runtime.cleanup_processor.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        if let Ok(Some(job)) = queue.requested_workspace(&workspace).await {
                            let _ = workspace_identity::scheduler::process_one(
                                &queue,
                                processor.as_ref(),
                                &job,
                            )
                            .await;
                        }
                    });
                }
                let mut response =
                    Json(json!({"loggedOut":true,"cleanup":"scheduled"})).into_response();
                response.headers_mut().append("Set-Cookie", guest_cookie);
                response
            }
            Err(failure) => error(failure),
        };
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
        let account = if let Some(runtime) = &app.guest_runtime
            && regional_account::RegionalAccount::has_cookie(headers)
        {
            match runtime.account.authenticate(headers).await {
                Ok(_) => true,
                Err(e) if e.status == 401 || e.code == "POLICY_DENIED" => false,
                Err(e) => return error(e),
            }
        } else if let Some(token) = cookie(headers, "aw_session") {
            app.sessions
                .lock()
                .await
                .get(token)
                .is_some_and(|session| session.expires > Instant::now())
        } else {
            false
        };
        if !account
            && app.guest_runtime.is_some()
            && regional_guest::RegionalGuest::has_cookie(headers)
        {
            return error(reject(405, "GUEST_LOGOUT_POST_REQUIRED"));
        }
        // Revoke any attached Guest session as well as the account session; otherwise
        // signing out silently resumes the Guest on the next page load.
        let account_cookie = if let Some(runtime) = &app.guest_runtime
            && regional_account::RegionalAccount::has_cookie(headers)
        {
            match runtime.account.revoke(headers).await {
                Ok(value) => Some(value),
                Err(e) if e.status == 401 || e.code == "POLICY_DENIED" => {
                    match runtime.account.clear_cookie() {
                        Ok(value) => Some(value),
                        Err(e) => return error(e),
                    }
                }
                Err(e) => return error(e),
            }
        } else {
            None
        };
        let guest_cookie = if let Some(runtime) = &app.guest_runtime
            && regional_guest::RegionalGuest::has_cookie(headers)
        {
            match runtime.region.revoke(headers).await {
                Ok(value) => Some(value),
                Err(e) if e.status == 401 => match runtime.region.clear_cookie() {
                    Ok(value) => Some(value),
                    Err(e) => return error(e),
                },
                Err(e) => return error(e),
            }
        } else {
            None
        };
        if let Some(token) = cookie(headers, "aw_session")
            && let Some(session) = app.sessions.lock().await.remove(token)
        {
            session.credential.revoke();
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
        if let Some(value) = account_cookie {
            response.headers_mut().append("Set-Cookie", value);
        }
        if let Some(value) = guest_cookie {
            response.headers_mut().append("Set-Cookie", value);
        }
        if let Some(global) = &app.portal_sessions {
            let workspace = regional_account::RegionalAccount::workspace_hint(headers).ok();
            let revoked = global.revoke(headers, workspace).await;
            if let Err(e) = revoked {
                let cookies = response
                    .headers()
                    .get_all("Set-Cookie")
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>();
                response = error(e);
                for value in cookies {
                    response.headers_mut().append("Set-Cookie", value);
                }
            }
            match global.clear() {
                Ok(value) => response.headers_mut().append("Set-Cookie", value),
                Err(e) => return error(e),
            };
        }
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
                if query.get("operator").is_some_and(|v| v == "1") {
                    set_cookie(
                        &mut r,
                        format!(
                            "aw_operator_flow={flow}; HttpOnly; SameSite=Lax;{secure} Path={}/api/auth/tidbcloud; Max-Age=600",
                            app.config.public_path
                        ),
                    );
                }
                r
            }
            Err(e) => error(e),
        };
    }
    if path == "/api/auth/tidbcloud/callback" && *method == Method::GET {
        let verified = sso
            .callback(cookie(headers, "aw_sso_flow").unwrap_or_default(), query)
            .await;
        if cookie(headers, "aw_operator_flow") == cookie(headers, "aw_sso_flow")
            && cookie(headers, "aw_operator_flow").is_some()
        {
            return match verified {
                Ok(login) => match &app.portal_sessions {
                    Some(global) => global.operator_login(&login).await.unwrap_or_else(error),
                    None => error(reject(404, "OPERATOR_UNAVAILABLE")),
                },
                Err(e) => error(e),
            };
        }
        if let Some(runtime) = &app.guest_runtime {
            let result = match verified {
                Err(e) => Err(e),
                Ok(login) => {
                    let (issuer, subject) = login.identity();
                    match &runtime.account_onboarding {
                        None => Err(reject(503, "ACCOUNT_ONBOARDING_UNAVAILABLE")),
                        Some(onboarding) => match onboarding
                            .personal_with_creation(issuer, subject)
                            .await
                        {
                            Ok((registration, fresh)) => {
                                if let Some(store) = &app.analytics {
                                    if fresh {
                                        store.record(
                                            &registration.operation_id,
                                            &registration.workspace_id,
                                            "account",
                                            "workspace_ready",
                                            true,
                                        );
                                    }
                                    if app.portal_sessions.is_none() {
                                        store.record(
                                            &uuid::Uuid::new_v4().to_string(),
                                            &registration.workspace_id,
                                            "account",
                                            "sign_in_completed",
                                            true,
                                        );
                                    }
                                }
                                if let Some(global) = &app.portal_sessions {
                                    global
                                        .trial(
                                            headers,
                                            &registration.workspace_id,
                                            &app.config.authority_id,
                                        )
                                        .await;
                                }
                                let regional_cookie = runtime
                                    .account
                                    .establish(&registration.workspace_id, issuer, subject)
                                    .await;
                                match regional_cookie {
                                    Err(e) => Err(e),
                                    Ok(regional) => {
                                        let global = match &app.portal_sessions {
                                            Some(global) => {
                                                let old_workspace = regional_account::RegionalAccount::workspace_hint(headers).ok();
                                                if let Err(e) =
                                                    global.revoke(headers, old_workspace).await
                                                {
                                                    return error(e);
                                                }
                                                match global
                                                    .establish(&login, &registration.workspace_id)
                                                    .await
                                                {
                                                    Ok(cookie) => Some(cookie),
                                                    Err(e) => return error(e),
                                                }
                                            }
                                            None => None,
                                        };
                                        Ok((regional, global))
                                    }
                                }
                            }
                            Err(e) => Err(e),
                        },
                    }
                }
            };
            let mut response = match result {
                Ok((account_cookie, global_cookie)) => {
                    if regional_account::RegionalAccount::has_cookie(headers)
                        && let Err(e) = runtime.account.revoke(headers).await
                        && e.status != 401
                        && e.code != "POLICY_DENIED"
                    {
                        return error(e);
                    }
                    let mut response = redirect(&sso.config.post_login(&app.config.public_path));
                    response.headers_mut().append("Set-Cookie", account_cookie);
                    if let Some(cookie) = global_cookie {
                        response.headers_mut().append("Set-Cookie", cookie);
                    }
                    response
                }
                Err(e) => error(e),
            };
            set_cookie(&mut response, flow_cookie("", 0));
            return response;
        }
        // The historical shared owner is retained only for isolated loopback test profiles.
        // A hosted deployment without the regional identity services must fail closed.
        let result = verified.and_then(|login| {
            if !app.config.insecure_loopback {
                return Err(reject(503, "ACCOUNT_ONBOARDING_UNAVAILABLE"));
            }
            sso::shared_workspace_owner(&sso.config, &login, &app.config.workspace_id)
        });
        let mut response = match result {
            Err(e) => error(e),
            Ok(credential) => {
                let now = Instant::now();
                let mut sessions = app.sessions.lock().await;
                sessions.retain(|_, s| {
                    if s.expires <= now {
                        s.credential.revoke();
                        false
                    } else {
                        true
                    }
                });
                if let Some(old) = cookie(headers, "aw_session")
                    && let Some(session) = sessions.remove(old)
                {
                    session.credential.revoke();
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

/// Deliberate one-time bootstrap without opening an HTTP or control listener.
pub async fn initialize_security_checkpoint(
    directory: &Path,
    initialize: bool,
) -> anyhow::Result<()> {
    if initialize {
        use std::os::unix::fs::DirBuilderExt;
        let parent = directory
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Clock parent required"))?;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
    }
    let clock = security_clock::Clock::open(directory, initialize)?;
    clock.now().await?;
    Ok(())
}

pub async fn initialize_meta_security_checkpoint(
    metadata: Arc<dyn Metadata>,
    authority: &str,
    initialize: bool,
) -> anyhow::Result<()> {
    let clock = security_clock::Clock::open_meta(metadata, authority, initialize).await?;
    clock.now().await?;
    Ok(())
}
