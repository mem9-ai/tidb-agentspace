//! Global identity directory. This module does not verify identity-provider tokens or grant
//! regional access; callers must supply an already verified issuer and subject.

pub mod cleanup;
pub mod dpop;
pub mod embedded_region;
pub mod enrollment_ticket;
pub mod global_keys;
pub mod global_owner_sessions;
pub mod onboarding;
pub mod regional;
pub mod regional_grants;
pub mod regional_key_policy;
pub mod regional_refresh;
pub mod renewal;
pub mod scheduler;
pub mod sessions;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use subtle::ConstantTimeEq;
use uuid::Uuid;
use workspace_contracts::{MetaRequest, Metadata, Result, Scope, ServiceError};

const RECORDS: [&str; 5] = [
    "identity",
    "personal-organization",
    "personal-workspace",
    "owner-membership",
    "initialization",
];

fn error(status: u16, code: &str) -> ServiceError {
    ServiceError::new(status, code)
}

/// These values must originate from a successfully verified provider token, never client input.
pub struct VerifiedIdentity<'a> {
    pub issuer: &'a str,
    pub subject: &'a str,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Registration {
    pub user_id: String,
    pub organization_id: String,
    pub workspace_id: String,
    pub region_id: String,
    pub operation_id: String,
}

/// Publicly safe placement information for one verified Workspace owner.
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegionAssignment {
    pub workspace_id: String,
    pub region_id: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Provisioning {
    Pending,
    Ready,
}

/// Only the first successful creation returns the secret. It must not be logged or persisted
/// by callers; the browser receives it over the protected Guest session channel.
pub struct GuestRegistration {
    pub guest_id: String,
    pub secret: String,
    pub expires_at: i64,
    pub registration: Registration,
}

/// Backed by the Global Meta authority; no Region-to-Global call is made by this module.
#[derive(Clone)]
pub struct Directory {
    metadata: Arc<dyn Metadata>,
}

fn valid_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 2048 && !value.chars().any(char::is_control)
}

fn valid_region(value: &str) -> bool {
    value.strip_prefix("region:").is_some_and(|id| {
        !id.is_empty()
            && id.len() <= 100
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
    })
}

fn scope(identity: &VerifiedIdentity<'_>) -> Result<Scope> {
    if !valid_text(identity.issuer) || !valid_text(identity.subject) {
        return Err(error(400, "INVALID_IDENTITY"));
    }
    // Length prefixes and a type tag prevent ambiguous tuples and future Guest collisions.
    let mut digest = Sha256::new();
    digest.update(b"workspace-identity\0oidc\0v1\0");
    for value in [identity.issuer, identity.subject] {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value.as_bytes());
    }
    Ok(Scope {
        authority_id: "global".into(),
        owner_kind: "system".into(),
        owner_id: format!("identity-{}", hex::encode(digest.finalize())),
        family: "personal-identity".into(),
        partition_id: "primary".into(),
    })
}

fn guest_scope(guest_id: &str) -> Result<Scope> {
    let id = Uuid::parse_str(guest_id).map_err(|_| error(401, "GUEST_UNAUTHORIZED"))?;
    if id.to_string() != guest_id {
        return Err(error(401, "GUEST_UNAUTHORIZED"));
    }
    Ok(Scope {
        authority_id: "global".into(),
        owner_kind: "system".into(),
        owner_id: format!("guest-{id}"),
        family: "personal-identity".into(),
        partition_id: "primary".into(),
    })
}

fn now() -> Result<i64> {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| error(503, "CLOCK_UNAVAILABLE"))?
        .as_secs();
    i64::try_from(seconds).map_err(|_| error(503, "CLOCK_UNAVAILABLE"))
}

fn value<'a>(records: &'a Value, key: &str) -> Result<&'a Value> {
    records
        .get(key)
        .and_then(|record| record.get("value"))
        .ok_or_else(|| error(503, "IDENTITY_RECORD_CORRUPT"))
}

fn is_empty(records: &Value) -> Result<bool> {
    let map = records
        .as_object()
        .ok_or_else(|| error(503, "IDENTITY_RECORD_CORRUPT"))?;
    if !RECORDS.iter().all(|key| map.contains_key(*key)) {
        return Err(error(503, "IDENTITY_RECORD_CORRUPT"));
    }
    let empty = RECORDS.iter().filter(|key| map[**key].is_null()).count();
    if empty == RECORDS.len() {
        return Ok(true);
    }
    if empty != 0 {
        return Err(error(503, "IDENTITY_RECORD_CORRUPT"));
    }
    Ok(false)
}

fn decode_registration(records: &Value) -> Result<Registration> {
    let registration: Registration =
        serde_json::from_value(value(records, "initialization")?.clone())
            .map_err(|_| error(503, "IDENTITY_RECORD_CORRUPT"))?;
    let workspace = value(records, "personal-workspace")?;
    if !valid_region(&registration.region_id)
        || [
            &registration.user_id,
            &registration.organization_id,
            &registration.workspace_id,
            &registration.operation_id,
        ]
        .iter()
        .any(|id| Uuid::parse_str(id).is_err())
        || value(records, "personal-organization")?
            != &json!({"id":registration.organization_id,"ownerId":registration.user_id})
        || !["pending", "ready"].contains(&workspace["state"].as_str().unwrap_or_default())
        || workspace
            != &json!({"id":registration.workspace_id,"organizationId":registration.organization_id,"regionId":registration.region_id,"state":workspace["state"]})
        || value(records, "owner-membership")?
            != &json!({"userId":registration.user_id,"workspaceId":registration.workspace_id,"role":"owner","generation":1})
    {
        return Err(error(503, "IDENTITY_RECORD_CORRUPT"));
    }
    Ok(registration)
}

fn decode(records: &Value, identity: &VerifiedIdentity<'_>) -> Result<Option<Registration>> {
    if is_empty(records)? {
        return Ok(None);
    }
    let stored_identity = value(records, "identity")?;
    if stored_identity["type"] != "oidc"
        || stored_identity["issuer"] != identity.issuer
        || stored_identity["subject"] != identity.subject
    {
        return Err(error(503, "IDENTITY_MISMATCH"));
    }
    Ok(Some(decode_registration(records)?))
}

fn decode_guest(
    records: &Value,
    guest_id: &str,
    secret: &str,
    current: i64,
) -> Result<(Registration, i64)> {
    let bytes = hex::decode(secret).map_err(|_| error(401, "GUEST_UNAUTHORIZED"))?;
    if bytes.len() != 32 || secret.len() != 64 || is_empty(records)? {
        return Err(error(401, "GUEST_UNAUTHORIZED"));
    }
    let identity = value(records, "identity")?;
    let expected = identity["verifier"]
        .as_str()
        .and_then(|value| hex::decode(value).ok())
        .filter(|bytes| bytes.len() == 32)
        .ok_or_else(|| error(503, "IDENTITY_RECORD_CORRUPT"))?;
    let created = identity["createdAt"]
        .as_i64()
        .ok_or_else(|| error(503, "IDENTITY_RECORD_CORRUPT"))?;
    let expires = identity["expiresAt"]
        .as_i64()
        .ok_or_else(|| error(503, "IDENTITY_RECORD_CORRUPT"))?;
    if created.checked_add(86_400) != Some(expires)
        || identity["type"] != "guest"
        || identity["guestId"] != guest_id
    {
        return Err(error(503, "IDENTITY_RECORD_CORRUPT"));
    }
    if current >= expires
        || Sha256::digest(&bytes)
            .as_slice()
            .ct_eq(&expected)
            .unwrap_u8()
            != 1
    {
        return Err(error(401, "GUEST_UNAUTHORIZED"));
    }
    Ok((decode_registration(records)?, expires))
}

impl Directory {
    // A control flow must not authorize against one Global store and issue a session in another.
    fn same_store(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.metadata, &other.metadata)
    }

    pub async fn open(metadata: Arc<dyn Metadata>) -> Result<Self> {
        let health = metadata.health().await?;
        if health["authorityId"] != "global"
            || !health["capabilities"]
                .as_array()
                .is_some_and(|v| v.contains(&json!("recordsV1")))
        {
            return Err(error(503, "GLOBAL_METADATA_REQUIRED"));
        }
        Ok(Self { metadata })
    }

    async fn read(
        &self,
        scope: &Scope,
        identity: &VerifiedIdentity<'_>,
    ) -> Result<Option<Registration>> {
        let result = self
            .metadata
            .execute(MetaRequest::Get {
                scope: scope.clone(),
                guard: None,
                keys: RECORDS.iter().map(|s| (*s).into()).collect(),
            })
            .await?;
        decode(&result["records"], identity)
    }

    /// A reservation alone is not proof that the regional Workspace is ready to serve.
    pub async fn status(
        &self,
        identity: VerifiedIdentity<'_>,
    ) -> Result<Option<(Registration, Provisioning)>> {
        let scope = scope(&identity)?;
        let result = self
            .metadata
            .execute(MetaRequest::Get {
                scope,
                guard: None,
                keys: RECORDS.iter().map(|s| (*s).into()).collect(),
            })
            .await?;
        let records = &result["records"];
        let Some(registration) = decode(records, &identity)? else {
            return Ok(None);
        };
        let state = match value(records, "personal-workspace")?["state"].as_str() {
            Some("pending") => Provisioning::Pending,
            Some("ready") => Provisioning::Ready,
            _ => return Err(error(503, "IDENTITY_RECORD_CORRUPT")),
        };
        Ok(Some((registration, state)))
    }

    /// Resolve a ready Workspace for a previously verified identity, without provisioning
    /// or consulting Region. Unknown, foreign and pending Workspaces share one response.
    pub async fn region_assignment(
        &self,
        identity: VerifiedIdentity<'_>,
        workspace_id: &str,
    ) -> Result<RegionAssignment> {
        match self.status(identity).await? {
            Some((registration, Provisioning::Ready))
                if registration.workspace_id == workspace_id =>
            {
                Ok(RegionAssignment {
                    workspace_id: registration.workspace_id,
                    region_id: registration.region_id,
                })
            }
            _ => Err(error(404, "NOT_FOUND")),
        }
    }

    /// Record a Region's matching durable initialization acknowledgement. Only a trusted
    /// Global control workflow may invoke this after authenticating the Region response and
    /// verifying the complete installed policy and cleanup prerequisites. This method does
    /// not establish that transport or make a regional call.
    pub async fn record_region_ready(
        &self,
        identity: VerifiedIdentity<'_>,
        acknowledgement: &Registration,
        mutation_id: &str,
    ) -> Result<()> {
        let scope = scope(&identity)?;
        self.mark_ready(scope, acknowledgement, mutation_id, |records| {
            decode(records, &identity)?.ok_or_else(|| error(404, "IDENTITY_NOT_FOUND"))
        })
        .await
    }

    async fn mark_ready<F>(
        &self,
        scope: Scope,
        acknowledgement: &Registration,
        mutation_id: &str,
        validate: F,
    ) -> Result<()>
    where
        F: Fn(&Value) -> Result<Registration>,
    {
        if Uuid::parse_str(mutation_id).is_err() {
            return Err(error(400, "INVALID_COMMAND"));
        }
        for _ in 0..8 {
            let result = self
                .metadata
                .execute(MetaRequest::Get {
                    scope: scope.clone(),
                    guard: None,
                    keys: RECORDS.iter().map(|s| (*s).into()).collect(),
                })
                .await?;
            let records = &result["records"];
            let registration = validate(records)?;
            if &registration != acknowledgement {
                return Err(error(409, "REGION_ACK_MISMATCH"));
            }
            let workspace = &records["personal-workspace"];
            if workspace["value"]["state"] == "ready" {
                return Ok(());
            }
            let version = workspace["version"]
                .as_str()
                .ok_or_else(|| error(503, "IDENTITY_RECORD_CORRUPT"))?;
            let mut updated = workspace["value"].clone();
            updated["state"] = json!("ready");
            let result = self.metadata.execute(MetaRequest::Commit {
                scope: scope.clone(), guard: None, mutation_id: mutation_id.into(),
                changes: vec![json!({"key":"personal-workspace","expectedVersion":version,"value":updated})],
            }).await;
            match result {
                Ok(_) => return Ok(()),
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) if e.code == "META_COMMIT_UNKNOWN" => {
                    let receipt = self
                        .metadata
                        .execute(MetaRequest::Resolve {
                            scope: scope.clone(),
                            guard: None,
                            mutation_id: mutation_id.into(),
                        })
                        .await;
                    if receipt.as_ref().is_ok_and(|r| r["outcome"] == "committed") {
                        continue;
                    }
                    return Err(e);
                }
                Err(e) => return Err(e),
            }
        }
        Err(error(503, "IDENTITY_CONFLICT_UNRESOLVED"))
    }

    /// Create a private temporary identity. This creates no regional resources and must only
    /// be called behind admission and rate limits. Regional access needs installed local policy.
    pub async fn create_guest(&self, region: &str) -> Result<GuestRegistration> {
        self.create_guest_at(region, now()?).await
    }

    async fn create_guest_at(&self, region: &str, created_at: i64) -> Result<GuestRegistration> {
        if !valid_region(region) {
            return Err(error(400, "INVALID_REGION"));
        }
        let expires_at = created_at
            .checked_add(86_400)
            .ok_or_else(|| error(503, "CLOCK_UNAVAILABLE"))?;
        let guest_id = Uuid::new_v4().to_string();
        let mut secret_bytes = [0u8; 32];
        getrandom::fill(&mut secret_bytes).map_err(|_| error(503, "RANDOM_UNAVAILABLE"))?;
        let secret = hex::encode(secret_bytes);
        let verifier = hex::encode(Sha256::digest(secret_bytes));
        let registration = Registration {
            user_id: Uuid::new_v4().to_string(),
            organization_id: Uuid::new_v4().to_string(),
            workspace_id: Uuid::new_v4().to_string(),
            region_id: region.into(),
            operation_id: Uuid::new_v4().to_string(),
        };
        let scope = guest_scope(&guest_id)?;
        let entries = [
            (
                "identity",
                json!({"type":"guest","guestId":guest_id,"verifier":verifier,"createdAt":created_at,"expiresAt":expires_at}),
            ),
            (
                "personal-organization",
                json!({"id":registration.organization_id,"ownerId":registration.user_id}),
            ),
            (
                "personal-workspace",
                json!({"id":registration.workspace_id,"organizationId":registration.organization_id,"regionId":registration.region_id,"state":"pending"}),
            ),
            (
                "owner-membership",
                json!({"userId":registration.user_id,"workspaceId":registration.workspace_id,"role":"owner","generation":1}),
            ),
            ("initialization", json!(registration)),
        ];
        let mutation_id = registration.operation_id.clone();
        let result = self
            .metadata
            .execute(MetaRequest::Commit {
                scope: scope.clone(),
                guard: None,
                mutation_id: mutation_id.clone(),
                changes: entries
                    .into_iter()
                    .map(|(key, value)| json!({"key":key,"expectedVersion":null,"value":value}))
                    .collect(),
            })
            .await;
        if let Err(e) = result {
            if e.code != "META_COMMIT_UNKNOWN" {
                return Err(e);
            }
            let receipt = self
                .metadata
                .execute(MetaRequest::Resolve {
                    scope: scope.clone(),
                    guard: None,
                    mutation_id,
                })
                .await;
            if !receipt
                .as_ref()
                .is_ok_and(|value| value["outcome"] == "committed")
            {
                return Err(e);
            }
            let recovered = self
                .authenticate_guest_at(&guest_id, &secret, created_at)
                .await?;
            if recovered != registration {
                return Err(error(503, "IDENTITY_COMMIT_INCONSISTENT"));
            }
        }
        Ok(GuestRegistration {
            guest_id,
            secret,
            expires_at,
            registration,
        })
    }

    /// Verify a Guest credential against Global metadata for onboarding only. Region must
    /// authorize with its own installed state and must never call this method on its data path.
    pub async fn authenticate_guest(&self, guest_id: &str, secret: &str) -> Result<Registration> {
        self.authenticate_guest_at(guest_id, secret, now()?).await
    }

    /// Global onboarding only; Region sessions must use the installed local policy instead.
    pub async fn guest_status(
        &self,
        guest_id: &str,
        secret: &str,
    ) -> Result<(Registration, Provisioning, i64)> {
        let scope = guest_scope(guest_id)?;
        let result = self
            .metadata
            .execute(MetaRequest::Get {
                scope,
                guard: None,
                keys: RECORDS.iter().map(|s| (*s).into()).collect(),
            })
            .await?;
        let records = &result["records"];
        let (registration, expires) = decode_guest(records, guest_id, secret, now()?)?;
        let state = match value(records, "personal-workspace")?["state"].as_str() {
            Some("pending") => Provisioning::Pending,
            Some("ready") => Provisioning::Ready,
            _ => return Err(error(503, "IDENTITY_RECORD_CORRUPT")),
        };
        Ok((registration, state, expires))
    }

    /// Caller must authenticate the Region and verify its durable cleanup-queue acknowledgement.
    pub async fn record_guest_ready(
        &self,
        guest_id: &str,
        secret: &str,
        acknowledgement: &Registration,
        mutation_id: &str,
    ) -> Result<()> {
        let scope = guest_scope(guest_id)?;
        self.mark_ready(scope, acknowledgement, mutation_id, |records| {
            Ok(decode_guest(records, guest_id, secret, now()?)?.0)
        })
        .await
    }

    async fn authenticate_guest_at(
        &self,
        guest_id: &str,
        secret: &str,
        current: i64,
    ) -> Result<Registration> {
        let scope = guest_scope(guest_id)?;
        let result = self
            .metadata
            .execute(MetaRequest::Get {
                scope,
                guard: None,
                keys: RECORDS.iter().map(|key| (*key).into()).collect(),
            })
            .await?;
        Ok(decode_guest(&result["records"], guest_id, secret, current)?.0)
    }

    /// Reserve the personal identity group. Region initialization is separate and still pending.
    /// A failed or indeterminate write is returned to the caller; it is never reported as success.
    pub async fn reserve(
        &self,
        identity: VerifiedIdentity<'_>,
        region: &str,
    ) -> Result<Registration> {
        if !valid_region(region) {
            return Err(error(400, "INVALID_REGION"));
        }
        let scope = scope(&identity)?;
        if let Some(registration) = self.read(&scope, &identity).await? {
            return Ok(registration);
        }
        let registration = Registration {
            user_id: Uuid::new_v4().to_string(),
            organization_id: Uuid::new_v4().to_string(),
            workspace_id: Uuid::new_v4().to_string(),
            region_id: region.into(),
            operation_id: Uuid::new_v4().to_string(),
        };
        let entries = [
            (
                "identity",
                json!({"type":"oidc","issuer":identity.issuer,"subject":identity.subject}),
            ),
            (
                "personal-organization",
                json!({"id":registration.organization_id,"ownerId":registration.user_id}),
            ),
            (
                "personal-workspace",
                json!({"id":registration.workspace_id,"organizationId":registration.organization_id,"regionId":registration.region_id,"state":"pending"}),
            ),
            (
                "owner-membership",
                json!({"userId":registration.user_id,"workspaceId":registration.workspace_id,"role":"owner","generation":1}),
            ),
            ("initialization", json!(registration)),
        ];
        let mutation_id = registration.operation_id.clone();
        let result = self
            .metadata
            .execute(MetaRequest::Commit {
                scope: scope.clone(),
                guard: None,
                mutation_id: mutation_id.clone(),
                changes: entries
                    .into_iter()
                    .map(|(key, value)| json!({"key":key,"expectedVersion":null,"value":value}))
                    .collect(),
            })
            .await;
        match result {
            Ok(_) => Ok(registration),
            Err(e) if e.code == "META_CONFLICT" => self
                .read(&scope, &identity)
                .await?
                .ok_or_else(|| error(503, "IDENTITY_CONFLICT_UNRESOLVED")),
            Err(e) if e.code == "META_COMMIT_UNKNOWN" => {
                let receipt = self
                    .metadata
                    .execute(MetaRequest::Resolve {
                        scope: scope.clone(),
                        guard: None,
                        mutation_id,
                    })
                    .await;
                if receipt
                    .as_ref()
                    .is_ok_and(|value| value["outcome"] == "committed")
                {
                    return self
                        .read(&scope, &identity)
                        .await?
                        .ok_or_else(|| error(503, "IDENTITY_COMMIT_INCONSISTENT"));
                }
                Err(e)
            }
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::{
        collections::BTreeMap,
        sync::{
            Mutex,
            atomic::{AtomicBool, Ordering},
        },
    };
    use workspace_contracts::Call;

    #[derive(Default)]
    pub(crate) struct MemoryMeta {
        pub(crate) groups: Mutex<BTreeMap<String, BTreeMap<String, Value>>>,
        pub(crate) lose_reply: AtomicBool,
        pub(crate) authority: Option<String>,
    }
    pub(crate) fn group_key(scope: &Scope) -> String {
        serde_json::to_string(scope).unwrap()
    }
    impl Metadata for MemoryMeta {
        fn health(&self) -> Call<'_> {
            Box::pin(async {
                Ok(
                    json!({"authorityId":self.authority.as_deref().unwrap_or("global"),"capabilities":["recordsV1"]}),
                )
            })
        }
        fn execute(&self, request: MetaRequest) -> Call<'_> {
            Box::pin(async move {
                match request {
                    MetaRequest::Get { scope, keys, .. } => {
                        let groups = self.groups.lock().unwrap();
                        let group = groups.get(&group_key(&scope));
                        let records: serde_json::Map<String, Value> = keys
                            .into_iter()
                            .map(|key| {
                                let record = group
                                    .and_then(|g| g.get(&key))
                                    .cloned()
                                    .unwrap_or(Value::Null);
                                (key, record)
                            })
                            .collect();
                        Ok(json!({"records":records}))
                    }
                    MetaRequest::Commit { scope, changes, .. } => {
                        let mut groups = self.groups.lock().unwrap();
                        let group = groups.entry(group_key(&scope)).or_default();
                        for change in &changes {
                            let key = change["key"].as_str().unwrap();
                            if group
                                .get(key)
                                .map(|v| v["version"].clone())
                                .unwrap_or(Value::Null)
                                != change["expectedVersion"]
                            {
                                return Err(error(409, "META_CONFLICT"));
                            }
                        }
                        let version = Uuid::new_v4().to_string();
                        for change in changes {
                            let key = change["key"].as_str().unwrap().to_owned();
                            if change["delete"] == true {
                                group.remove(&key);
                            } else {
                                group.insert(
                                    key,
                                    json!({"version":version,"value":change["value"]}),
                                );
                            }
                        }
                        if self.lose_reply.swap(false, Ordering::SeqCst) {
                            return Err(error(503, "META_COMMIT_UNKNOWN"));
                        }
                        Ok(json!({"version":version}))
                    }
                    MetaRequest::List {
                        scope,
                        prefix,
                        after,
                        limit,
                        ..
                    } => {
                        let groups = self.groups.lock().unwrap();
                        let selected: Vec<_> = groups
                            .get(&group_key(&scope))
                            .into_iter()
                            .flat_map(|group| group.iter())
                            .filter(|(key, _)| {
                                key.starts_with(&prefix)
                                    && after.as_ref().is_none_or(|cursor| *key > cursor)
                            })
                            .take(limit + 1)
                            .collect();
                        let more = selected.len() > limit;
                        let records: Vec<_> = selected.into_iter().take(limit).map(|(key,value)|json!({"key":key,"version":value["version"],"value":value["value"]})).collect();
                        let next = if more {
                            records.last().and_then(|value| value["key"].as_str())
                        } else {
                            None
                        };
                        Ok(json!({"records":records,"nextCursor":next}))
                    }
                    _ => Err(error(400, "META_INVALID_REQUEST")),
                }
            })
        }
    }

    fn identity<'a>(issuer: &'a str, subject: &'a str) -> VerifiedIdentity<'a> {
        VerifiedIdentity { issuer, subject }
    }

    #[tokio::test]
    async fn region_assignment_is_ready_owner_only_and_read_only() {
        let metadata = Arc::new(MemoryMeta::default());
        let directory = Directory::open(metadata.clone()).await.unwrap();
        let alice = directory
            .reserve(identity("https://issuer.example", "alice"), "region:a")
            .await
            .unwrap();
        let bob = directory
            .reserve(identity("https://issuer.example", "bob"), "region:b")
            .await
            .unwrap();
        let lookup = |subject: &'static str, workspace: String| {
            let directory = directory.clone();
            async move {
                directory
                    .region_assignment(identity("https://issuer.example", subject), &workspace)
                    .await
            }
        };
        assert_eq!(
            lookup("alice", alice.workspace_id.clone())
                .await
                .unwrap_err()
                .code,
            "NOT_FOUND"
        );
        directory
            .record_region_ready(
                identity("https://issuer.example", "alice"),
                &alice,
                &Uuid::new_v4().to_string(),
            )
            .await
            .unwrap();
        let before = metadata.groups.lock().unwrap().clone();
        assert_eq!(
            lookup("alice", alice.workspace_id.clone()).await.unwrap(),
            RegionAssignment {
                workspace_id: alice.workspace_id.clone(),
                region_id: "region:a".into()
            }
        );
        for (subject, workspace) in [
            ("alice", bob.workspace_id),
            ("bob", alice.workspace_id.clone()),
            ("unknown", alice.workspace_id.clone()),
            ("alice", Uuid::new_v4().to_string()),
        ] {
            let err = lookup(subject, workspace).await.unwrap_err();
            assert_eq!((err.status, err.code.as_str()), (404, "NOT_FOUND"));
        }
        let other_issuer = directory
            .region_assignment(
                identity("https://other.example", "alice"),
                &alice.workspace_id,
            )
            .await
            .unwrap_err();
        assert_eq!(
            (other_issuer.status, other_issuer.code.as_str()),
            (404, "NOT_FOUND")
        );
        assert_eq!(*metadata.groups.lock().unwrap(), before);
    }

    #[tokio::test]
    async fn distinct_identities_are_isolated_and_repeat_returns_same_reservation() {
        let metadata = Arc::new(MemoryMeta::default());
        let directory = Directory::open(metadata).await.unwrap();
        let a = directory
            .reserve(identity("https://issuer.example", "alice"), "region:a")
            .await
            .unwrap();
        let again = directory
            .reserve(identity("https://issuer.example", "alice"), "region:b")
            .await
            .unwrap();
        let b = directory
            .reserve(identity("https://issuer.example", "bob"), "region:a")
            .await
            .unwrap();
        let other_issuer = directory
            .reserve(identity("https://other.example", "alice"), "region:a")
            .await
            .unwrap();
        assert!(a == again);
        assert_eq!(a.region_id, "region:a");
        assert_ne!(a.workspace_id, b.workspace_id);
        assert_ne!(a.workspace_id, other_issuer.workspace_id);
        assert_ne!(a.organization_id, b.organization_id);
    }

    #[tokio::test]
    async fn region_ready_requires_exact_ack_and_survives_an_unknown_reply() {
        let metadata = Arc::new(MemoryMeta::default());
        let directory = Directory::open(metadata.clone()).await.unwrap();
        let registration = directory
            .reserve(identity("https://issuer.example", "alice"), "region:a")
            .await
            .unwrap();
        assert!(
            directory
                .status(identity("https://issuer.example", "alice"))
                .await
                .unwrap()
                .unwrap()
                .1
                == Provisioning::Pending
        );
        let mut wrong = registration.clone();
        wrong.workspace_id = Uuid::new_v4().to_string();
        let mutation = Uuid::new_v4().to_string();
        assert_eq!(
            directory
                .record_region_ready(
                    identity("https://issuer.example", "alice"),
                    &wrong,
                    &mutation
                )
                .await
                .err()
                .unwrap()
                .code,
            "REGION_ACK_MISMATCH"
        );
        metadata.lose_reply.store(true, Ordering::SeqCst);
        assert_eq!(
            directory
                .record_region_ready(
                    identity("https://issuer.example", "alice"),
                    &registration,
                    &mutation
                )
                .await
                .err()
                .unwrap()
                .code,
            "META_COMMIT_UNKNOWN"
        );
        directory
            .record_region_ready(
                identity("https://issuer.example", "alice"),
                &registration,
                &mutation,
            )
            .await
            .unwrap();
        assert!(
            directory
                .status(identity("https://issuer.example", "alice"))
                .await
                .unwrap()
                .unwrap()
                .1
                == Provisioning::Ready
        );
        assert!(
            directory
                .reserve(identity("https://issuer.example", "alice"), "region:a")
                .await
                .unwrap()
                == registration
        );
        let group_id = group_key(&scope(&identity("https://issuer.example", "alice")).unwrap());
        assert_eq!(
            metadata.groups.lock().unwrap()[&group_id]["personal-workspace"]["value"]["state"],
            "ready"
        );
    }

    #[tokio::test]
    async fn concurrent_first_logins_use_one_complete_identity_group() {
        let metadata = Arc::new(MemoryMeta::default());
        let directory = Arc::new(Directory::open(metadata.clone()).await.unwrap());
        let mut tasks = Vec::new();
        for _ in 0..32 {
            let directory = directory.clone();
            tasks.push(tokio::spawn(async move {
                directory
                    .reserve(identity("https://issuer.example", "alice"), "region:a")
                    .await
                    .unwrap()
            }));
        }
        let first = tasks.remove(0).await.unwrap();
        for task in tasks {
            assert!(first == task.await.unwrap());
        }
        let groups = metadata.groups.lock().unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups.values().next().unwrap().len(), 5);
    }

    #[tokio::test]
    async fn unknown_commit_is_not_success_and_a_later_read_recovers_the_same_group() {
        let metadata = Arc::new(MemoryMeta::default());
        metadata.lose_reply.store(true, Ordering::SeqCst);
        let directory = Directory::open(metadata.clone()).await.unwrap();
        let failed = directory
            .reserve(identity("https://issuer.example", "alice"), "region:a")
            .await;
        assert_eq!(failed.err().unwrap().code, "META_COMMIT_UNKNOWN");
        let recovered = directory
            .reserve(identity("https://issuer.example", "alice"), "region:a")
            .await
            .unwrap();
        let again = directory
            .reserve(identity("https://issuer.example", "alice"), "region:a")
            .await
            .unwrap();
        assert!(recovered == again);
        assert_eq!(metadata.groups.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn guest_credentials_are_isolated_expire_after_24_hours_and_are_not_stored() {
        let metadata = Arc::new(MemoryMeta::default());
        let directory = Directory::open(metadata.clone()).await.unwrap();
        let alice = directory.create_guest_at("region:a", 100).await.unwrap();
        let bob = directory.create_guest_at("region:a", 100).await.unwrap();
        assert_ne!(alice.guest_id, bob.guest_id);
        assert_ne!(
            alice.registration.workspace_id,
            bob.registration.workspace_id
        );
        assert_eq!(alice.expires_at, 86_500);
        assert!(
            directory
                .authenticate_guest_at(&alice.guest_id, &alice.secret, 86_499)
                .await
                .unwrap()
                == alice.registration
        );
        assert_eq!(
            directory
                .authenticate_guest_at(&alice.guest_id, &alice.secret, 86_500)
                .await
                .err()
                .unwrap()
                .code,
            "GUEST_UNAUTHORIZED"
        );
        assert_eq!(
            directory
                .authenticate_guest_at(&alice.guest_id, &bob.secret, 101)
                .await
                .err()
                .unwrap()
                .code,
            "GUEST_UNAUTHORIZED"
        );
        assert_eq!(
            directory
                .authenticate_guest_at(&bob.guest_id, &alice.secret, 101)
                .await
                .err()
                .unwrap()
                .code,
            "GUEST_UNAUTHORIZED"
        );
        assert_eq!(
            directory
                .authenticate_guest_at(&alice.guest_id, "bad", 101)
                .await
                .err()
                .unwrap()
                .code,
            "GUEST_UNAUTHORIZED"
        );
        let groups = metadata.groups.lock().unwrap();
        let records = serde_json::to_string(&*groups).unwrap();
        assert!(!records.contains(&alice.secret));
        assert!(!records.contains(&bob.secret));
    }

    #[tokio::test]
    async fn unknown_guest_commit_never_returns_an_unconfirmed_credential() {
        let metadata = Arc::new(MemoryMeta::default());
        metadata.lose_reply.store(true, Ordering::SeqCst);
        let directory = Directory::open(metadata).await.unwrap();
        let failure = directory
            .create_guest_at("region:a", 100)
            .await
            .err()
            .unwrap();
        assert_eq!(failure.code, "META_COMMIT_UNKNOWN");
    }

    #[tokio::test]
    async fn incomplete_or_mismatched_groups_fail_closed() {
        let metadata = Arc::new(MemoryMeta::default());
        let directory = Directory::open(metadata.clone()).await.unwrap();
        let id = identity("https://issuer.example", "alice");
        let group_id = group_key(&scope(&id).unwrap());
        metadata.groups.lock().unwrap().insert(group_id, BTreeMap::from([("identity".into(), json!({"version":"one","value":{"type":"oidc","issuer":"https://issuer.example","subject":"alice"}}))]));
        assert_eq!(
            directory.reserve(id, "region:a").await.err().unwrap().code,
            "IDENTITY_RECORD_CORRUPT"
        );
    }

    #[test]
    fn identity_encoding_is_length_delimited_and_case_sensitive() {
        assert_ne!(
            scope(&identity("ab", "c")).unwrap().owner_id,
            scope(&identity("a", "bc")).unwrap().owner_id
        );
        assert_ne!(
            scope(&identity("issuer", "Alice")).unwrap().owner_id,
            scope(&identity("issuer", "alice")).unwrap().owner_id
        );
        assert!(scope(&identity("", "alice")).is_err());
    }

    fn oidc_policy() -> regional::Policy {
        regional::Policy {
            workspace_id: Uuid::new_v4().to_string(),
            organization_id: Uuid::new_v4().to_string(),
            user_id: Uuid::new_v4().to_string(),
            region_id: "region:a".into(),
            generation: 1,
            denied: false,
            identity: regional::OwnerIdentity::Oidc {
                issuer: "https://issuer.example".into(),
                subject: "alice".into(),
            },
        }
    }

    #[tokio::test]
    async fn regional_policy_rejects_other_accounts_and_stale_or_conflicting_updates() {
        use regional::{Policies, Principal};
        let metadata = Arc::new(MemoryMeta {
            authority: Some("region:a".into()),
            ..Default::default()
        });
        let policies = Policies::open(metadata, "region:a").await.unwrap();
        let policy = oidc_policy();
        let command = Uuid::new_v4().to_string();
        assert_eq!(
            policies
                .authorize_owner(
                    &policy.workspace_id,
                    Principal::Oidc {
                        issuer: "https://issuer.example",
                        subject: "alice"
                    }
                )
                .await
                .err()
                .unwrap()
                .code,
            "POLICY_NOT_INSTALLED"
        );
        policies.install(&policy, &command).await.unwrap();
        policies.install(&policy, &command).await.unwrap();
        policies
            .authorize_owner(
                &policy.workspace_id,
                Principal::Oidc {
                    issuer: "https://issuer.example",
                    subject: "alice",
                },
            )
            .await
            .unwrap();
        assert_eq!(
            policies
                .authorize_owner(
                    &policy.workspace_id,
                    Principal::Oidc {
                        issuer: "https://issuer.example",
                        subject: "bob"
                    }
                )
                .await
                .err()
                .unwrap()
                .code,
            "POLICY_DENIED"
        );
        assert_eq!(
            policies
                .authorize_owner(
                    &Uuid::new_v4().to_string(),
                    Principal::Oidc {
                        issuer: "https://issuer.example",
                        subject: "alice"
                    }
                )
                .await
                .err()
                .unwrap()
                .code,
            "POLICY_NOT_INSTALLED"
        );
        let mut changed_owner = policy.clone();
        changed_owner.user_id = Uuid::new_v4().to_string();
        changed_owner.generation = 2;
        assert_eq!(
            policies
                .install(&changed_owner, &Uuid::new_v4().to_string())
                .await
                .err()
                .unwrap()
                .code,
            "POLICY_OWNER_MISMATCH"
        );
        let mut denied = policy.clone();
        denied.denied = true;
        denied.generation = 2;
        policies
            .install(&denied, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        assert_eq!(
            policies
                .install(&policy, &command)
                .await
                .err()
                .unwrap()
                .code,
            "POLICY_STALE"
        );
        assert_eq!(
            policies
                .authorize_owner(
                    &policy.workspace_id,
                    Principal::Oidc {
                        issuer: "https://issuer.example",
                        subject: "alice"
                    }
                )
                .await
                .err()
                .unwrap()
                .code,
            "POLICY_DENIED"
        );
        let mut conflicting = denied;
        conflicting.denied = false;
        assert_eq!(
            policies
                .install(&conflicting, &Uuid::new_v4().to_string())
                .await
                .err()
                .unwrap()
                .code,
            "POLICY_GENERATION_MISMATCH"
        );
    }

    #[tokio::test]
    async fn regional_guest_policy_expires_without_global_and_rejects_other_secrets() {
        use regional::{OwnerIdentity, Policies, Principal};
        let metadata = Arc::new(MemoryMeta {
            authority: Some("region:a".into()),
            ..Default::default()
        });
        let policies = Policies::open(metadata, "region:a").await.unwrap();
        let mut policy = oidc_policy();
        let guest_id = Uuid::new_v4().to_string();
        let secret_bytes = [42u8; 32];
        let secret = hex::encode(secret_bytes);
        let current = now().unwrap();
        policy.identity = OwnerIdentity::Guest {
            guest_id: guest_id.clone(),
            verifier: hex::encode(Sha256::digest(secret_bytes)),
            created_at: current - 86_400,
            expires_at: current,
        };
        policies
            .install(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        assert_eq!(
            policies
                .authorize_owner(
                    &policy.workspace_id,
                    Principal::Guest {
                        guest_id: &guest_id,
                        secret: &secret
                    }
                )
                .await
                .err()
                .unwrap()
                .code,
            "POLICY_DENIED"
        );
        let mut active = oidc_policy();
        active.identity = OwnerIdentity::Guest {
            guest_id: guest_id.clone(),
            verifier: hex::encode(Sha256::digest(secret_bytes)),
            created_at: current,
            expires_at: current + 86_400,
        };
        policies
            .install(&active, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        policies
            .authorize_owner(
                &active.workspace_id,
                Principal::Guest {
                    guest_id: &guest_id,
                    secret: &secret,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            policies
                .authorize_owner(
                    &active.workspace_id,
                    Principal::Guest {
                        guest_id: &guest_id,
                        secret: &hex::encode([43u8; 32])
                    }
                )
                .await
                .err()
                .unwrap()
                .code,
            "POLICY_DENIED"
        );
    }
}
