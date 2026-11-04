//! Independent Global public management API. Data-plane operations have no routes here.
mod analytics_routes;
use crate::{
    MetaBinding,
    access_signer::{AccessSigner, Issuance, SigningConfig},
    security_clock::Clock,
    signed_access::{AccessTrust, AccessVerifier, IssuerKind},
    sso,
};
use anyhow::{Result, ensure};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    net::TcpListener,
    sync::{Mutex, Semaphore},
};
use uuid::Uuid;
use workspace_contracts::{MetaRequest, Metadata, Scope, ServiceError};
use workspace_identity::{
    VerifiedIdentity,
    global_keys::{GlobalKeys, KeyView, NewKey},
    global_owner_sessions::OwnerSessions,
};
use workspace_meta_client::private_file;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegionDescriptor {
    pub region_id: String,
    pub api_origin: String,
    pub api_path_prefix: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub analytics: Option<crate::analytics::operator::Config>,
    pub bind: SocketAddr,
    pub metadata: MetaBinding,
    pub public_origin: String,
    #[serde(default)]
    pub public_path: String,
    #[serde(default)]
    pub shared_listener: bool,
    #[serde(default)]
    pub console_origins: Vec<String>,
    pub local_workspace: Option<workspace_identity::RegionAssignment>,
    pub environment: String,
    pub signer_id: String,
    pub signing_key_file: PathBuf,
    pub verification_key_file: PathBuf,
    #[serde(default)]
    pub clock_directory: PathBuf,
    #[serde(default)]
    pub initialize_clock: bool,
    #[serde(default)]
    pub metadata_security_state: bool,
    pub regions: Vec<RegionDescriptor>,
    pub sso: Option<sso::Config>,
    #[serde(default)]
    pub region_controls: Vec<RegionControlConfig>,
    #[serde(default)]
    pub region_connection: Option<crate::region_connection::HubConfig>,
}
impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let c: Self = serde_json::from_slice(&private_file(path)?)?;
        c.validate()?;
        Ok(c)
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(self.bind.is_ipv4(), "IPv4 listener required");
        let local = self.bind.ip().is_loopback();
        if let Some(settings) = &self.analytics {
            let mut origins = self.console_origins.clone();
            origins.push(self.public_origin.clone());
            settings.validate(&origins, local)?;
            anyhow::ensure!(
                settings.pseudonym_key_file != self.signing_key_file,
                "Dedicated analytics key required"
            );
        }
        let url = sso::endpoint(&self.public_origin, local)?;
        ensure!(
            url.origin().ascii_serialization() == self.public_origin,
            "Canonical Global origin required"
        );
        ensure!(
            self.public_path.is_empty()
                || self.public_path.starts_with('/')
                    && self.public_path.split('/').skip(1).all(|s| !s.is_empty()
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))),
            "Invalid Global API path"
        );
        ensure!(
            !self.shared_listener || !self.public_path.is_empty(),
            "Shared Global listener requires a distinct path"
        );
        for origin in &self.console_origins {
            let parsed = sso::endpoint(origin, local)?;
            ensure!(
                parsed.origin().ascii_serialization() == *origin,
                "Canonical Console origin required"
            );
        }
        if let Some(workspace) = &self.local_workspace {
            ensure!(
                local
                    && url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
                    && self.sso.is_none()
                    && id(&workspace.workspace_id)
                    && self
                        .regions
                        .iter()
                        .any(|r| r.region_id == workspace.region_id),
                "Local Global Owner mode is loopback-only"
            );
        }
        ensure!(
            id(&self.environment) && id(&self.signer_id),
            "Explicit signer/environment required"
        );
        ensure!(
            self.signing_key_file.is_absolute()
                && self.verification_key_file.is_absolute()
                && (self.metadata_security_state || self.clock_directory.is_absolute()),
            "Private absolute paths required"
        );
        match &self.metadata {
            MetaBinding::InProcess { authority_id } => {
                ensure!(authority_id == "global", "Global metadata required")
            }
            MetaBinding::Remote { client } => {
                ensure!(client.authority_id == "global", "Global metadata required")
            }
        }
        ensure!(
            !self.regions.is_empty() && self.regions.len() <= 64,
            "Bounded explicit Region catalog required"
        );
        let mut seen = std::collections::BTreeSet::new();
        for r in &self.regions {
            let origin = sso::endpoint(&r.api_origin, local)?;
            ensure!(
                r.region_id.starts_with("region:")
                    && id(&r.region_id)
                    && seen.insert(&r.region_id)
                    && origin.origin().ascii_serialization() == r.api_origin,
                "Invalid Region catalog"
            );
            ensure!(
                r.api_path_prefix.is_empty()
                    || r.api_path_prefix.split('/').skip(1).all(|s| !s.is_empty()
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)))
                        && r.api_path_prefix.starts_with('/'),
                "Invalid Region path"
            );
        }
        if let Some(sso) = &self.sso {
            sso.validate(&self.public_path, local)?;
            ensure!(
                reqwest::Url::parse(&sso.redirect_uri)?
                    .origin()
                    .ascii_serialization()
                    == self.public_origin,
                "SSO callback origin mismatch"
            );
            ensure!(
                sso.owner_subjects.is_empty()
                    && sso.owner_email_rules.is_empty()
                    && sso.allowed_orgs.is_empty(),
                "Global ownership comes from verified Directory membership"
            );
        }
        Ok(())
    }
}
use crate::{
    policy_command::{PolicyCommandSigner, PolicyReceipt, PolicySignerConfig},
    policy_transport::{ClientTls, PolicyControlClient},
};
use workspace_identity::regional_grants::Grant;
use workspace_identity::{
    enrollment_ticket::{TicketIssuance, TicketSigner, TicketSigningConfig},
    regional_key_policy::KeyPolicy,
};
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegionControlConfig {
    pub region_id: String,
    pub origin: String,
    pub tls: ClientTls,
}
struct RegionIssuer {
    control: RegionControl,
    policies: PolicyCommandSigner,
    access: AccessSigner,
    tickets: TicketSigner,
}
enum RegionControl {
    Direct(PolicyControlClient),
    Connection(Arc<crate::region_connection::Hub>, String),
}
impl RegionControl {
    async fn apply(
        &self,
        command: &str,
        receipt: &PolicyReceipt,
    ) -> workspace_contracts::Result<PolicyReceipt> {
        match self {
            Self::Direct(client) => client.apply(command, receipt).await,
            Self::Connection(hub, region) => hub.apply(region, command, receipt).await,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateKey {
    #[serde(default = "default_key_name")]
    name: String,
    scopes: Vec<String>,
    resource_ids: Vec<String>,
    expires_at: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TokenInput {
    audience: String,
    scopes: Option<Vec<String>>,
    client_thumbprint: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Renewal {
    expires_at: i64,
}
struct LoginFlow {
    workspace: Option<String>,
    return_to: Option<String>,
    expires: Instant,
}
struct AuthorizedOwner {
    region_id: String,
    principal_id: String,
    guest_expires_at: Option<i64>,
}
struct LocalGuestAuthority {
    region: String,
    sessions: Arc<crate::regional_guest::RegionalGuest>,
}
struct Acquisition {
    attribution: Option<crate::analytics::Attribution>,
    session: String,
    expires: Instant,
}
struct App {
    acquisition: Mutex<BTreeMap<String, Acquisition>>,
    analytics: Option<crate::analytics::Store>,
    operators: Option<crate::analytics::operator::Operators>,
    analytics_limits: Mutex<BTreeMap<String, (Instant, u32)>>,
    analytics_reads: Semaphore,
    config: Config,
    trusted_host_origins: Vec<String>,
    metadata: Arc<dyn Metadata>,
    keys: GlobalKeys,
    owners: OwnerSessions,
    signer: AccessSigner,
    portal_signer: crate::portal_ticket::Signer,
    verifier: AccessVerifier,
    clock: Clock,
    sso: Option<sso::Runtime>,
    flows: Mutex<BTreeMap<String, LoginFlow>>,
    capacity: Semaphore,
    regional: BTreeMap<String, RegionIssuer>,
    region_connection: Option<Arc<crate::region_connection::Hub>>,
    reconcile_cursors: Mutex<BTreeMap<String, String>>,
    local_guests: Option<LocalGuestAuthority>,
}
pub struct GlobalServer {
    listener: Option<TcpListener>,
    app: Arc<App>,
}
pub struct RegionReconciler(Arc<App>);
impl RegionReconciler {
    pub async fn run(self, stop: tokio_util::sync::CancellationToken) {
        let app = self.0;
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        loop {
            tokio::select! {
                _ = stop.cancelled() => return,
                _ = tick.tick() => {
                    for descriptor in &app.config.regions {
                        if stop.is_cancelled() { return; }
                        if app.region_connection.as_ref().expect("reconciler requires connection").connected(&descriptor.region_id).await {
                            let _ = app.reconcile_region(&descriptor.region_id).await;
                        }
                    }
                }
            }
        }
    }
}

/// Global authority used exclusively by the bundled Portal's verified OIDC callback.
/// Regional data authentication never uses this port and no Region HTTP callback exists.
#[derive(Clone)]
pub(crate) struct PortalSessions {
    app: Arc<App>,
    cookie_path: String,
}
impl PortalSessions {
    fn cookie(&self, secret: &str, age: u32) -> workspace_contracts::Result<header::HeaderValue> {
        let secure = if self.app.config.public_origin.starts_with("https:") {
            " Secure;"
        } else {
            ""
        };
        let mut value = header::HeaderValue::from_str(&format!(
            "aw_global_owner={secret}; HttpOnly; SameSite=Strict;{secure} Path={}/; Max-Age={age}",
            self.cookie_path
        ))
        .map_err(|_| err(503, "SESSION_UNAVAILABLE"))?;
        value.set_sensitive(true);
        Ok(value)
    }
    pub(crate) async fn trial(&self, headers: &HeaderMap, workspace: &str, region: &str) {
        self.app.attribute_trial(headers, workspace, region).await;
    }
    pub(crate) async fn operator_login(
        &self,
        login: &sso::VerifiedLogin,
    ) -> workspace_contracts::Result<Response> {
        let operators = self
            .app
            .operators
            .as_ref()
            .ok_or_else(|| err(404, "OPERATOR_UNAVAILABLE"))?;
        let cookie = operators.establish(login).await?;
        let mut response = StatusCode::SEE_OTHER.into_response();
        response.headers_mut().insert(
            header::LOCATION,
            operators
                .return_url()
                .parse()
                .map_err(|_| err(503, "OPERATOR_UNAVAILABLE"))?,
        );
        response.headers_mut().append(header::SET_COOKIE, cookie);
        Ok(response)
    }
    pub(crate) async fn establish(
        &self,
        login: &sso::VerifiedLogin,
        workspace: &str,
    ) -> workspace_contracts::Result<header::HeaderValue> {
        self.app.clock.now().await?;
        let (issuer, subject) = login.identity();
        let issued = self
            .app
            .owners
            .issue(
                VerifiedIdentity { issuer, subject },
                workspace,
                &Uuid::new_v4().to_string(),
            )
            .await?;
        if let Some(store) = &self.app.analytics {
            store.record(
                &Uuid::new_v4().to_string(),
                workspace,
                "account",
                "sign_in_completed",
                true,
            );
        }
        self.cookie(&issued.secret, 28800)
    }
    pub(crate) async fn revoke(
        &self,
        headers: &HeaderMap,
        workspace: Option<&str>,
    ) -> workspace_contracts::Result<()> {
        if let (Some(workspace), Some(secret)) = (workspace, cookie(headers, "aw_global_owner"))
            && let Err(e) = self
                .app
                .owners
                .revoke(workspace, secret, &Uuid::new_v4().to_string())
                .await
            && e.status != 401
        {
            return Err(e);
        }
        Ok(())
    }
    pub(crate) fn clear(&self) -> workspace_contracts::Result<header::HeaderValue> {
        self.cookie("", 0)
    }
}
fn err(status: u16, code: &str) -> ServiceError {
    ServiceError::new(status, code)
}
fn id(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 128
        && v != "."
        && v != ".."
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
}
fn mutation(h: &HeaderMap) -> workspace_contracts::Result<String> {
    let s = h
        .get("idempotency-key")
        .and_then(|s| s.to_str().ok())
        .ok_or_else(|| err(400, "IDEMPOTENCY_KEY_REQUIRED"))?;
    if Uuid::parse_str(s).is_ok_and(|u| u.to_string() == s) {
        Ok(s.into())
    } else {
        Err(err(400, "INVALID_IDEMPOTENCY_KEY"))
    }
}
fn cookie<'a>(h: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = h
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .map(str::trim)
        .filter_map(|s| s.strip_prefix(name)?.strip_prefix('='));
    let value = values.next()?;
    if values.next().is_some() {
        None
    } else {
        Some(value)
    }
}
fn bearer(h: &HeaderMap) -> workspace_contracts::Result<&str> {
    h.get(header::AUTHORIZATION)
        .and_then(|s| s.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| !s.is_empty() && !s.chars().any(char::is_whitespace))
        .ok_or_else(|| err(401, "INVALID_CREDENTIAL"))
}
fn parse<T: serde::de::DeserializeOwned>(
    h: &HeaderMap,
    bytes: &[u8],
) -> workspace_contracts::Result<T> {
    if h.get(header::CONTENT_TYPE).and_then(|s| s.to_str().ok()) != Some("application/json") {
        return Err(err(415, "JSON_REQUIRED"));
    }
    serde_json::from_slice(bytes).map_err(|_| err(400, "INVALID_BODY"))
}
fn json_response(status: StatusCode, value: Value, location: Option<String>) -> Response {
    let mut r = (status, Json(value)).into_response();
    r.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    if let Some(l) = location
        && let Ok(v) = l.parse()
    {
        r.headers_mut().insert(header::LOCATION, v);
    }
    r
}
fn etag(mut r: Response, v: u64) -> Response {
    r.headers_mut().insert(
        header::ETAG,
        format!("\"{v}\"").parse().expect("numeric ETag"),
    );
    r
}
impl GlobalServer {
    /// A shared listener accepts exactly the Region's configured trusted hosts.
    /// Standalone Global servers continue to use only their own public origin.
    pub(crate) fn with_shared_region_origins(
        mut self,
        regional_bind: SocketAddr,
        public_origins: &[String],
    ) -> Self {
        if self.app.config.shared_listener
            && self.app.config.bind == regional_bind
            && let Some(app) = Arc::get_mut(&mut self.app)
        {
            for origin in public_origins {
                if !app.trusted_host_origins.contains(origin) {
                    app.trusted_host_origins.push(origin.clone());
                }
            }
        }
        self
    }
    /// Share the authenticated Guest session only within the explicitly co-located listener.
    /// Independent Global services never accept a Region browser credential.
    pub(crate) fn with_colocated_guests(
        mut self,
        region: &str,
        sessions: Arc<crate::regional_guest::RegionalGuest>,
        regional_bind: SocketAddr,
        public_origins: &[String],
    ) -> Self {
        let config = &self.app.config;
        if config.shared_listener
            && config.bind == regional_bind
            && public_origins.contains(&config.public_origin)
            && config.regions.iter().any(|r| r.region_id == region)
            && let Some(app) = Arc::get_mut(&mut self.app)
        {
            app.local_guests = Some(LocalGuestAuthority {
                region: region.into(),
                sessions,
            });
        }
        self
    }
    pub(crate) fn portal_sessions(&self, path: &str) -> Option<PortalSessions> {
        (self.app.config.shared_listener
            && self.app.config.local_workspace.is_none()
            && self
                .app
                .config
                .public_path
                .starts_with(&format!("{path}/api/")))
        .then(|| PortalSessions {
            app: self.app.clone(),
            cookie_path: path.into(),
        })
    }
    pub async fn open(config: Config, metadata: Arc<dyn Metadata>) -> Result<Self> {
        config.validate()?;
        let key = private_file(&config.signing_key_file)?;
        let public = String::from_utf8(private_file(&config.verification_key_file)?)?;
        let public: [u8; 32] = hex_bytes(public.trim())?;
        let signer = AccessSigner::new(
            SigningConfig {
                issuer: format!("{}{}", config.public_origin, config.public_path),
                audience: "global".into(),
                environment: config.environment.clone(),
                region: None,
                key_id: config.signer_id.clone(),
                max_lifetime: 900,
                issuer_kind: IssuerKind::Global,
            },
            &key,
        )?;
        let verifier = AccessVerifier::new(AccessTrust {
            issuer: format!("{}{}", config.public_origin, config.public_path),
            audience: "global".into(),
            environment: config.environment.clone(),
            region: None,
            max_lifetime: 900,
            issuer_kind: IssuerKind::Global,
            keys: BTreeMap::from([(config.signer_id.clone(), public)]),
        })?;
        // Catch a misconfigured signing/verification pair before opening the public listener.
        let scopes = vec!["resources:read".into()];
        let now = chrono::Utc::now().timestamp();
        let probe = signer.sign(
            &Issuance {
                workspace_id: "self-check",
                principal_id: "self-check",
                key_id: &Uuid::new_v4().to_string(),
                key_version: 1,
                policy_generation: 1,
                grant_ref: "self-check",
                scopes: &scopes,
                key_expires_at: now + 1,
                grant_expires_at: now + 1,
                family: None,
            },
            now,
        )?;
        verifier.verify(&probe.token, now)?;
        let mut controls = std::collections::BTreeSet::new();
        ensure!(
            config
                .region_controls
                .iter()
                .all(|control| controls.insert(&control.region_id)
                    && config
                        .regions
                        .iter()
                        .any(|r| r.region_id == control.region_id)),
            "Invalid Region control selection"
        );
        let region_connection = config
            .region_connection
            .as_ref()
            .map(|_| Arc::new(crate::region_connection::Hub::default()));
        let portal_signer = crate::portal_ticket::Signer::new(
            &key,
            format!("{}{}", config.public_origin, config.public_path),
            config.signer_id.clone(),
            config.environment.clone(),
        )?;
        let mut regional = BTreeMap::new();
        for descriptor in &config.regions {
            let control = config
                .region_controls
                .iter()
                .find(|c| c.region_id == descriptor.region_id);
            if control.is_none() && region_connection.is_none() {
                continue;
            }
            let region_id = &descriptor.region_id;
            ensure!(
                !regional.contains_key(region_id),
                "Invalid Region control selection"
            );
            regional.insert(
                region_id.clone(),
                RegionIssuer {
                    control: if let Some(hub) = &region_connection {
                        RegionControl::Connection(hub.clone(), region_id.clone())
                    } else {
                        let control = control.expect("direct control exists");
                        RegionControl::Direct(PolicyControlClient::new(
                            &control.origin,
                            region_id,
                            control.tls.clone(),
                        )?)
                    },
                    policies: PolicyCommandSigner::new(
                        PolicySignerConfig {
                            issuer: format!("{}{}", config.public_origin, config.public_path),
                            audience: format!("{}/control", region_id),
                            environment: config.environment.clone(),
                            region_id: region_id.clone(),
                            key_id: config.signer_id.clone(),
                        },
                        &key,
                    )?,
                    access: AccessSigner::new(
                        SigningConfig {
                            issuer: format!("{}{}", config.public_origin, config.public_path),
                            audience: format!("{}/audience", region_id),
                            environment: config.environment.clone(),
                            region: Some(region_id.clone()),
                            key_id: config.signer_id.clone(),
                            max_lifetime: 900,
                            issuer_kind: IssuerKind::Global,
                        },
                        &key,
                    )?,
                    tickets: TicketSigner::from_pkcs8(
                        TicketSigningConfig {
                            issuer: format!("{}{}", config.public_origin, config.public_path),
                            audience: format!("{}/enrollment", region_id),
                            environment: config.environment.clone(),
                            region_id: region_id.clone(),
                            key_id: config.signer_id.clone(),
                        },
                        &key,
                    )?,
                },
            );
        }
        let clock = if config.metadata_security_state {
            Clock::open_meta(metadata.clone(), "global", config.initialize_clock).await?
        } else {
            Clock::open(&config.clock_directory, config.initialize_clock)?
        };
        clock.now().await?;
        let owners = OwnerSessions::open(metadata.clone()).await?;
        let keys = GlobalKeys::open(metadata.clone()).await?;
        let sso = config.sso.clone().map(sso::Runtime::new).transpose()?;
        let listener = if config.shared_listener {
            None
        } else {
            Some(TcpListener::bind(config.bind).await?)
        };
        let trusted_host_origins = vec![config.public_origin.clone()];
        let analytics = config
            .analytics
            .as_ref()
            .map(|settings| {
                crate::analytics::Store::new(
                    metadata.clone(),
                    "global",
                    private_file(&settings.pseudonym_key_file)
                        .map_err(|_| err(503, "ANALYTICS_KEY_UNAVAILABLE"))?,
                )
            })
            .transpose()?;
        let cookie_path = config
            .public_path
            .strip_suffix("/api/global")
            .unwrap_or(&config.public_path);
        let operators = config
            .analytics
            .clone()
            .map(|settings| {
                crate::analytics::operator::Operators::new(
                    settings,
                    cookie_path,
                    config.public_origin.starts_with("https:"),
                )
            })
            .transpose()?;
        Ok(Self {
            listener,
            app: Arc::new(App {
                config,
                acquisition: Mutex::new(BTreeMap::new()),
                analytics,
                operators,
                analytics_limits: Mutex::new(BTreeMap::new()),
                analytics_reads: Semaphore::new(1),
                trusted_host_origins,
                metadata,
                keys,
                owners,
                signer,
                portal_signer,
                verifier,
                clock,
                sso,
                flows: Mutex::new(BTreeMap::new()),
                capacity: Semaphore::new(16),
                regional,
                region_connection,
                reconcile_cursors: Mutex::new(BTreeMap::new()),
                local_guests: None,
            }),
        })
    }
    pub fn origin(&self) -> &str {
        &self.app.config.public_origin
    }
    pub fn public_base(&self) -> String {
        format!(
            "{}{}",
            self.app.config.public_origin, self.app.config.public_path
        )
    }
    pub fn mount_path(&self) -> &str {
        &self.app.config.public_path
    }
    pub fn router(&self) -> Router {
        Router::new()
            .fallback(any(receive))
            .with_state(self.app.clone())
    }
    pub fn agent_entry_router(&self, gateway_prefix: &str) -> Router {
        let mut router = Router::new();
        let prefixes = if gateway_prefix.is_empty() {
            vec![""]
        } else {
            vec!["", gateway_prefix]
        };
        for prefix in prefixes {
            for path in [
                "/api/openapi.json",
                "/api/v1/token-issuances",
                "/api/v1/workspaces/{workspaceId}/region-route",
                "/api/v1/workspaces/{workspaceId}/regions",
                "/api/v1/workspaces/{workspaceId}/issuances/{issuanceId}",
            ] {
                router = router.route(&format!("{prefix}{path}"), any(receive));
            }
        }
        router.with_state(self.app.clone())
    }
    pub fn region_connection(
        &self,
    ) -> Option<(
        Arc<crate::region_connection::Hub>,
        crate::region_connection::HubConfig,
        Vec<RegionDescriptor>,
    )> {
        Some((
            self.app.region_connection.clone()?,
            self.app.config.region_connection.clone()?,
            self.app.config.regions.clone(),
        ))
    }
    pub fn reconciler(&self) -> Option<RegionReconciler> {
        self.app.region_connection.as_ref()?;
        Some(RegionReconciler(self.app.clone()))
    }
    pub async fn serve(
        self,
        stop: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> Result<()> {
        let router = self.router();
        let cancellation = tokio_util::sync::CancellationToken::new();
        let signal = cancellation.clone();
        tokio::spawn(async move {
            stop.await;
            signal.cancel();
        });
        let task = self
            .reconciler()
            .map(|reconciler| tokio::spawn(reconciler.run(cancellation.clone())));
        let result = axum::serve(
            self.listener
                .ok_or_else(|| anyhow::anyhow!("Global is mounted on a shared listener"))?,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(cancellation.clone().cancelled_owned())
        .await;
        cancellation.cancel();
        if let Some(task) = task {
            task.await?;
        }
        result?;
        Ok(())
    }
}
fn hex_bytes(s: &str) -> Result<[u8; 32]> {
    ensure!(
        s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()),
        "Expected 32-byte public key"
    );
    let mut key = [0; 32];
    for (i, b) in key.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)?;
    }
    Ok(key)
}
impl App {
    async fn attribute_trial(&self, headers: &HeaderMap, workspace: &str, region: &str) {
        if cookie(headers, "aw_analytics_off") == Some("1")
            || headers.get("sec-gpc").is_some_and(|v| v == "1")
        {
            return;
        }
        if let Some(token) = cookie(headers, "aw_acquisition")
            && let Some(handoff) = self
                .acquisition
                .lock()
                .await
                .remove(token)
                .filter(|v| v.expires > Instant::now())
        {
            if let Some(store) = &self.analytics {
                store.record("trial", &handoff.session, "browser", "trial", true);
            }
            if let (Some(hub), Some(attribution)) = (&self.region_connection, handoff.attribution) {
                let hub = hub.clone();
                let workspace = workspace.to_owned();
                let region = region.to_owned();
                let analytics = self.analytics.clone();
                tokio::spawn(async move {
                    if hub
                        .attribute(&region, workspace, attribution)
                        .await
                        .is_err()
                        && let Some(store) = analytics
                    {
                        store.mark_unconfirmed();
                    }
                });
            }
        }
    }
    fn sync_scope(region: &str) -> Scope {
        Scope::system(
            "global",
            "region-control",
            "policy-sync",
            &format!("{:x}", Sha256::digest(region.as_bytes())),
        )
    }
    async fn mark_region_sync(
        &self,
        region: &str,
        workspace: &str,
        key: &str,
        target: u64,
        operation: &str,
        renewal_expiry: Option<i64>,
    ) -> workspace_contracts::Result<()> {
        if self.region_connection.is_none() {
            return Ok(());
        }
        let scope = Self::sync_scope(region);
        let path = format!(
            "pending/{:x}",
            Sha256::digest(format!("{workspace}\0{operation}").as_bytes())
        );
        let value = json!({"workspaceId":workspace,"keyId":key,"targetVersion":target,"regionId":region,"renewalExpiry":renewal_expiry});
        let result = self
            .metadata
            .execute(MetaRequest::Commit {
                scope: scope.clone(),
                guard: None,
                mutation_id: Uuid::new_v4().to_string(),
                changes: vec![json!({"key":path,"expectedVersion":null,"value":value})],
            })
            .await;
        if result.is_ok() {
            return Ok(());
        }
        let existing = self
            .metadata
            .execute(MetaRequest::Get {
                scope,
                guard: None,
                keys: vec![path.clone()],
            })
            .await?;
        if existing["records"][&path]["value"] == value {
            Ok(())
        } else {
            Err(err(503, "POLICY_SYNC_UNAVAILABLE"))
        }
    }
    async fn reconcile_region(&self, region: &str) -> workspace_contracts::Result<()> {
        let scope = Self::sync_scope(region);
        let after = self.reconcile_cursors.lock().await.get(region).cloned();
        let page = self
            .metadata
            .execute(MetaRequest::List {
                scope: scope.clone(),
                guard: None,
                prefix: "pending/".into(),
                after,
                limit: 64,
            })
            .await?;
        let records = page["records"]
            .as_array()
            .ok_or_else(|| err(503, "POLICY_SYNC_CORRUPT"))?;
        for record in records {
            let Some(path) = record["key"].as_str() else {
                continue;
            };
            let Some(workspace) = record["value"]["workspaceId"].as_str() else {
                continue;
            };
            let Some(key_id) = record["value"]["keyId"].as_str() else {
                continue;
            };
            let Some(target) = record["value"]["targetVersion"].as_u64() else {
                continue;
            };
            if record["value"]["regionId"] != region {
                continue;
            }
            let Ok(view) = self.keys.key(workspace, key_id).await else {
                continue;
            };
            if view.key_version < target {
                continue;
            }
            if let Some(expiry) = record["value"]["renewalExpiry"].as_i64()
                && self.clock.now().await? < expiry
                && self
                    .get(workspace, &format!("same-key-renewals/{key_id}/{target}"))
                    .await?
                    .is_none()
            {
                continue;
            }
            if self.grant(&view).await?.region_id != region
                || self.deliver(&view, None).await.is_err()
            {
                continue;
            }
            let _ = self
                .metadata
                .execute(MetaRequest::Commit {
                    scope: scope.clone(),
                    guard: None,
                    mutation_id: Uuid::new_v4().to_string(),
                    changes: vec![
                        json!({"key":path,"expectedVersion":record["version"],"delete":true}),
                    ],
                })
                .await;
        }
        let mut cursors = self.reconcile_cursors.lock().await;
        if let Some(next) = page["nextCursor"].as_str() {
            cursors.insert(region.into(), next.into());
        } else {
            cursors.remove(region);
        }
        Ok(())
    }
    async fn region_descriptor(
        &self,
        region: &str,
    ) -> workspace_contracts::Result<RegionDescriptor> {
        if let Some(hub) = &self.region_connection {
            return hub
                .descriptor(region)
                .await
                .ok_or_else(|| err(503, "REGION_UNAVAILABLE"));
        }
        self.config
            .regions
            .iter()
            .find(|item| item.region_id == region)
            .cloned()
            .ok_or_else(|| err(503, "REGION_UNAVAILABLE"))
    }
    async fn validate_local_guest_workspace(
        &self,
        workspace: &str,
    ) -> workspace_contracts::Result<()> {
        if let Some(local) = &self.local_guests {
            local.sessions.local_guest_expiry(workspace).await?;
        }
        Ok(())
    }
    fn owner_cookie_path(&self) -> &str {
        if self.config.shared_listener && self.config.local_workspace.is_none() {
            self.config
                .public_path
                .rsplit_once("/api/")
                .map(|(path, _)| path)
                .unwrap_or(&self.config.public_path)
        } else {
            &self.config.public_path
        }
    }
    fn allowed_origin(&self, origin: &str) -> bool {
        origin == self.config.public_origin
            || self
                .config
                .console_origins
                .iter()
                .any(|value| value == origin)
    }
    async fn deliver(
        &self,
        view: &KeyView,
        ceiling: Option<&Grant>,
    ) -> workspace_contracts::Result<PolicyReceipt> {
        let grant = self.grant(view).await?;
        let region = self
            .regional
            .get(&grant.region_id)
            .ok_or_else(|| err(409, "REGION_POLICY_NOT_APPLIED"))?;
        if view.key_version > 1024 {
            return Err(err(409, "POLICY_HISTORY_REQUIRES_RECONCILIATION"));
        }
        let mut final_receipt = None;
        for version in 1..=view.key_version {
            let marker = format!("policy-applied/{}/{version}", view.key_id);
            if version < view.key_version && self.get(&view.workspace_id, &marker).await?.is_some()
            {
                continue;
            }
            let key = self
                .keys
                .key_version(&view.workspace_id, &view.key_id, version)
                .await?;
            let snapshot = self.grant(&key).await?;
            if snapshot.region_id != grant.region_id {
                return Err(err(409, "REGION_POLICY_MISMATCH"));
            }
            let policy = KeyPolicy {
                workspace_id: key.workspace_id.clone(),
                region_id: snapshot.region_id.clone(),
                key_id: key.key_id.clone(),
                principal_id: key.principal_id.clone(),
                key_version: key.key_version,
                policy_generation: key.key_version,
                grant_ref: key.grant_ref.clone(),
                expires_at: key.expires_at,
                revoked: key.revoked,
            };
            let ceilings = if version == view.key_version {
                ceiling.into_iter().cloned().collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            let renewal: Option<workspace_identity::renewal::SameKeyRenewal> = self
                .get(
                    &view.workspace_id,
                    &format!("same-key-renewals/{}/{version}", view.key_id),
                )
                .await?
                .map(serde_json::from_value)
                .transpose()
                .map_err(|_| err(503, "RENEWAL_CORRUPT"))?;
            let value =
                json!({"policy":policy,"grant":snapshot,"ceilings":ceilings,"renewal":renewal});
            let fingerprint = Sha256::digest(
                serde_json::to_vec(&value).map_err(|_| err(503, "POLICY_UNAVAILABLE"))?,
            );
            let command_id =
                Uuid::from_bytes(fingerprint[..16].try_into().expect("SHA256 prefix")).to_string();
            self.immutable(
                &view.workspace_id,
                &format!("policy-deliveries/{command_id}"),
                value,
            )
            .await?;
            let command = region.policies.sign_transition(
                &policy,
                &command_id,
                self.clock.now().await?,
                Some(&snapshot),
                &ceilings,
                renewal.as_ref(),
            )?;
            let receipt = PolicyReceipt {
                continuity: None,
                command_id,
                workspace_id: key.workspace_id,
                region_id: snapshot.region_id,
                key_id: key.key_id,
                key_version: version,
                policy_generation: version,
            };
            let receipt = region.control.apply(&command, &receipt).await?;
            if let Some(continuity) = &receipt.continuity {
                self.immutable(
                    &view.workspace_id,
                    &format!("renewal-applied/{}/{version}", view.key_id),
                    json!(continuity),
                )
                .await?;
            }
            final_receipt = Some(receipt);
            self.immutable(
                &view.workspace_id,
                &marker,
                json!({"keyVersion":version,"regionId":grant.region_id}),
            )
            .await?;
        }
        final_receipt.ok_or_else(|| err(409, "REGION_POLICY_NOT_APPLIED"))
    }
    fn scope(&self, workspace: &str) -> Scope {
        Scope {
            authority_id: "global".into(),
            owner_kind: "workspace".into(),
            owner_id: workspace.into(),
            family: "global-public-api".into(),
            partition_id: "primary".into(),
        }
    }
    async fn get(&self, workspace: &str, key: &str) -> workspace_contracts::Result<Option<Value>> {
        let v = self
            .metadata
            .execute(MetaRequest::Get {
                scope: self.scope(workspace),
                guard: None,
                keys: vec![key.into()],
            })
            .await?;
        let r = v["records"]
            .get(key)
            .ok_or_else(|| err(503, "GLOBAL_RECORD_CORRUPT"))?;
        Ok(if r.is_null() {
            None
        } else {
            Some(r["value"].clone())
        })
    }
    async fn immutable(
        &self,
        workspace: &str,
        key: &str,
        value: Value,
    ) -> workspace_contracts::Result<()> {
        if let Some(old) = self.get(workspace, key).await? {
            return if old == value {
                Ok(())
            } else {
                Err(err(409, "GLOBAL_RECORD_CONFLICT"))
            };
        }
        let result = self
            .metadata
            .execute(MetaRequest::Commit {
                scope: self.scope(workspace),
                guard: None,
                mutation_id: Uuid::new_v4().to_string(),
                changes: vec![json!({"key":key,"expectedVersion":null,"value":value})],
            })
            .await;
        match result {
            Ok(_) => Ok(()),
            Err(e) => {
                if self.get(workspace, key).await?.as_ref() == Some(&value) {
                    Ok(())
                } else {
                    Err(e)
                }
            }
        }
    }
    async fn grant(&self, view: &KeyView) -> workspace_contracts::Result<Grant> {
        serde_json::from_value(
            self.get(&view.workspace_id, &format!("grants/{}", view.grant_ref))
                .await?
                .ok_or_else(|| err(503, "GRANT_UNAVAILABLE"))?,
        )
        .map_err(|_| err(503, "GRANT_CORRUPT"))
    }
    async fn owner(
        &self,
        workspace: &str,
        h: &HeaderMap,
        method: &Method,
    ) -> workspace_contracts::Result<AuthorizedOwner> {
        if h.contains_key(header::AUTHORIZATION) {
            return Err(err(403, "OWNER_REQUIRED"));
        }
        if ![Method::GET, Method::HEAD].contains(method)
            && !h
                .get(header::ORIGIN)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|origin| self.allowed_origin(origin))
        {
            return Err(err(403, "ORIGIN_REQUIRED"));
        }
        if let Some(local) = &self.local_guests
            && crate::regional_guest::RegionalGuest::has_cookie(h)
        {
            let guest = local.sessions.authenticate(h).await?;
            if guest.workspace_id != workspace && cookie(h, "aw_global_owner").is_none() {
                return Err(err(404, "NOT_FOUND"));
            }
            if guest.workspace_id == workspace {
                let workspace_domain::Credential::SessionOwner { id, expires_at, .. } =
                    guest.credential
                else {
                    return Err(err(401, "UNAUTHENTICATED"));
                };
                return Ok(AuthorizedOwner {
                    region_id: local.region.clone(),
                    principal_id: format!("local-guest-{id}"),
                    guest_expires_at: Some(expires_at),
                });
            }
        }
        let secret = cookie(h, "aw_global_owner").unwrap_or("");
        if let Some(local) = &self.config.local_workspace
            && local.workspace_id == workspace
            && secret.starts_with("glo_")
        {
            crate::global_local_sessions::authenticate(
                &self.metadata,
                workspace,
                secret,
                self.clock.now().await?,
            )
            .await?;
            return Ok(AuthorizedOwner {
                region_id: local.region_id.clone(),
                principal_id: format!("local-{:x}", Sha256::digest(workspace)),
                guest_expires_at: None,
            });
        }
        let owner = self.owners.authenticate(workspace, secret).await?;
        Ok(AuthorizedOwner {
            region_id: owner.assignment().region_id.clone(),
            principal_id: format!(
                "owner-{:x}",
                Sha256::digest(format!("{}\0{}", owner.issuer(), owner.subject()))
            ),
            guest_expires_at: None,
        })
    }
    async fn token_key(
        &self,
        workspace: &str,
        h: &HeaderMap,
        now: i64,
        discovery: bool,
    ) -> workspace_contracts::Result<(KeyView, Grant)> {
        let verified = self.verifier.verify(bearer(h)?, now)?;
        if verified.workspace_id() != workspace {
            return Err(err(404, "NOT_FOUND"));
        }
        self.validate_local_guest_workspace(workspace).await?;
        let view = self.keys.key(workspace, verified.key_id()).await?;
        if view.revoked
            || view.expires_at <= now
            || view.key_version != verified.key_version()
            || view.grant_ref != verified.grant_ref()
            || view.principal_id != verified.principal_id()
            || verified.expires_at() > view.expires_at
        {
            return Err(err(401, "INVALID_CREDENTIAL"));
        }
        if discovery && !verified.scopes().iter().any(|s| s == "resources:read") {
            return Err(err(403, "INSUFFICIENT_SCOPE"));
        }
        let grant = self.grant(&view).await?;
        Ok((view, grant))
    }
}
async fn receive(State(app): State<Arc<App>>, request: Request) -> Response {
    let console_origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .filter(|o| app.allowed_origin(o))
        .map(str::to_owned);
    let bearer_request = request.headers().contains_key(header::AUTHORIZATION);
    let response = match app.capacity.try_acquire() {
        Ok(_permit) => {
            match tokio::time::timeout(Duration::from_secs(20), dispatch(&app, request)).await {
                Ok(Ok(r)) => r,
                Ok(Err(e)) => crate::error(e),
                Err(_) => crate::error(err(503, "GLOBAL_OUTCOME_UNKNOWN")),
            }
        }
        Err(_) => crate::error(err(429, "GLOBAL_BUSY")),
    };
    let mut response = response;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    if let Some(origin) = console_origin {
        if let Ok(value) = origin.parse() {
            response
                .headers_mut()
                .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
        }
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
            header::HeaderValue::from_static("true"),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            header::HeaderValue::from_static("GET, POST, PATCH, DELETE, OPTIONS"),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            header::HeaderValue::from_static(
                "Authorization, Content-Type, If-Match, Idempotency-Key",
            ),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            header::HeaderValue::from_static("ETag, Location, X-Region-Id, X-Request-Id"),
        );
        response
            .headers_mut()
            .insert(header::VARY, header::HeaderValue::from_static("Origin"));
    }
    if !response.headers().contains_key("X-Request-Id") {
        response.headers_mut().insert(
            "X-Request-Id",
            Uuid::new_v4().to_string().parse().expect("UUID header"),
        );
    }
    if response.status() == StatusCode::UNAUTHORIZED && bearer_request {
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            header::HeaderValue::from_static("Bearer"),
        );
    }
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, header::HeaderValue::from_static("1"));
    }
    response
}
async fn dispatch(app: &App, request: Request) -> workspace_contracts::Result<Response> {
    let h = request.headers().clone();
    let method = request.method().clone();
    let raw_path = request.uri().path();
    let mut path = if !app.config.public_path.is_empty() {
        raw_path
            .strip_prefix(&app.config.public_path)
            .filter(|s| s.starts_with('/'))
            .or_else(|| {
                app.config
                    .public_path
                    .strip_suffix("/api/global")
                    .filter(|prefix| !prefix.is_empty())
                    .and_then(|prefix| raw_path.strip_prefix(prefix))
                    .filter(|s| s.starts_with("/api/"))
            })
            .unwrap_or(raw_path)
    } else {
        raw_path
    }
    .to_owned();
    let portal_request = path.starts_with("/api/portal/v1/");
    if let Some(tail) = path.strip_prefix("/api/portal/v1/") {
        if h.contains_key(header::AUTHORIZATION) {
            return Err(err(401, "PORTAL_SESSION_REQUIRED"));
        }
        path = format!("/api/v1/{tail}");
    }
    let host = h.get(header::HOST).and_then(|s| s.to_str().ok());
    let trusted_host = app.trusted_host_origins.iter().any(|value| {
        reqwest::Url::parse(value).ok().is_some_and(|origin| {
            let expected = match origin.port() {
                Some(port) => format!("{}:{port}", origin.host_str().unwrap_or_default()),
                None => origin.host_str().unwrap_or_default().to_owned(),
            };
            host == Some(expected.as_str())
        })
    });
    if !trusted_host {
        return Err(err(403, "HOST_DENIED"));
    }
    for name in [
        header::AUTHORIZATION,
        header::ORIGIN,
        header::COOKIE,
        header::CONTENT_TYPE,
        header::IF_MATCH,
        header::HeaderName::from_static("idempotency-key"),
        header::HOST,
    ] {
        if h.get_all(name).iter().count() > 1 {
            return Err(err(400, "DUPLICATE_HEADER"));
        }
    }
    if let Some(o) = h.get(header::ORIGIN)
        && !o
            .to_str()
            .ok()
            .is_some_and(|origin| app.allowed_origin(origin))
    {
        return Err(err(403, "ORIGIN_DENIED"));
    }
    if method == Method::OPTIONS && path.starts_with("/api/") {
        if !h
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|o| app.allowed_origin(o))
        {
            return Err(err(403, "ORIGIN_DENIED"));
        }
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let now = app.clock.now().await?;
    if path == "/api/openapi.json" && method == Method::GET {
        let mut schema: Value =
            serde_json::from_str(include_str!("../../../public/agent-entry-openapi.json"))
                .map_err(|_| err(503, "CONTRACT_UNAVAILABLE"))?;
        let prefix = app
            .config
            .public_path
            .strip_suffix("/api/global")
            .unwrap_or(&app.config.public_path);
        schema["servers"] = json!([{"url":format!("{}{prefix}/api",app.config.public_origin)}]);
        return Ok(Json(schema).into_response());
    }
    if path == "/openapi.json" && method == Method::GET {
        let mut schema: Value =
            serde_json::from_str(include_str!("../../../public/global-openapi.json"))
                .map_err(|_| err(503, "CONTRACT_UNAVAILABLE"))?;
        schema["servers"] =
            json!([{"url":format!("{}{}",app.config.public_origin,app.config.public_path)}]);
        return Ok(Json(schema).into_response());
    }
    let url = reqwest::Url::parse(&format!("http://localhost{}", request.uri()))
        .map_err(|_| err(400, "INVALID_PATH"))?;
    let mut query = BTreeMap::new();
    for (k, v) in url.query_pairs() {
        if query.insert(k.into_owned(), v.into_owned()).is_some() {
            return Err(err(400, "DUPLICATE_QUERY"));
        }
    }
    if path.starts_with("/analytics/") || path.starts_with("/operator/") {
        return analytics_routes::handle(app, &path, &method, &h, &query, request).await;
    }
    if path == "/api/health" && method == Method::GET {
        app.metadata.health().await?;
        return Ok(json_response(
            StatusCode::OK,
            json!({"status":"ok","authority":"global"}),
            None,
        ));
    }
    if path == "/api/session" && method == Method::POST {
        let local = app
            .config
            .local_workspace
            .as_ref()
            .ok_or_else(|| err(404, "NOT_FOUND"))?;
        let peer = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .ok_or_else(|| err(403, "PEER_REQUIRED"))?;
        if !peer.0.ip().is_loopback() {
            return Err(err(403, "LOCAL_SESSION_REQUIRED"));
        }
        if !h
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|origin| app.allowed_origin(origin))
        {
            return Err(err(403, "ORIGIN_REQUIRED"));
        }
        let secret =
            crate::global_local_sessions::issue(&app.metadata, &local.workspace_id, now).await?;
        let mut response = json_response(
            StatusCode::CREATED,
            json!({"workspaceId":local.workspace_id,"regionId":local.region_id}),
            None,
        );
        response.headers_mut().append(
            header::SET_COOKIE,
            format!(
                "aw_global_owner={secret}; HttpOnly; SameSite=Strict; Path={}/; Max-Age=28800",
                app.config.public_path
            )
            .parse()
            .map_err(|_| err(503, "SESSION_UNAVAILABLE"))?,
        );
        return Ok(response);
    }
    if path == "/api/auth/config" && method == Method::GET {
        return Ok(json_response(
            StatusCode::OK,
            json!({"mode":if app.config.local_workspace.is_some(){"local"}else{"oidc"},"loginPath":format!("{}/api/auth/tidbcloud/login",app.config.public_path),"localSessionPath":format!("{}/api/session",app.config.public_path)}),
            None,
        ));
    }
    if path == "/api/auth/session" && method == Method::GET {
        let workspace = query
            .get("workspaceId")
            .filter(|v| id(v))
            .ok_or_else(|| err(400, "WORKSPACE_REQUIRED"))?;
        let owner = app.owner(workspace, &h, &method).await?;
        return Ok(json_response(
            StatusCode::OK,
            json!({"workspaceId":workspace,"regionId":owner.region_id}),
            None,
        ));
    }
    if path.starts_with("/api/auth/") {
        return auth(
            app,
            &path,
            &method,
            &h,
            &query,
            request
                .extensions()
                .get::<ConnectInfo<SocketAddr>>()
                .map(|p| p.0),
        )
        .await;
    }
    let segments: Vec<_> = path.split('/').collect();
    let discovered = if path == "/api/v1/token-issuances" && method == Method::POST {
        Some(app.keys.authenticate_discovered(bearer(&h)?).await?)
    } else {
        None
    };
    let (workspace, rest): (&str, &[&str]) = if let Some(view) = &discovered {
        (&view.workspace_id, &["token-issuances"])
    } else {
        if segments.len() < 6 || segments[1..4] != ["api", "v1", "workspaces"] || !id(segments[4]) {
            return Err(err(404, "NOT_FOUND"));
        }
        (segments[4], &segments[5..])
    };
    if !portal_request && !h.contains_key(header::AUTHORIZATION) {
        return Err(err(401, "AGENT_TOKEN_REQUIRED"));
    }
    if method == Method::GET && rest == ["region-route"] {
        let (_, grant) = app.token_key(workspace, &h, now, false).await?;
        let descriptor = app.region_descriptor(&grant.region_id).await?;
        let mut response = StatusCode::TEMPORARY_REDIRECT.into_response();
        response.headers_mut().insert(
            header::LOCATION,
            format!("{}{}", descriptor.api_origin, descriptor.api_path_prefix)
                .parse()
                .map_err(|_| err(503, "REGION_UNAVAILABLE"))?,
        );
        response.headers_mut().insert(
            "X-Region-Id",
            descriptor
                .region_id
                .parse()
                .map_err(|_| err(503, "REGION_UNAVAILABLE"))?,
        );
        return Ok(response);
    }
    if method == Method::GET && rest == ["regions"] {
        let (_, grant) = app.token_key(workspace, &h, now, true).await?;
        let values = vec![app.region_descriptor(&grant.region_id).await?];
        return Ok(json_response(
            StatusCode::OK,
            json!({"data":values,"nextCursor":null}),
            None,
        ));
    }
    let bytes = to_bytes(request.into_body(), 32 * 1024)
        .await
        .map_err(|_| err(413, "BODY_TOO_LARGE"))?;
    if rest == ["token-issuances"] && method == Method::POST {
        let mut input: TokenInput = parse(&h, &bytes)?;
        let view = if let Some(view) = discovered.as_ref() {
            view.clone()
        } else {
            app.keys.authenticate(workspace, bearer(&h)?).await?
        };
        app.validate_local_guest_workspace(workspace).await?;
        let grant = app.grant(&view).await?;
        if discovered.is_some() && input.audience == "region" {
            input.audience.clone_from(&grant.region_id);
        }
        let scopes = input.scopes.unwrap_or(grant.scopes.clone());
        if scopes.is_empty() || scopes.iter().any(|s| !grant.permits_action(s)) {
            return Err(err(403, "SCOPE_NOT_GRANTED"));
        }
        if input.audience != "global" {
            if input.audience != grant.region_id {
                return Err(err(403, "REGION_NOT_GRANTED"));
            }
            let issuer = app
                .regional
                .get(&grant.region_id)
                .ok_or_else(|| err(409, "REGION_POLICY_NOT_APPLIED"))?;
            let thumbprint = input.client_thumbprint.as_deref();
            let mut ceiling = grant.clone();
            ceiling.scopes = scopes.clone();
            ceiling.scopes.sort();
            ceiling.scopes.dedup();
            ceiling.validate()?;
            app.deliver(&view, Some(&ceiling)).await?;
            let ceiling_ref = ceiling.reference()?;
            let now = app.clock.now().await?;
            let token = issuer.access.sign(
                &Issuance {
                    workspace_id: workspace,
                    principal_id: &view.principal_id,
                    key_id: &view.key_id,
                    key_version: view.key_version,
                    policy_generation: view.key_version,
                    grant_ref: &ceiling_ref,
                    scopes: &ceiling.scopes,
                    key_expires_at: view.expires_at,
                    grant_expires_at: view.expires_at,
                    family: None,
                },
                now,
            )?;
            app.immutable(workspace,&format!("issuances/{}",token.token_id),json!({"id":token.token_id,"keyId":view.key_id,"principalId":view.principal_id,"expiresAt":token.expires_at,"audience":input.audience,"status":"issued"})).await?;
            if app.keys.key(workspace, &view.key_id).await? != view
                || app.clock.now().await? >= token.expires_at
            {
                return Err(err(409, "ISSUANCE_OUTCOME_UNKNOWN"));
            }
            let descriptor = app.region_descriptor(&grant.region_id).await?;
            let mut response = json!({"id":token.token_id,"accessToken":token.token,"tokenType":"Bearer","expiresAt":token.expires_at,"scopes":ceiling.scopes,"keyId":view.key_id,"principalId":view.principal_id,"keyVersion":view.key_version,"region":descriptor});
            if discovered.is_some() {
                response["workspaceId"] = json!(workspace);
            }
            if let Some(thumbprint) = thumbprint {
                let ticket = issuer.tickets.sign(
                    &TicketIssuance {
                        workspace_id: workspace,
                        key_id: &view.key_id,
                        key_version: view.key_version,
                        policy_generation: view.key_version,
                        principal_id: &view.principal_id,
                        grant_ref: &view.grant_ref,
                        ceiling_ref: &ceiling_ref,
                        client_thumbprint: thumbprint,
                        key_expires_at: view.expires_at,
                    },
                    now,
                )?;
                response["enrollmentTicket"] = json!(ticket.ticket);
                response["enrollmentExpiresAt"] = json!(ticket.expires_at);
                response["nonce"] = json!(ticket.nonce);
            }
            let location = if discovered.is_some() {
                format!(
                    "{}/api/v1/workspaces/{workspace}/issuances/{}",
                    app.config
                        .public_path
                        .strip_suffix("/api/global")
                        .unwrap_or(&app.config.public_path),
                    token.token_id
                )
            } else {
                format!("token-issuances/{}", token.token_id)
            };
            return Ok(json_response(StatusCode::CREATED, response, Some(location)));
        }
        let token = app.signer.sign(
            &Issuance {
                workspace_id: workspace,
                principal_id: &view.principal_id,
                key_id: &view.key_id,
                key_version: view.key_version,
                policy_generation: view.key_version,
                grant_ref: &view.grant_ref,
                scopes: &scopes,
                key_expires_at: view.expires_at,
                grant_expires_at: view.expires_at,
                family: None,
            },
            now,
        )?;
        app.immutable(workspace,&format!("issuances/{}",token.token_id),json!({"id":token.token_id,"keyId":view.key_id,"principalId":view.principal_id,"expiresAt":token.expires_at,"audience":"global","status":"issued"})).await?;
        let current = app.keys.key(workspace, &view.key_id).await?;
        if current != view || app.clock.now().await? >= token.expires_at {
            return Err(err(409, "ISSUANCE_OUTCOME_UNKNOWN"));
        }
        let mut response = json!({"id":token.token_id,"accessToken":token.token,"tokenType":"Bearer","expiresAt":token.expires_at,"scopes":scopes});
        if discovered.is_some() {
            response["workspaceId"] = json!(workspace);
        }
        let location = if discovered.is_some() {
            format!(
                "{}/api/v1/workspaces/{workspace}/issuances/{}",
                app.config
                    .public_path
                    .strip_suffix("/api/global")
                    .unwrap_or(&app.config.public_path),
                token.token_id
            )
        } else {
            format!("token-issuances/{}", token.token_id)
        };
        return Ok(json_response(StatusCode::CREATED, response, Some(location)));
    }
    if rest.len() == 2
        && ["token-issuances", "issuances"].contains(&rest[0])
        && method == Method::GET
    {
        let (view, _) = app.token_key(workspace, &h, now, false).await?;
        let value = app
            .get(workspace, &format!("issuances/{}", rest[1]))
            .await?
            .filter(|v| {
                v["keyId"] == view.key_id && v["expiresAt"].as_i64().is_some_and(|t| t > now)
            })
            .ok_or_else(|| err(404, "NOT_FOUND"))?;
        return Ok(json_response(StatusCode::OK, json!({"data":value}), None));
    }
    let owner = app.owner(workspace, &h, &method).await?;
    match (method.as_str(), rest) {
        ("POST", ["regional-session-tickets"]) if portal_request => {
            let session = app
                .owners
                .authenticate(workspace, cookie(&h, "aw_global_owner").unwrap_or(""))
                .await?;
            let region = app.region_descriptor(&owner.region_id).await?;
            let ticket = app.portal_signer.issue(
                &owner.region_id,
                workspace,
                session.issuer(),
                session.subject(),
                app.clock.now().await?,
            )?;
            Ok(json_response(
                StatusCode::CREATED,
                json!({"ticket":ticket,"region":region,"expiresIn":60}),
                None,
            ))
        }
        ("POST", ["key-policy-deliveries"]) => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Delivery {
                key_id: String,
                key_version: u64,
            }
            let input: Delivery = parse(&h, &bytes)?;
            let operation = mutation(&h)?;
            let key = app.keys.key(workspace, &input.key_id).await?;
            if key.key_version != input.key_version {
                return Err(err(409, "KEY_VERSION_CONFLICT"));
            }
            let path = format!("policy-attempts/{operation}");
            app.immutable(
                workspace,
                &path,
                json!({"id":operation,"keyId":input.key_id,"keyVersion":input.key_version}),
            )
            .await?;
            // An explicit attempt may reconcile the same immutable command. GET never performs I/O.
            let delivered = app.deliver(&key, None).await;
            let applied = delivered.is_ok();
            let continuity = match delivered {
                Ok(receipt) => match receipt.continuity {
                    Some(crate::policy_command::ContinuityStatus::Eligible) => "eligible",
                    _ => "unavailable",
                },
                Err(_) => "pending",
            };
            Ok(json_response(
                StatusCode::CREATED,
                json!({"data":{"id":operation,"keyId":input.key_id,"keyVersion":input.key_version,"regionalStatus":if applied{"applied"}else{"pending"},"regionalContinuity":continuity}}),
                Some(format!("key-policy-deliveries/{operation}")),
            ))
        }
        ("GET", ["key-policy-deliveries", operation]) => {
            if Uuid::parse_str(operation).is_err() {
                return Err(err(404, "NOT_FOUND"));
            }
            let mut value = app
                .get(workspace, &format!("policy-attempts/{operation}"))
                .await?
                .ok_or_else(|| err(404, "NOT_FOUND"))?;
            let key = value["keyId"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| err(503, "DELIVERY_RECORD_CORRUPT"))?;
            let version = value["keyVersion"]
                .as_u64()
                .ok_or_else(|| err(503, "DELIVERY_RECORD_CORRUPT"))?;
            value["regionalStatus"] = json!(if app
                .get(workspace, &format!("policy-applied/{key}/{version}"))
                .await?
                .is_some()
            {
                "applied"
            } else {
                "pending"
            });
            value["regionalContinuity"] = app
                .get(workspace, &format!("renewal-applied/{key}/{version}"))
                .await?
                .unwrap_or_else(|| {
                    json!(if value["regionalStatus"] == "pending" {
                        "pending"
                    } else {
                        "unavailable"
                    })
                });
            Ok(json_response(StatusCode::OK, json!({"data":value}), None))
        }
        ("POST", ["keys"]) => {
            let mut input: CreateKey = parse(&h, &bytes)?;
            if let Some(expiry) = owner.guest_expires_at {
                input.expires_at = input.expires_at.min(expiry);
            }
            input.scopes.sort();
            input.scopes.dedup();
            input.resource_ids.sort();
            input.resource_ids.dedup();
            let allowed = [
                "resources:read",
                "resources:write",
                "queries:read",
                "queries:execute",
                "files:read",
                "files:write",
                "files:analyze",
                "usage:read",
            ];
            if input.scopes.is_empty()
                || input.scopes.len() > allowed.len()
                || input.scopes.iter().any(|s| !allowed.contains(&s.as_str()))
                || input.resource_ids.is_empty()
                || input.resource_ids.len() > 1024
                || input.resource_ids.iter().any(|r| r != "*" && !id(r))
                || input.resource_ids.len() > 1 && input.resource_ids.iter().any(|r| r == "*")
            {
                return Err(err(400, "INVALID_GRANTS"));
            }
            app.region_descriptor(&owner.region_id)
                .await
                .map_err(|_| err(409, "REGION_UNAVAILABLE"))?;
            let grant = Grant {
                scopes: input.scopes,
                resource_ids: input.resource_ids,
                region_id: owner.region_id.clone(),
            };
            let value = serde_json::to_value(&grant).map_err(|_| err(503, "GRANT_UNAVAILABLE"))?;
            let grant_ref = grant.reference()?;
            app.immutable(workspace, &format!("grants/{grant_ref}"), value)
                .await?;
            let mutation_id = mutation(&h)?;
            // Each independently scoped Key is a distinct agent actor. Keep the identity
            // deterministic for this Owner/Workspace/creation intent so replay stays fenced.
            let principal_id = format!(
                "agent-{:x}",
                Sha256::digest(format!(
                    "{}\0{workspace}\0{mutation_id}",
                    owner.principal_id
                ))
            );
            let key = app
                .keys
                .create(
                    &NewKey {
                        name: input.name,
                        workspace_id: workspace.into(),
                        principal_id,
                        grant_ref,
                        expires_at: input.expires_at,
                    },
                    &mutation_id,
                )
                .await?;
            app.mark_region_sync(
                &grant.region_id,
                workspace,
                &key.view.key_id,
                key.view.key_version,
                &mutation_id,
                None,
            )
            .await?;
            let status = if app.deliver(&key.view, None).await.is_ok() {
                "applied"
            } else {
                "pending"
            };
            Ok(etag(
                json_response(
                    StatusCode::CREATED,
                    json!({"data":key.view,"secret":key.secret,"grants":grant,"regionalStatus":status}),
                    Some(format!("keys/{}", key.view.key_id)),
                ),
                key.view.key_version,
            ))
        }
        ("GET", ["keys"]) => {
            let limit = query.get("limit").map_or(Ok(50), |s| {
                s.parse::<usize>()
                    .map_err(|_| err(400, "INVALID_PAGINATION"))
            })?;
            let page = app
                .keys
                .list(workspace, query.get("cursor").map(String::as_str), limit)
                .await?;
            let keys = page
                .data
                .iter()
                .flat_map(|k| {
                    [
                        format!("grants/{}", k.grant_ref),
                        format!("policy-applied/{}/{}", k.key_id, k.key_version),
                    ]
                })
                .collect();
            let records = if page.data.is_empty() {
                json!({"records":{}})
            } else {
                app.metadata
                    .execute(MetaRequest::Get {
                        scope: app.scope(workspace),
                        guard: None,
                        keys,
                    })
                    .await?
            };
            let mut data = Vec::with_capacity(page.data.len());
            for key in &page.data {
                let grant: Grant = serde_json::from_value(
                    records["records"][format!("grants/{}", key.grant_ref)]["value"].clone(),
                )
                .map_err(|_| err(503, "GRANT_CORRUPT"))?;
                grant.validate()?;
                if grant.reference()? != key.grant_ref {
                    return Err(err(503, "GRANT_CORRUPT"));
                }
                data.push(json!({"data":key,"grants":grant,"regionalStatus":if records["records"][format!("policy-applied/{}/{}",key.key_id,key.key_version)].is_null(){"pending"}else{"applied"}}));
            }
            Ok(json_response(
                StatusCode::OK,
                json!({"data":data,"nextCursor":page.next_cursor}),
                None,
            ))
        }
        ("GET", ["keys", key]) => {
            let key = app.keys.key(workspace, key).await?;
            let grant = app.grant(&key).await?;
            let status = if app
                .get(
                    workspace,
                    &format!("policy-applied/{}/{}", key.key_id, key.key_version),
                )
                .await?
                .is_some()
            {
                "applied"
            } else {
                "pending"
            };
            Ok(etag(
                json_response(
                    StatusCode::OK,
                    json!({"data":key,"grants":grant,"regionalStatus":status}),
                    None,
                ),
                key.key_version,
            ))
        }
        ("GET", ["keys", key, "versions", version]) => {
            let version = version.parse().map_err(|_| err(404, "NOT_FOUND"))?;
            let key = app.keys.key_version(workspace, key, version).await?;
            Ok(json_response(StatusCode::OK, json!({"data":key}), None))
        }
        ("PATCH", ["keys", key])
        | ("DELETE", ["keys", key])
        | ("POST", ["keys", key, "versions"]) => {
            let old = app.keys.key(workspace, key).await?;
            if h.get(header::IF_MATCH).and_then(|v| v.to_str().ok())
                != Some(format!("\"{}\"", old.key_version).as_str())
            {
                return Err(err(412, "PRECONDITION_FAILED"));
            }
            let operation = mutation(&h)?;
            if method == Method::PATCH {
                let update: Renewal = parse(&h, &bytes)?;
                if owner
                    .guest_expires_at
                    .is_some_and(|expiry| update.expires_at > expiry)
                {
                    return Err(err(400, "GUEST_EXPIRY_LIMIT"));
                }
                let region = app.grant(&old).await?.region_id;
                app.mark_region_sync(
                    &region,
                    workspace,
                    key,
                    old.key_version
                        .checked_add(1)
                        .ok_or_else(|| err(409, "KEY_VERSION_CONFLICT"))?,
                    &operation,
                    Some(old.expires_at),
                )
                .await?;
                let key = app
                    .keys
                    .renew(
                        workspace,
                        key,
                        old.key_version,
                        update.expires_at,
                        &operation,
                    )
                    .await?;
                let observed = app.clock.now().await?;
                if observed < old.expires_at {
                    let proof = workspace_identity::renewal::SameKeyRenewal {
                        from_version: old.key_version,
                        from_expires_at: old.expires_at,
                        global_observed_at: observed,
                    };
                    app.immutable(
                        workspace,
                        &format!("same-key-renewals/{}/{}", key.key_id, key.key_version),
                        json!(proof),
                    )
                    .await?;
                }
                let delivered = app.deliver(&key, None).await;
                let status = if delivered.is_ok() {
                    "applied"
                } else {
                    "pending"
                };
                let continuity = match delivered {
                    Ok(receipt) => match receipt.continuity {
                        Some(crate::policy_command::ContinuityStatus::Eligible) => "eligible",
                        _ => "unavailable",
                    },
                    Err(_) => "pending",
                };
                return Ok(etag(
                    json_response(
                        StatusCode::OK,
                        json!({"data":key,"regionalStatus":status,"regionalContinuity":continuity}),
                        None,
                    ),
                    key.key_version,
                ));
            }
            let region = app.grant(&old).await?.region_id;
            app.mark_region_sync(
                &region,
                workspace,
                key,
                old.key_version
                    .checked_add(1)
                    .ok_or_else(|| err(409, "KEY_VERSION_CONFLICT"))?,
                &operation,
                None,
            )
            .await?;
            if method == Method::DELETE {
                let key = app
                    .keys
                    .revoke(workspace, key, old.key_version, &operation)
                    .await?;
                app.immutable(workspace,&format!("revocations/{operation}"),json!({"id":operation,"keyId":key.key_id,"keyVersion":key.key_version,"regionalStatus":"pending"})).await?;
                let status = if app.deliver(&key, None).await.is_ok() {
                    "applied"
                } else {
                    "pending"
                };
                return Ok(json_response(
                    StatusCode::ACCEPTED,
                    json!({"id":operation,"regionalStatus":status}),
                    Some(format!("../key-revocations/{operation}")),
                ));
            }
            let issued = app
                .keys
                .rotate(workspace, key, old.key_version, &operation)
                .await?;
            let status = if app.deliver(&issued.view, None).await.is_ok() {
                "applied"
            } else {
                "pending"
            };
            Ok(etag(
                json_response(
                    StatusCode::CREATED,
                    json!({"data":issued.view,"secret":issued.secret,"regionalStatus":status}),
                    Some(format!("versions/{}", issued.view.key_version)),
                ),
                issued.view.key_version,
            ))
        }
        ("GET", ["key-revocations", operation]) => {
            let mut v = app
                .get(workspace, &format!("revocations/{operation}"))
                .await?
                .ok_or_else(|| err(404, "NOT_FOUND"))?;
            let key = v["keyId"]
                .as_str()
                .ok_or_else(|| err(503, "REVOCATION_CORRUPT"))?;
            let version = v["keyVersion"]
                .as_u64()
                .ok_or_else(|| err(503, "REVOCATION_CORRUPT"))?;
            v["regionalStatus"] = json!(if app
                .get(workspace, &format!("policy-applied/{key}/{version}"))
                .await?
                .is_some()
            {
                "applied"
            } else {
                "pending"
            });
            Ok(json_response(StatusCode::OK, json!({"data":v}), None))
        }
        _ => Err(err(404, "NOT_FOUND")),
    }
}
async fn auth(
    app: &App,
    path: &str,
    method: &Method,
    h: &HeaderMap,
    query: &BTreeMap<String, String>,
    peer: Option<SocketAddr>,
) -> workspace_contracts::Result<Response> {
    // Bundled Portal login owns one existing callback. Global may redirect the browser
    // there; it must not start another OIDC flow with another redirect URI.
    if app.config.shared_listener && app.config.local_workspace.is_none() && app.sso.is_none() {
        let portal = app
            .config
            .public_path
            .rsplit_once("/api/")
            .map(|(prefix, _)| prefix)
            .ok_or_else(|| err(503, "SSO_UNAVAILABLE"))?;
        if path == "/api/auth/tidbcloud/login" && *method == Method::GET {
            let mut response = StatusCode::SEE_OTHER.into_response();
            response.headers_mut().insert(
                header::LOCATION,
                format!(
                    "{portal}/api/auth/tidbcloud/login{}",
                    if query.get("operator").is_some_and(|v| v == "1") {
                        "?operator=1"
                    } else {
                        ""
                    }
                )
                .parse()
                .map_err(|_| err(503, "SSO_UNAVAILABLE"))?,
            );
            return Ok(response);
        }
    }
    if path == "/api/auth/tidbcloud/logout" && *method == Method::POST {
        let workspace = query
            .get("workspaceId")
            .filter(|s| id(s))
            .ok_or_else(|| err(400, "WORKSPACE_REQUIRED"))?;
        app.owner(workspace, h, method).await?;
        let secret = cookie(h, "aw_global_owner").unwrap_or_default();
        if secret.starts_with("glo_")
            && app
                .config
                .local_workspace
                .as_ref()
                .is_some_and(|w| w.workspace_id == *workspace)
        {
            crate::global_local_sessions::revoke(&app.metadata, workspace, secret).await?;
        } else {
            app.owners
                .revoke(workspace, secret, &Uuid::new_v4().to_string())
                .await?;
        }
        let secure = if app.config.public_origin.starts_with("https:") {
            " Secure;"
        } else {
            ""
        };
        let mut r = StatusCode::NO_CONTENT.into_response();
        r.headers_mut().append(
            header::SET_COOKIE,
            format!(
                "aw_global_owner=; HttpOnly; SameSite=Strict;{secure} Path={}/; Max-Age=0",
                app.owner_cookie_path()
            )
            .parse()
            .map_err(|_| err(503, "SESSION_UNAVAILABLE"))?,
        );
        return Ok(r);
    }
    let sso = app
        .sso
        .as_ref()
        .ok_or_else(|| err(503, "SSO_UNAVAILABLE"))?;
    let secure = if app.config.public_origin.starts_with("https:") {
        " Secure;"
    } else {
        ""
    };
    if path == "/api/auth/tidbcloud/login" && *method == Method::GET {
        let workspace = query.get("workspaceId").cloned();
        if workspace.as_ref().is_some_and(|s| !id(s))
            || (workspace.is_none()
                && (app.region_connection.is_none() || app.config.regions.len() != 1))
        {
            return Err(err(400, "WORKSPACE_REQUIRED"));
        }
        let (url, flow) = sso
            .login(
                &peer
                    .ok_or_else(|| err(403, "PEER_REQUIRED"))?
                    .ip()
                    .to_string(),
            )
            .await?;
        let mut flows = app.flows.lock().await;
        flows.retain(|_, flow| flow.expires > Instant::now());
        if flows.len() >= 1024 {
            return Err(err(429, "LOGIN_BUSY"));
        }
        let return_to = query
            .get("returnTo")
            .map(|value| -> workspace_contracts::Result<String> {
                let url = reqwest::Url::parse(value).map_err(|_| err(400, "INVALID_RETURN_URL"))?;
                if value.len() > 2048
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || !app.allowed_origin(&url.origin().ascii_serialization())
                {
                    return Err(err(400, "INVALID_RETURN_URL"));
                }
                Ok(url.to_string())
            })
            .transpose()?;
        flows.insert(
            flow.clone(),
            LoginFlow {
                workspace,
                return_to,
                expires: Instant::now() + Duration::from_secs(600),
            },
        );
        let mut r = StatusCode::SEE_OTHER.into_response();
        r.headers_mut().insert(
            header::LOCATION,
            url.parse().map_err(|_| err(503, "SSO_UNAVAILABLE"))?,
        );
        r.headers_mut().append(header::SET_COOKIE,format!("aw_global_flow={flow}; HttpOnly; SameSite=Lax;{secure} Path={}/api/auth/tidbcloud; Max-Age=600",app.config.public_path).parse().map_err(|_|err(503,"SSO_UNAVAILABLE"))?);
        if query.get("operator").is_some_and(|v| v == "1") {
            r.headers_mut().append(header::SET_COOKIE,format!("aw_operator_flow={flow}; HttpOnly; SameSite=Lax;{secure} Path={}/api/auth/tidbcloud; Max-Age=600",app.config.public_path).parse().map_err(|_|err(503,"SSO_UNAVAILABLE"))?);
        }
        return Ok(r);
    }
    if path == "/api/auth/tidbcloud/callback" && *method == Method::GET {
        let flow = cookie(h, "aw_global_flow").ok_or_else(|| err(401, "SSO_STATE_INVALID"))?;
        let login_flow = app
            .flows
            .lock()
            .await
            .remove(flow)
            .ok_or_else(|| err(401, "SSO_STATE_INVALID"))?;
        if login_flow.expires <= Instant::now() {
            return Err(err(401, "SSO_STATE_INVALID"));
        }
        let login = sso.callback(flow, query).await?;
        if cookie(h, "aw_operator_flow") == Some(flow) {
            let operators = app
                .operators
                .as_ref()
                .ok_or_else(|| err(404, "OPERATOR_UNAVAILABLE"))?;
            let session = operators.establish(&login).await?;
            let mut response = StatusCode::SEE_OTHER.into_response();
            response.headers_mut().insert(
                header::LOCATION,
                operators
                    .return_url()
                    .parse()
                    .map_err(|_| err(503, "OPERATOR_UNAVAILABLE"))?,
            );
            response.headers_mut().append(header::SET_COOKIE, session);
            return Ok(response);
        }
        let (issuer, subject) = login.identity();
        let workspace = if let Some(workspace) = login_flow.workspace {
            workspace
        } else {
            let hub = app
                .region_connection
                .clone()
                .ok_or_else(|| err(503, "REGION_UNAVAILABLE"))?;
            let region = &app
                .config
                .regions
                .first()
                .ok_or_else(|| err(503, "REGION_UNAVAILABLE"))?
                .region_id;
            app.region_descriptor(region).await?;
            let directory = workspace_identity::Directory::open(app.metadata.clone()).await?;
            workspace_identity::onboarding::Onboarding::new(
                directory,
                Arc::new(crate::region_connection::RemoteRegion(hub)),
            )
            .personal(VerifiedIdentity { issuer, subject }, region)
            .await?
            .workspace_id
        };
        let session = app
            .owners
            .issue(
                VerifiedIdentity { issuer, subject },
                &workspace,
                &Uuid::new_v4().to_string(),
            )
            .await?;
        if let Some(store) = &app.analytics {
            store.record(
                &Uuid::new_v4().to_string(),
                &workspace,
                "account",
                "sign_in_completed",
                true,
            );
        }
        app.attribute_trial(h, &workspace, &session.assignment.region_id)
            .await;
        let mut r = json_response(
            StatusCode::OK,
            json!({"workspaceId":workspace,"regionId":session.assignment.region_id,"expiresAt":session.expires_at}),
            None,
        );
        if let Some(return_to) = login_flow.return_to {
            let mut target =
                reqwest::Url::parse(&return_to).map_err(|_| err(400, "INVALID_RETURN_URL"))?;
            let retained = target
                .query_pairs()
                .filter(|(key, _)| key != "portal_workspace")
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect::<Vec<_>>();
            target
                .query_pairs_mut()
                .clear()
                .extend_pairs(retained)
                .append_pair("portal_workspace", &workspace);
            *r.status_mut() = StatusCode::SEE_OTHER;
            r.headers_mut().insert(
                header::LOCATION,
                target
                    .as_str()
                    .parse()
                    .map_err(|_| err(400, "INVALID_RETURN_URL"))?,
            );
        }
        r.headers_mut().append(
            header::SET_COOKIE,
            format!(
                "aw_global_owner={}; HttpOnly; SameSite=Strict;{secure} Path={}/; Max-Age=28800",
                session.secret,
                app.owner_cookie_path()
            )
            .parse()
            .map_err(|_| err(503, "SESSION_UNAVAILABLE"))?,
        );
        r.headers_mut().append(header::SET_COOKIE,format!("aw_global_flow=; HttpOnly; SameSite=Lax;{secure} Path={}/api/auth/tidbcloud; Max-Age=0",app.config.public_path).parse().map_err(|_|err(503,"SESSION_UNAVAILABLE"))?);
        return Ok(r);
    }
    Err(err(404, "NOT_FOUND"))
}

fn default_key_name() -> String {
    "Agent key".into()
}
