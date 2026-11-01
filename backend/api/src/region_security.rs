//! Single-writer Region security integration. No Global client or callback exists here.
use crate::{
    access_signer::{AccessSigner, Family, Issuance, SigningConfig},
    policy_command::{ContinuityStatus, PolicyCommandVerifier, PolicyReceipt, PolicyTrust},
    policy_transport::{PolicyControlServer, PolicyInstaller, ServerTls},
    security_clock::Clock,
    signed_access::{AccessTrust, AccessVerifier, IssuerKind, VerifiedAccess},
};
use axum::{
    Json,
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    future::Future,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
};
use tokio::sync::{OwnedRwLockReadGuard, RwLock};
use uuid::Uuid;
use workspace_contracts::{MetaRequest, Metadata, Result, Scope, ServiceError};
use workspace_domain::{Credential, Principal, ScopedAuthorization, Workspace};
use workspace_identity::{
    enrollment_ticket::{TicketTrust, TicketVerifier},
    regional_key_policy::{KeyPolicies, KeyPolicy, VerifiedKeyBinding},
    regional_refresh::{FamilyBinding, RefreshFamilies, RefreshRequest, RegionalClock},
};
use workspace_meta_client::private_file;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub public_origin: String,
    pub environment: String,
    pub global_issuer: String,
    pub global_signer_id: String,
    pub global_public_key_file: PathBuf,
    pub regional_signer_id: String,
    pub regional_signing_key_file: PathBuf,
    pub regional_public_key_file: PathBuf,
    pub clock_directory: PathBuf,
    #[serde(default)]
    pub initialize_clock: bool,
    pub control: ServerTls,
    #[serde(default = "default_ttl")]
    pub access_token_ttl: i64,
}
fn default_ttl() -> i64 {
    900
}
fn error(status: u16, code: &str) -> ServiceError {
    ServiceError::new(status, code)
}
fn public(path: &Path) -> anyhow::Result<[u8; 32]> {
    let text = String::from_utf8(private_file(path)?)?;
    let s = text.trim();
    anyhow::ensure!(
        s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid public key"
    );
    let mut v = [0; 32];
    for (i, b) in v.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)?;
    }
    Ok(v)
}
impl RegionalClock for Clock {
    fn now(&self) -> Result<i64> {
        self.now()
    }
}
impl crate::policy_transport::TrustedRegionalClock for Clock {
    fn now(&self) -> Result<i64> {
        self.now()
    }
}
fn renewal_witness_path(
    directory: &Path,
    region: &str,
    workspace: &str,
    key: &str,
    version: u64,
) -> PathBuf {
    directory.join(format!(
        "renewal-{:x}-{version}",
        Sha256::digest(format!("{region}\0{workspace}\0{key}"))
    ))
}
fn renewal_digest(
    policy: &KeyPolicy,
    proof: &workspace_identity::renewal::SameKeyRenewal,
) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!([policy, proof]))
                .map_err(|_| error(503, "RENEWAL_CORRUPT"))?
        )
    ))
}
fn witness_valid(
    directory: &Path,
    policy: &KeyPolicy,
    proof: &workspace_identity::renewal::SameKeyRenewal,
) -> Result<bool> {
    let path = renewal_witness_path(
        directory,
        &policy.region_id,
        &policy.workspace_id,
        &policy.key_id,
        policy.key_version,
    );
    if !path.exists() {
        return Ok(false);
    }
    let value: Value = serde_json::from_slice(
        &private_file(&path).map_err(|_| error(503, "RENEWAL_WITNESS_UNAVAILABLE"))?,
    )
    .map_err(|_| error(503, "RENEWAL_WITNESS_CORRUPT"))?;
    if value["digest"] != renewal_digest(policy, proof)?
        || value["observedAt"]
            .as_i64()
            .is_none_or(|t| t <= 0 || t >= proof.from_expires_at)
    {
        return Err(error(503, "RENEWAL_WITNESS_CORRUPT"));
    }
    Ok(true)
}
struct InstalledRenewals {
    metadata: Arc<dyn Metadata>,
    directory: PathBuf,
    region: String,
}
impl workspace_identity::regional_refresh::ContinuityVerifier for InstalledRenewals {
    fn check<'a>(
        &'a self,
        workspace: &'a str,
        key: &'a str,
        from_version: u64,
        from_expiry: i64,
        principal: &'a str,
        current: &'a KeyPolicy,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let denied = || error(401, "REAUTHENTICATION_REQUIRED");
            if from_version >= current.key_version
                || current.key_version - from_version > 1024
                || current.workspace_id != workspace
                || current.key_id != key
                || current.principal_id != principal
                || current.region_id != self.region
                || current.revoked
            {
                return Err(denied());
            }
            let mut expiry = from_expiry;
            let mut previous: Option<KeyPolicy> = None;
            for version in (from_version + 1)..=current.key_version {
                let path = format!("renewals/{version}");
                let scope = Scope {
                    authority_id: self.region.clone(),
                    owner_kind: "workspace".into(),
                    owner_id: workspace.into(),
                    family: "regional-key-policy".into(),
                    partition_id: key.into(),
                };
                let result = self
                    .metadata
                    .execute(MetaRequest::Get {
                        scope,
                        guard: None,
                        keys: vec![path.clone()],
                    })
                    .await?;
                let value = &result["records"][&path]["value"];
                let prior: KeyPolicy =
                    serde_json::from_value(value["prior"].clone()).map_err(|_| denied())?;
                let next: KeyPolicy =
                    serde_json::from_value(value["policy"].clone()).map_err(|_| denied())?;
                let proof: workspace_identity::renewal::SameKeyRenewal =
                    serde_json::from_value(value["proof"].clone()).map_err(|_| denied())?;
                proof.validate(&prior, &next).map_err(|_| denied())?;
                if prior.key_version != version - 1
                    || prior.expires_at != expiry
                    || prior.principal_id != principal
                    || next.grant_ref != current.grant_ref
                    || next.workspace_id != workspace
                    || next.region_id != self.region
                    || next.key_id != key
                    || previous.as_ref().is_some_and(|p| p != &prior)
                    || !witness_valid(&self.directory, &next, &proof)?
                {
                    return Err(denied());
                }
                expiry = next.expires_at;
                previous = Some(next);
            }
            if previous.as_ref() != Some(current) {
                return Err(denied());
            }
            Ok(())
        })
    }
}

pub struct Runtime {
    config: Config,
    workspace: Arc<Workspace>,
    metadata: Arc<dyn Metadata>,
    region: String,
    public_path: String,
    clock: Arc<Clock>,
    policies: Arc<KeyPolicies>,
    families: RefreshFamilies,
    tickets: TicketVerifier,
    global: AccessVerifier,
    local: AccessVerifier,
    signer: AccessSigner,
    control_verifier: Arc<PolicyCommandVerifier>,
    gate: Arc<RwLock<()>>,
}
impl Runtime {
    pub async fn open(
        config: Config,
        workspace: Arc<Workspace>,
        metadata: Arc<dyn Metadata>,
        region: &str,
        public_path: &str,
        loopback: bool,
    ) -> anyhow::Result<Arc<Self>> {
        let origin = crate::sso::endpoint(&config.public_origin, loopback)?;
        anyhow::ensure!(
            origin.origin().ascii_serialization() == config.public_origin,
            "Canonical Region origin required"
        );
        crate::sso::endpoint(&config.global_issuer, loopback)?;
        let global = public(&config.global_public_key_file)?;
        let local = public(&config.regional_public_key_file)?;
        anyhow::ensure!(
            global != local,
            "Global and Region signer keys must be independent"
        );
        let trust = |issuer: String, kind: IssuerKind, key: String, public: [u8; 32]| {
            AccessVerifier::new(AccessTrust {
                issuer,
                audience: format!("{region}/audience"),
                environment: config.environment.clone(),
                region: Some(region.into()),
                max_lifetime: 900,
                issuer_kind: kind,
                keys: BTreeMap::from([(key, public)]),
            })
        };
        let global_verifier = trust(
            config.global_issuer.clone(),
            IssuerKind::Global,
            config.global_signer_id.clone(),
            global,
        )?;
        let local_verifier = trust(
            config.public_origin.clone(),
            IssuerKind::Region,
            config.regional_signer_id.clone(),
            local,
        )?;
        anyhow::ensure!(
            (1..=900).contains(&config.access_token_ttl),
            "Invalid regional token lifetime"
        );
        let signer = AccessSigner::new(
            SigningConfig {
                issuer: config.public_origin.clone(),
                audience: format!("{region}/audience"),
                environment: config.environment.clone(),
                region: Some(region.into()),
                key_id: config.regional_signer_id.clone(),
                max_lifetime: config.access_token_ttl,
                issuer_kind: IssuerKind::Region,
            },
            &private_file(&config.regional_signing_key_file)?,
        )?;
        let now = chrono::Utc::now().timestamp();
        let scopes = vec!["resources:read".into()];
        let sample = signer.sign(
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
                family: Some(Family {
                    id: &Uuid::new_v4().to_string(),
                    epoch: 1,
                    expires_at: now + 1,
                }),
            },
            now,
        )?;
        local_verifier.verify(&sample.token, now)?;
        let clock = Arc::new(Clock::open(
            &config.clock_directory,
            config.initialize_clock,
        )?);
        clock.now()?;
        let policies = Arc::new(KeyPolicies::open(metadata.clone(), region).await?);
        let tickets = TicketTrust {
            issuer: config.global_issuer.clone(),
            audience: format!("{region}/enrollment"),
            environment: config.environment.clone(),
            region_id: region.into(),
            keys: BTreeMap::from([(config.global_signer_id.clone(), global)]),
        };
        let ticket_verifier = TicketVerifier::new(TicketTrust {
            issuer: config.global_issuer.clone(),
            audience: format!("{region}/enrollment"),
            environment: config.environment.clone(),
            region_id: region.into(),
            keys: BTreeMap::from([(config.global_signer_id.clone(), global)]),
        })?;
        let families = RefreshFamilies::open(
            metadata.clone(),
            region,
            tickets,
            policies.clone(),
            clock.clone(),
        )
        .await?;
        let families = families.with_continuity(Arc::new(InstalledRenewals {
            metadata: metadata.clone(),
            directory: config.clock_directory.clone(),
            region: region.into(),
        }));
        let control_verifier = Arc::new(PolicyCommandVerifier::new(PolicyTrust {
            issuer: config.global_issuer.clone(),
            audience: format!("{region}/control"),
            environment: config.environment.clone(),
            region_id: region.into(),
            keys: BTreeMap::from([(config.global_signer_id.clone(), global)]),
        })?);
        Ok(Arc::new(Self {
            config,
            workspace,
            metadata,
            region: region.into(),
            public_path: public_path.into(),
            clock,
            policies,
            families,
            tickets: ticket_verifier,
            global: global_verifier,
            local: local_verifier,
            signer,
            control_verifier,
            gate: Arc::new(RwLock::new(())),
        }))
    }
    pub fn control(self: &Arc<Self>) -> anyhow::Result<PolicyControlServer> {
        Ok(PolicyControlServer::new(
            self.config.control.clone(),
            self.control_verifier.clone(),
            self.policies.clone(),
            self.clock.clone(),
        )?
        .with_installer(self.clone()))
    }
    fn scope(&self, key: &str) -> Scope {
        Scope {
            authority_id: self.region.clone(),
            owner_kind: "workspace".into(),
            owner_id: self.workspace.repository().workspace_id().into(),
            family: "regional-key-policy".into(),
            partition_id: key.into(),
        }
    }
    fn floor_path(&self, policy: &KeyPolicy) -> PathBuf {
        self.config.clock_directory.join(format!(
            "policy-{:x}",
            Sha256::digest(format!(
                "{}\0{}\0{}",
                self.region, policy.workspace_id, policy.key_id
            ))
        ))
    }
    fn floor_value(&self, policy: &KeyPolicy) -> Result<Value> {
        Ok(
            json!({"environment":self.config.environment,"regionId":self.region,"workspaceId":policy.workspace_id,"keyId":policy.key_id,"generation":policy.policy_generation,"digest":format!("{:x}",Sha256::digest(serde_json::to_vec(policy).map_err(|_|error(503,"POLICY_CORRUPT"))?))}),
        )
    }
    fn witness(
        &self,
        policy: &KeyPolicy,
        proof: &workspace_identity::renewal::SameKeyRenewal,
    ) -> Result<ContinuityStatus> {
        if witness_valid(&self.config.clock_directory, policy, proof)? {
            return Ok(ContinuityStatus::Eligible);
        }
        // This time is sampled only after the policy Meta commit is durably acknowledged.
        // The observation proves installation before the deadline even if witness persistence
        // completes later. A crash before persistence never manufactures a new observation.
        let observed = self.clock.now()?;
        if observed >= proof.from_expires_at {
            return Ok(ContinuityStatus::Unavailable);
        }
        let value = json!({"observedAt":observed,"digest":renewal_digest(policy,proof)?});
        let path = renewal_witness_path(
            &self.config.clock_directory,
            &policy.region_id,
            &policy.workspace_id,
            &policy.key_id,
            policy.key_version,
        );
        let tmp = path.with_extension(Uuid::new_v4().to_string());
        let failed = || error(503, "RENEWAL_WITNESS_UNAVAILABLE");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|_| failed())?;
        file.write_all(&serde_json::to_vec(&value).map_err(|_| failed())?)
            .map_err(|_| failed())?;
        file.sync_all().map_err(|_| failed())?;
        fs::rename(tmp, path).map_err(|_| failed())?;
        File::open(&self.config.clock_directory)
            .and_then(|f| f.sync_all())
            .map_err(|_| failed())?;
        Ok(ContinuityStatus::Eligible)
    }
    fn check_floor(&self, policy: &KeyPolicy) -> Result<()> {
        let bytes = private_file(&self.floor_path(policy))
            .map_err(|_| error(503, "POLICY_CHECKPOINT_UNAVAILABLE"))?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| error(503, "POLICY_CHECKPOINT_CORRUPT"))?;
        if value != self.floor_value(policy)? {
            return Err(error(503, "POLICY_ROLLBACK"));
        }
        Ok(())
    }
    fn checkpoint(&self, policy: &KeyPolicy) -> Result<()> {
        let path = self.floor_path(policy);
        let value = self.floor_value(policy)?;
        if path.exists() {
            let prior: Value = serde_json::from_slice(
                &private_file(&path).map_err(|_| error(503, "POLICY_CHECKPOINT_UNAVAILABLE"))?,
            )
            .map_err(|_| error(503, "POLICY_CHECKPOINT_CORRUPT"))?;
            if prior["generation"]
                .as_u64()
                .is_none_or(|g| g > policy.policy_generation)
                || prior["generation"] == policy.policy_generation && prior != value
            {
                return Err(error(503, "POLICY_ROLLBACK"));
            }
        } else if policy.policy_generation != 1 {
            return Err(error(503, "POLICY_CHECKPOINT_UNAVAILABLE"));
        }
        let failed = || error(503, "POLICY_CHECKPOINT_UNAVAILABLE");
        let tmp = path.with_extension(Uuid::new_v4().to_string());
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|_| failed())?;
        file.write_all(&serde_json::to_vec(&value).map_err(|_| failed())?)
            .map_err(|_| failed())?;
        file.sync_all().map_err(|_| failed())?;
        fs::rename(tmp, path).map_err(|_| failed())?;
        File::open(&self.config.clock_directory)
            .and_then(|f| f.sync_all())
            .map_err(|_| failed())?;
        Ok(())
    }
    async fn validate(&self, token: &VerifiedAccess) -> Result<Principal> {
        let now = self.clock.now()?;
        if token.workspace_id() != self.workspace.repository().workspace_id()
            || token.region_id() != Some(&self.region)
            || token.expires_at() <= now
        {
            return Err(error(401, "INVALID_CREDENTIAL"));
        }
        let policy = self
            .policies
            .current(token.workspace_id(), token.key_id())
            .await?;
        self.check_floor(&policy)?;
        self.policies
            .check_token_key_binding(
                &VerifiedKeyBinding {
                    workspace_id: token.workspace_id(),
                    region_id: &self.region,
                    key_id: token.key_id(),
                    principal_id: token.principal_id(),
                    key_version: token.key_version(),
                    policy_generation: token.policy_generation(),
                    expires_at: token.expires_at(),
                    not_before: token.not_before(),
                },
                now,
            )
            .await?;
        let deny_path = format!("denied-tokens/{}", token.token_id());
        let denial = self
            .metadata
            .execute(MetaRequest::Get {
                scope: self.scope(token.key_id()),
                guard: None,
                keys: vec![deny_path.clone()],
            })
            .await?;
        if denial["records"]
            .get(&deny_path)
            .is_none_or(|r| !r.is_null())
        {
            return Err(error(401, "CREDENTIAL_REVOKED"));
        }
        let grant = self
            .policies
            .grant(token.workspace_id(), token.key_id(), token.grant_ref())
            .await?;
        let active = self
            .policies
            .grant(token.workspace_id(), token.key_id(), &policy.grant_ref)
            .await?;
        if !grant.subset_of(&active) {
            return Err(error(403, "CEILING_DENIED"));
        }
        if token.scopes().iter().any(|s| !grant.permits_action(s)) {
            return Err(error(403, "INSUFFICIENT_SCOPE"));
        }
        if let (Some(id), Some(epoch)) = (token.family_id(), token.family_epoch()) {
            self.families
                .check_family(FamilyBinding {
                    workspace: token.workspace_id(),
                    key_id: token.key_id(),
                    family_id: id,
                    epoch,
                    key_version: token.key_version(),
                    ceiling_ref: token.grant_ref(),
                    now,
                })
                .await?;
        }
        Ok(Principal {
            owner: false,
            actor: "Agent".into(),
            id: token.principal_id().into(),
            scopes: token.scopes().into(),
            resource_ids: grant.resource_ids,
            expires_at: chrono::DateTime::from_timestamp(token.expires_at(), 0)
                .map(|t| t.to_rfc3339()),
        })
    }
    pub async fn authenticate(self: &Arc<Self>, workspace: &str, raw: &str) -> Result<Credential> {
        if workspace != self.workspace.repository().workspace_id() {
            return Err(error(404, "NOT_FOUND"));
        }
        let lease = self.gate.clone().read_owned().await;
        let now = self.clock.now()?;
        let token = self
            .local
            .verify(raw, now)
            .or_else(|_| self.global.verify(raw, now))?;
        let principal = self.validate(&token).await?;
        Ok(Credential::Scoped(Arc::new(Authorization {
            runtime: self.clone(),
            token,
            principal,
            _lease: lease,
        })))
    }
    async fn observation(
        &self,
        route: &str,
        method: &Method,
        headers: &HeaderMap,
    ) -> Result<Response> {
        let _lease = self.gate.write().await;
        let raw = headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "))
            .ok_or_else(|| error(401, "INVALID_CREDENTIAL"))?;
        let now = self.clock.now()?;
        let token = self
            .local
            .verify(raw, now)
            .or_else(|_| self.global.verify(raw, now))?;
        self.validate(&token).await?;
        let segments: Vec<_> = route.split('/').collect();
        if segments.len() != 3 {
            return Err(error(404, "NOT_FOUND"));
        }
        let family = token.family_id();
        if segments[1] == "refresh-families" {
            if family != Some(segments[2]) {
                return Err(error(404, "NOT_FOUND"));
            }
            let binding = FamilyBinding {
                workspace: token.workspace_id(),
                key_id: token.key_id(),
                family_id: segments[2],
                epoch: token
                    .family_epoch()
                    .ok_or_else(|| error(401, "INVALID_CREDENTIAL"))?,
                key_version: token.key_version(),
                ceiling_ref: token.grant_ref(),
                now,
            };
            if *method == Method::GET {
                let status = self.families.family_status(binding).await?;
                return Ok(Json(json!({"data":status})).into_response());
            }
            if *method == Method::DELETE {
                self.families.revoke_family(binding).await?;
                return Ok(StatusCode::NO_CONTENT.into_response());
            }
            return Err(error(405, "METHOD_NOT_ALLOWED"));
        }
        if segments[1] == "token-issuances" && *method == Method::GET {
            let (key, id) = segments[2]
                .split_once('.')
                .ok_or_else(|| error(404, "NOT_FOUND"))?;
            if key != token.key_id() || Uuid::parse_str(id).is_err() {
                return Err(error(404, "NOT_FOUND"));
            }
            let path = format!("issuances/{id}");
            let value = self
                .metadata
                .execute(MetaRequest::Get {
                    scope: self.scope(key),
                    guard: None,
                    keys: vec![path.clone()],
                })
                .await?;
            let record = &value["records"][&path]["value"];
            if record["familyId"].as_str() != family
                || family.is_none()
                || record["expiresAt"].as_i64().is_none_or(|t| t <= now)
            {
                return Err(error(404, "NOT_FOUND"));
            }
            return Ok(Json(json!({"data":record})).into_response());
        }
        if segments[1] == "access-tokens" && *method == Method::DELETE {
            if segments[2] != token.token_id() {
                return Err(error(404, "NOT_FOUND"));
            }
            self.metadata.execute(MetaRequest::Commit{scope:self.scope(token.key_id()),guard:None,mutation_id:Uuid::new_v4().to_string(),changes:vec![json!({"key":format!("denied-tokens/{}",token.token_id()),"expectedVersion":null,"value":{"expiresAt":token.expires_at(),"principalId":token.principal_id()}})]}).await?;
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
        Err(error(405, "METHOD_NOT_ALLOWED"))
    }

    pub async fn route(
        &self,
        route: &str,
        method: &Method,
        headers: &HeaderMap,
        bytes: &[u8],
    ) -> Result<Option<Response>> {
        if route.starts_with("/refresh-families/")
            || route.starts_with("/access-tokens/")
            || route.starts_with("/token-issuances/")
        {
            return self.observation(route, method, headers).await.map(Some);
        }
        if route != "/refresh-families" && route != "/token-issuances" {
            return Ok(None);
        }
        if *method != Method::POST {
            return Err(error(405, "METHOD_NOT_ALLOWED"));
        }
        if bytes.len() > 16 * 1024 {
            return Err(error(413, "BODY_TOO_LARGE"));
        }
        if headers
            .get(header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            != Some("application/json")
        {
            return Err(error(415, "JSON_REQUIRED"));
        }
        let _lease = self.gate.write().await;
        let now = self.clock.now()?;
        let repository = self.workspace.repository();
        let workspace = repository.workspace_id();
        let proof = headers
            .get("DPoP")
            .and_then(|h| h.to_str().ok())
            .ok_or_else(|| error(401, "CLIENT_PROOF_REQUIRED"))?;
        let uri = format!(
            "{}{}{}",
            self.config.public_origin,
            self.public_path,
            format_args!("/api/v1/workspaces/{workspace}{route}")
        );
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Enrollment {
            ticket: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Refresh {
            key_id: String,
        }
        let (issued, key_id) = if route == "/refresh-families" {
            let input: Enrollment =
                serde_json::from_slice(bytes).map_err(|_| error(400, "INVALID_BODY"))?;
            let verified = self.tickets.verify(&input.ticket, now)?;
            let policy = self.policies.current(workspace, verified.key_id()).await?;
            self.check_floor(&policy)?;
            let issued = self
                .families
                .enroll(
                    workspace,
                    &input.ticket,
                    proof,
                    &uri,
                    now,
                    self.config.public_origin.starts_with("http:"),
                )
                .await?;
            return Ok(Some((StatusCode::CREATED,[(header::CACHE_CONTROL,"no-store"),(header::LOCATION,&format!("refresh-families/{}",issued.family_id))],Json(json!({"keyId":verified.key_id(),"familyId":issued.family_id,"refreshCredential":issued.secret,"nonce":issued.nonce,"expiresAt":issued.expires_at}))).into_response()));
        } else {
            let input: Refresh =
                serde_json::from_slice(bytes).map_err(|_| error(400, "INVALID_BODY"))?;
            let credential = headers
                .get(header::AUTHORIZATION)
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.strip_prefix("Refresh "))
                .ok_or_else(|| error(401, "INVALID_REFRESH_CREDENTIAL"))?;
            let policy = self.policies.current(workspace, &input.key_id).await?;
            self.check_floor(&policy)?;
            (
                self.families
                    .rotate(RefreshRequest {
                        workspace,
                        key_id: &input.key_id,
                        credential,
                        proof,
                        target_uri: &uri,
                        now,
                        allow_loopback_http: self.config.public_origin.starts_with("http:"),
                    })
                    .await?,
                input.key_id,
            )
        };
        // Rotation already committed: every subsequent failure is an uncertain issuance outcome.
        let result:Result<Response>=async {
            let policy=self.policies.current(workspace,&key_id).await?;self.check_floor(&policy)?;
            let grant=self.policies.grant(workspace,&key_id,&issued.ceiling_ref).await?;
            let token=self.signer.sign(&Issuance{workspace_id:workspace,principal_id:&policy.principal_id,key_id:&key_id,key_version:policy.key_version,policy_generation:policy.policy_generation,grant_ref:&issued.ceiling_ref,scopes:&grant.scopes,key_expires_at:policy.expires_at,grant_expires_at:policy.expires_at,family:Some(Family{id:&issued.family_id,epoch:issued.security_epoch,expires_at:issued.expires_at})},self.clock.now()?)?;
            self.local.verify(&token.token,self.clock.now()?)?;
            let id=format!("{key_id}.{}",token.token_id);
            self.metadata.execute(MetaRequest::Commit{scope:self.scope(&key_id),guard:None,mutation_id:Uuid::new_v4().to_string(),changes:vec![json!({"key":format!("issuances/{}",token.token_id),"expectedVersion":null,"value":{"id":id,"keyId":key_id,"familyId":issued.family_id,"principalId":policy.principal_id,"expiresAt":token.expires_at,"status":"issued"}})]}).await?;
            Ok((StatusCode::CREATED,[(header::CACHE_CONTROL,"no-store"),(header::LOCATION,&format!("token-issuances/{id}"))],Json(json!({"id":id,"accessToken":token.token,"tokenType":"Bearer","expiresAt":token.expires_at,"refreshCredential":issued.secret,"refreshExpiresAt":issued.expires_at,"nonce":issued.nonce,"familyId":issued.family_id,"keyId":key_id,"scopes":grant.scopes}))).into_response())
        }.await;
        result
            .map(Some)
            .map_err(|_| error(503, "REFRESH_OUTCOME_UNKNOWN"))
    }
}
struct Authorization {
    runtime: Arc<Runtime>,
    token: VerifiedAccess,
    principal: Principal,
    _lease: OwnedRwLockReadGuard<()>,
}
impl ScopedAuthorization for Authorization {
    fn workspace_id(&self) -> &str {
        self.token.workspace_id()
    }
    fn snapshot(&self) -> Result<Principal> {
        let now = self.runtime.clock.now()?;
        if self.token.expires_at() <= now {
            return Err(error(401, "CREDENTIAL_EXPIRED"));
        }
        Ok(self.principal.clone())
    }
    fn check(&self) -> Pin<Box<dyn Future<Output = Result<Principal>> + Send + '_>> {
        Box::pin(async { self.runtime.validate(&self.token).await })
    }
}
impl PolicyInstaller for Runtime {
    fn apply<'a>(
        &'a self,
        command: &'a str,
        _now: i64,
    ) -> Pin<Box<dyn Future<Output = Result<PolicyReceipt>> + Send + 'a>> {
        Box::pin(async move {
            let _lease = self.gate.write().await;
            let now = self.clock.now()?;
            let (policy, grant) = self.control_verifier.inspect(command, now)?;
            if policy.workspace_id != self.workspace.repository().workspace_id() {
                return Err(error(403, "WORKSPACE_DENIED"));
            }
            let grant = grant.ok_or_else(|| error(400, "GRANT_REQUIRED"))?;
            // Authorize only the explicitly selected records; policy application must not
            // inflate unrelated resources in a large Workspace.
            let ids = grant
                .resource_ids
                .iter()
                .filter(|id| id.as_str() != "*")
                .map(String::as_str)
                .collect::<Vec<_>>();
            let resources = self.workspace.repository().resources_by_id(&ids).await?;
            if resources.len() != ids.len()
                || resources.iter().any(|resource| {
                    !matches!(
                        resource["kind"].as_str(),
                        Some("mysql" | "duckdb" | "filesystem")
                    ) && !(resource["kind"] == "postgresql"
                        && resource["provider"] == "db9-anonymous")
                })
            {
                return Err(error(403, "RESOURCE_ACCESS_DENIED"));
            }
            let mut receipt = self
                .control_verifier
                .apply(command, self.clock.now()?, &self.policies)
                .await?;
            let current = self
                .policies
                .current(&policy.workspace_id, &policy.key_id)
                .await?;
            if current != policy {
                return Err(error(409, "POLICY_SUPERSEDED"));
            }
            self.checkpoint(&current)?;
            if let Some(proof) = self.control_verifier.renewal(command, self.clock.now()?)? {
                receipt.continuity = Some(self.witness(&current, &proof)?);
            }
            Ok(receipt)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use workspace_contracts::Call;
    use workspace_identity::{regional_refresh::ContinuityVerifier, renewal::SameKeyRenewal};
    struct Records(BTreeMap<String, Value>);
    impl Metadata for Records {
        fn health(&self) -> Call<'_> {
            Box::pin(async { Ok(json!({})) })
        }
        fn execute(&self, request: MetaRequest) -> Call<'_> {
            Box::pin(async move {
                let MetaRequest::Get { keys, .. } = request else {
                    panic!("unexpected mutation")
                };
                let values: serde_json::Map<String, Value> = keys
                    .into_iter()
                    .map(|key| {
                        let value = self
                            .0
                            .get(&key)
                            .map(|v| json!({"value":v}))
                            .unwrap_or(Value::Null);
                        (key, value)
                    })
                    .collect();
                Ok(json!({"records":values}))
            })
        }
    }
    #[tokio::test]
    async fn renewal_requires_complete_signed_chain_and_pre_expiry_installation_witness() {
        let directory = std::env::temp_dir().join(format!("renewal-test-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let prior = KeyPolicy {
            workspace_id: "ws_test".into(),
            region_id: "region:a".into(),
            key_id: Uuid::new_v4().to_string(),
            principal_id: "principal".into(),
            key_version: 1,
            policy_generation: 1,
            grant_ref: "grant".into(),
            expires_at: 2000,
            revoked: false,
        };
        let mut next = prior.clone();
        next.key_version = 2;
        next.policy_generation = 2;
        next.expires_at = 4000;
        let proof = SameKeyRenewal {
            from_version: 1,
            from_expires_at: 2000,
            global_observed_at: 1900,
        };
        let verify = |record: Value| InstalledRenewals {
            metadata: Arc::new(Records(BTreeMap::from([("renewals/2".into(), record)]))),
            directory: directory.clone(),
            region: "region:a".into(),
        };
        let record = json!({"prior":prior,"policy":next,"proof":proof});
        let checker = verify(record.clone());
        let check = |checker: InstalledRenewals, policy: KeyPolicy| async move {
            checker
                .check("ws_test", &policy.key_id, 1, 2000, "principal", &policy)
                .await
        };
        assert!(
            check(checker, next.clone()).await.is_err(),
            "S3 records alone cannot establish timely installation"
        );
        let path = renewal_witness_path(&directory, "region:a", "ws_test", &next.key_id, 2);
        let write = |observed: i64| {
            let mut f = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&path)
                .unwrap();
            f.write_all(
                json!({"observedAt":observed,"digest":renewal_digest(&next,&proof).unwrap()})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
        };
        write(2000);
        assert!(
            check(verify(record.clone()), next.clone()).await.is_err(),
            "Late application cannot extend continuity"
        );
        write(1999);
        assert!(check(verify(record.clone()), next.clone()).await.is_ok());
        assert!(
            check(verify(record.clone()), next.clone()).await.is_ok(),
            "Fresh verifier after restart uses same independent witness"
        );
        for changed in [
            json!({"prior":prior,"policy":next}),
            json!({"prior":prior,"policy":next,"proof":{"fromVersion":1,"fromExpiresAt":2000,"globalObservedAt":2000}}),
        ] {
            assert!(check(verify(changed), next.clone()).await.is_err());
        }
        let mut rotation = next.clone();
        rotation.expires_at = 2000;
        assert!(check(verify(record.clone()), rotation).await.is_err());
        let mut changed_grant = next.clone();
        changed_grant.grant_ref = "other".into();
        assert!(check(verify(record.clone()), changed_grant).await.is_err());
        let mut gap = next.clone();
        gap.key_version = 3;
        gap.policy_generation = 3;
        assert!(check(verify(record), gap).await.is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
