//! Independent Global public management API. Data-plane operations have no routes here.
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
    global_owner_sessions::{OwnerSession, OwnerSessions},
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
    pub bind: SocketAddr,
    pub metadata: MetaBinding,
    pub public_origin: String,
    pub environment: String,
    pub signer_id: String,
    pub signing_key_file: PathBuf,
    pub verification_key_file: PathBuf,
    pub clock_directory: PathBuf,
    #[serde(default)]
    pub initialize_clock: bool,
    pub regions: Vec<RegionDescriptor>,
    pub sso: Option<sso::Config>,
    #[serde(default)]
    pub region_controls: Vec<RegionControlConfig>,
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
        let url = sso::endpoint(&self.public_origin, local)?;
        ensure!(
            url.origin().ascii_serialization() == self.public_origin,
            "Canonical Global origin required"
        );
        ensure!(
            id(&self.environment) && id(&self.signer_id),
            "Explicit signer/environment required"
        );
        ensure!(
            self.signing_key_file.is_absolute()
                && self.verification_key_file.is_absolute()
                && self.clock_directory.is_absolute(),
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
            sso.validate("", local)?;
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
    control: PolicyControlClient,
    policies: PolicyCommandSigner,
    access: AccessSigner,
    tickets: TicketSigner,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateKey {
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
struct App {
    config: Config,
    metadata: Arc<dyn Metadata>,
    keys: GlobalKeys,
    owners: OwnerSessions,
    signer: AccessSigner,
    verifier: AccessVerifier,
    clock: Clock,
    sso: Option<sso::Runtime>,
    flows: Mutex<BTreeMap<String, (String, Instant)>>,
    capacity: Semaphore,
    regional: BTreeMap<String, RegionIssuer>,
}
pub struct GlobalServer {
    listener: TcpListener,
    app: Arc<App>,
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
    pub async fn open(config: Config, metadata: Arc<dyn Metadata>) -> Result<Self> {
        config.validate()?;
        let key = private_file(&config.signing_key_file)?;
        let public = String::from_utf8(private_file(&config.verification_key_file)?)?;
        let public: [u8; 32] = hex_bytes(public.trim())?;
        let signer = AccessSigner::new(
            SigningConfig {
                issuer: config.public_origin.clone(),
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
            issuer: config.public_origin.clone(),
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
        let mut regional = BTreeMap::new();
        for control in &config.region_controls {
            ensure!(
                config
                    .regions
                    .iter()
                    .any(|r| r.region_id == control.region_id)
                    && !regional.contains_key(&control.region_id),
                "Invalid Region control selection"
            );
            regional.insert(
                control.region_id.clone(),
                RegionIssuer {
                    control: PolicyControlClient::new(
                        &control.origin,
                        &control.region_id,
                        control.tls.clone(),
                    )?,
                    policies: PolicyCommandSigner::new(
                        PolicySignerConfig {
                            issuer: config.public_origin.clone(),
                            audience: format!("{}/control", control.region_id),
                            environment: config.environment.clone(),
                            region_id: control.region_id.clone(),
                            key_id: config.signer_id.clone(),
                        },
                        &key,
                    )?,
                    access: AccessSigner::new(
                        SigningConfig {
                            issuer: config.public_origin.clone(),
                            audience: format!("{}/audience", control.region_id),
                            environment: config.environment.clone(),
                            region: Some(control.region_id.clone()),
                            key_id: config.signer_id.clone(),
                            max_lifetime: 900,
                            issuer_kind: IssuerKind::Global,
                        },
                        &key,
                    )?,
                    tickets: TicketSigner::from_pkcs8(
                        TicketSigningConfig {
                            issuer: config.public_origin.clone(),
                            audience: format!("{}/enrollment", control.region_id),
                            environment: config.environment.clone(),
                            region_id: control.region_id.clone(),
                            key_id: config.signer_id.clone(),
                        },
                        &key,
                    )?,
                },
            );
        }
        let clock = Clock::open(&config.clock_directory, config.initialize_clock)?;
        clock.now()?;
        let owners = OwnerSessions::open(metadata.clone()).await?;
        let keys = GlobalKeys::open(metadata.clone()).await?;
        let sso = config.sso.clone().map(sso::Runtime::new).transpose()?;
        let listener = TcpListener::bind(config.bind).await?;
        Ok(Self {
            listener,
            app: Arc::new(App {
                config,
                metadata,
                keys,
                owners,
                signer,
                verifier,
                clock,
                sso,
                flows: Mutex::new(BTreeMap::new()),
                capacity: Semaphore::new(16),
                regional,
            }),
        })
    }
    pub async fn serve(
        self,
        stop: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> Result<()> {
        axum::serve(
            self.listener,
            Router::new()
                .fallback(any(receive))
                .with_state(self.app)
                .into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(stop)
        .await?;
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
                self.clock.now()?,
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
    ) -> workspace_contracts::Result<OwnerSession> {
        if h.contains_key(header::AUTHORIZATION) {
            return Err(err(403, "OWNER_REQUIRED"));
        }
        if ![Method::GET, Method::HEAD].contains(method)
            && h.get(header::ORIGIN).and_then(|v| v.to_str().ok())
                != Some(&self.config.public_origin)
        {
            return Err(err(403, "ORIGIN_REQUIRED"));
        }
        self.owners
            .authenticate(workspace, cookie(h, "aw_global_owner").unwrap_or(""))
            .await
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
    let path = request.uri().path().to_owned();
    let origin = reqwest::Url::parse(&app.config.public_origin)
        .map_err(|_| err(503, "GLOBAL_CONFIG_INVALID"))?;
    let host = match origin.port() {
        Some(port) => format!("{}:{port}", origin.host_str().unwrap_or_default()),
        None => origin.host_str().unwrap_or_default().to_owned(),
    };
    if h.get(header::HOST).and_then(|s| s.to_str().ok()) != Some(&host) {
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
        && o.to_str().ok() != Some(&app.config.public_origin)
    {
        return Err(err(403, "ORIGIN_DENIED"));
    }
    let now = app.clock.now()?;
    if path == "/openapi.json" && method == Method::GET {
        return Ok((
            [(header::CONTENT_TYPE, "application/json")],
            include_str!("../../../public/global-openapi.json"),
        )
            .into_response());
    }
    let url = reqwest::Url::parse(&format!("http://localhost{}", request.uri()))
        .map_err(|_| err(400, "INVALID_PATH"))?;
    let mut query = BTreeMap::new();
    for (k, v) in url.query_pairs() {
        if query.insert(k.into_owned(), v.into_owned()).is_some() {
            return Err(err(400, "DUPLICATE_QUERY"));
        }
    }
    if path == "/api/health" && method == Method::GET {
        app.metadata.health().await?;
        return Ok(json_response(
            StatusCode::OK,
            json!({"status":"ok","authority":"global"}),
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
    if segments.len() < 6 || segments[1..4] != ["api", "v1", "workspaces"] || !id(segments[4]) {
        return Err(err(404, "NOT_FOUND"));
    }
    let workspace = segments[4];
    let rest = &segments[5..];
    if method == Method::GET && rest == ["regions"] {
        let (_, grant) = app.token_key(workspace, &h, now, true).await?;
        let values: Vec<_> = app
            .config
            .regions
            .iter()
            .filter(|r| r.region_id == grant.region_id)
            .collect();
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
        let input: TokenInput = parse(&h, &bytes)?;
        let view = app.keys.authenticate(workspace, bearer(&h)?).await?;
        let grant = app.grant(&view).await?;
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
            let thumbprint = input
                .client_thumbprint
                .as_deref()
                .ok_or_else(|| err(400, "CLIENT_BINDING_REQUIRED"))?;
            let mut ceiling = grant.clone();
            ceiling.scopes = scopes.clone();
            ceiling.scopes.sort();
            ceiling.scopes.dedup();
            ceiling.validate()?;
            app.deliver(&view, Some(&ceiling)).await?;
            let ceiling_ref = ceiling.reference()?;
            let now = app.clock.now()?;
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
                || app.clock.now()? >= token.expires_at
            {
                return Err(err(409, "ISSUANCE_OUTCOME_UNKNOWN"));
            }
            let descriptor = app
                .config
                .regions
                .iter()
                .find(|r| r.region_id == grant.region_id)
                .ok_or_else(|| err(503, "REGION_UNAVAILABLE"))?;
            return Ok(json_response(
                StatusCode::CREATED,
                json!({"id":token.token_id,"accessToken":token.token,"tokenType":"Bearer","expiresAt":token.expires_at,"scopes":ceiling.scopes,"keyId":view.key_id,"principalId":view.principal_id,"keyVersion":view.key_version,"region":descriptor,"enrollmentTicket":ticket.ticket,"enrollmentExpiresAt":ticket.expires_at,"nonce":ticket.nonce}),
                Some(format!("token-issuances/{}", token.token_id)),
            ));
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
        if current != view || app.clock.now()? >= token.expires_at {
            return Err(err(409, "ISSUANCE_OUTCOME_UNKNOWN"));
        }
        return Ok(json_response(
            StatusCode::CREATED,
            json!({"id":token.token_id,"accessToken":token.token,"tokenType":"Bearer","expiresAt":token.expires_at,"scopes":scopes}),
            Some(format!("token-issuances/{}", token.token_id)),
        ));
    }
    if rest.len() == 2 && rest[0] == "token-issuances" && method == Method::GET {
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
            if !app
                .config
                .regions
                .iter()
                .any(|r| r.region_id == owner.assignment().region_id)
            {
                return Err(err(409, "REGION_UNAVAILABLE"));
            }
            let grant = Grant {
                scopes: input.scopes,
                resource_ids: input.resource_ids,
                region_id: owner.assignment().region_id.clone(),
            };
            let value = serde_json::to_value(&grant).map_err(|_| err(503, "GRANT_UNAVAILABLE"))?;
            let grant_ref = grant.reference()?;
            app.immutable(workspace, &format!("grants/{grant_ref}"), value)
                .await?;
            let principal_id = format!(
                "owner-{:x}",
                Sha256::digest(format!("{}\0{}", owner.issuer(), owner.subject()))
            );
            let key = app
                .keys
                .create(
                    &NewKey {
                        workspace_id: workspace.into(),
                        principal_id,
                        grant_ref,
                        expires_at: input.expires_at,
                    },
                    &mutation(&h)?,
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
            Ok(json_response(StatusCode::OK, json!(page), None))
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
                let observed = app.clock.now()?;
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
    if path == "/api/auth/tidbcloud/logout" && *method == Method::POST {
        let workspace = query
            .get("workspaceId")
            .filter(|s| id(s))
            .ok_or_else(|| err(400, "WORKSPACE_REQUIRED"))?;
        app.owner(workspace, h, method).await?;
        app.owners
            .revoke(
                workspace,
                cookie(h, "aw_global_owner").unwrap_or_default(),
                &Uuid::new_v4().to_string(),
            )
            .await?;
        let secure = if app.config.public_origin.starts_with("https:") {
            " Secure;"
        } else {
            ""
        };
        let mut r = StatusCode::NO_CONTENT.into_response();
        r.headers_mut().append(
            header::SET_COOKIE,
            format!("aw_global_owner=; HttpOnly; SameSite=Strict;{secure} Path=/; Max-Age=0")
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
        let workspace = query
            .get("workspaceId")
            .filter(|s| id(s))
            .ok_or_else(|| err(400, "WORKSPACE_REQUIRED"))?;
        let (url, flow) = sso
            .login(
                &peer
                    .ok_or_else(|| err(403, "PEER_REQUIRED"))?
                    .ip()
                    .to_string(),
            )
            .await?;
        let mut flows = app.flows.lock().await;
        flows.retain(|_, (_, expiry)| *expiry > Instant::now());
        if flows.len() >= 1024 {
            return Err(err(429, "LOGIN_BUSY"));
        }
        flows.insert(
            flow.clone(),
            (workspace.into(), Instant::now() + Duration::from_secs(600)),
        );
        let mut r = StatusCode::SEE_OTHER.into_response();
        r.headers_mut().insert(
            header::LOCATION,
            url.parse().map_err(|_| err(503, "SSO_UNAVAILABLE"))?,
        );
        r.headers_mut().append(header::SET_COOKIE,format!("aw_global_flow={flow}; HttpOnly; SameSite=Lax;{secure} Path=/api/auth/tidbcloud; Max-Age=600").parse().map_err(|_|err(503,"SSO_UNAVAILABLE"))?);
        return Ok(r);
    }
    if path == "/api/auth/tidbcloud/callback" && *method == Method::GET {
        let flow = cookie(h, "aw_global_flow").ok_or_else(|| err(401, "SSO_STATE_INVALID"))?;
        let (workspace, expiry) = app
            .flows
            .lock()
            .await
            .remove(flow)
            .ok_or_else(|| err(401, "SSO_STATE_INVALID"))?;
        if expiry <= Instant::now() {
            return Err(err(401, "SSO_STATE_INVALID"));
        }
        let login = sso.callback(flow, query).await?;
        let (issuer, subject) = login.identity();
        let session = app
            .owners
            .issue(
                VerifiedIdentity { issuer, subject },
                &workspace,
                &Uuid::new_v4().to_string(),
            )
            .await?;
        let mut r = json_response(
            StatusCode::OK,
            json!({"workspaceId":workspace,"regionId":session.assignment.region_id,"expiresAt":session.expires_at}),
            None,
        );
        r.headers_mut().append(
            header::SET_COOKIE,
            format!(
                "aw_global_owner={}; HttpOnly; SameSite=Strict;{secure} Path=/; Max-Age=28800",
                session.secret
            )
            .parse()
            .map_err(|_| err(503, "SESSION_UNAVAILABLE"))?,
        );
        r.headers_mut().append(header::SET_COOKIE,format!("aw_global_flow=; HttpOnly; SameSite=Lax;{secure} Path=/api/auth/tidbcloud; Max-Age=0").parse().map_err(|_|err(503,"SESSION_UNAVAILABLE"))?);
        return Ok(r);
    }
    Err(err(404, "NOT_FOUND"))
}
