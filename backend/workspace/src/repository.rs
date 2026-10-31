use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::RwLock;
use uuid::Uuid;
use workspace_contracts::{MetaRequest, Metadata, Result, Scope, ServiceError, WriterGuard};

fn error(code: &str) -> ServiceError {
    ServiceError::new(503, code)
}
fn version(record: &Value) -> Value {
    record.get("version").cloned().unwrap_or(Value::Null)
}
type Records = BTreeMap<String, Value>;
pub struct Repository {
    metadata: Arc<dyn Metadata>,
    scope: Scope,
    guard: WriterGuard,
    queue: RwLock<()>,
    closed: AtomicBool,
}
impl Repository {
    /// The scope is established by the host, not by a customer request.
    pub fn authority_id(&self) -> &str {
        &self.scope.authority_id
    }

    pub fn workspace_id(&self) -> &str {
        &self.scope.owner_id
    }

    pub async fn open(
        metadata: Arc<dyn Metadata>,
        authority: &str,
        workspace: &str,
        initialize: bool,
        recover: Option<&str>,
    ) -> Result<Self> {
        let health = metadata.health().await?;
        if health["authorityId"] != authority
            || !health["capabilities"]
                .as_array()
                .is_some_and(|v| v.contains(&json!("recordsV1")))
        {
            return Err(error("META_PROTOCOL_UNSUPPORTED"));
        }
        let scope = Scope {
            authority_id: authority.into(),
            owner_kind: "workspace".into(),
            owner_id: workspace.into(),
            family: "workspace".into(),
            partition_id: "primary".into(),
        };
        let prior = metadata
            .execute(MetaRequest::Get {
                scope: scope.clone(),
                guard: None,
                keys: vec!["system/writer".into()],
            })
            .await?;
        let writer = &prior["records"]["system/writer"];
        if let Some(owner) = writer["value"]["ownerId"].as_str()
            && Some(owner) != recover
        {
            return Err(error("META_WRITER_ACTIVE"));
        }
        let owner = Uuid::new_v4().to_string();
        metadata.execute(MetaRequest::Commit{scope:scope.clone(),guard:None,mutation_id:Uuid::new_v4().to_string(),changes:vec![json!({"key":"system/writer","expectedVersion":version(writer),"value":{"ownerId":owner}})]}).await?;
        let result = Self {
            metadata,
            scope,
            guard: WriterGuard { owner_id: owner },
            queue: RwLock::new(()),
            closed: AtomicBool::new(false),
        };
        let initialized=async {
            let core=result.get("state/workspace").await?;
            if core.is_null() {
                if !initialize {return Err(error("META_WORKSPACE_MISSING"));}
                let state=json!({"workspace":{"id":workspace,"name":"My Workspace","description":"","plan":"Free","createdAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)},"profile":{"name":"Local developer","email":"","role":"Local developer"},"resources":[],"keys":[],"files":[],"events":[],"idempotency":{},"resourceQueryCounts":{},"queryCount":0});
                let records=flatten(&state,&Records::new())?;
                result.commit(records.into_iter().map(|(key,value)|json!({"key":key,"expectedVersion":null,"value":value})).collect()).await?;
            } else if core["value"]["id"]!=workspace {return Err(error("META_WORKSPACE_MISMATCH"));}
            Ok(())
        }.await;
        if let Err(e) = initialized {
            let _ = result.close().await;
            return Err(e);
        }
        Ok(result)
    }
    async fn call(&self, request: MetaRequest) -> Result<Value> {
        if self.closed.load(Ordering::Acquire) {
            return Err(error("META_WRITER_CLOSED"));
        }
        self.metadata.execute(request).await
    }
    pub async fn get(&self, key: &str) -> Result<Value> {
        let v = self
            .call(MetaRequest::Get {
                scope: self.scope.clone(),
                guard: Some(self.guard.clone()),
                keys: vec![key.into()],
            })
            .await?;
        Ok(v["records"][key].clone())
    }

    /// Check the Region-owned policy for an explicitly managed personal Workspace. This
    /// does not apply to the legacy shared Workspace, and never contacts Global. A missing
    /// ownership marker or policy fails closed. The caller must still authenticate the
    /// specific session or Key, and reauthorize long-running work at effect boundaries.
    pub async fn managed_owner(&self) -> Result<(String, u64)> {
        let ownership = self.get("ownership/onboarding").await?;
        let marker = &ownership["value"];
        let user = marker["userId"]
            .as_str()
            .ok_or_else(|| error("MANAGED_POLICY_MISSING"))?;
        let organization = marker["organizationId"]
            .as_str()
            .ok_or_else(|| error("MANAGED_POLICY_MISSING"))?;
        if marker["workspaceId"] != self.scope.owner_id
            || Uuid::parse_str(user).is_err()
            || Uuid::parse_str(organization).is_err()
        {
            return Err(error("MANAGED_POLICY_MISSING"));
        }
        let mut scope = self.scope.clone();
        scope.family = "regional-policy".into();
        let response = self
            .call(MetaRequest::Get {
                scope,
                guard: None,
                keys: vec!["owner-policy".into()],
            })
            .await?;
        let policy = &response["records"]["owner-policy"]["value"];
        let generation = policy["generation"]
            .as_u64()
            .filter(|v| *v > 0)
            .ok_or_else(|| error("MANAGED_POLICY_MISSING"))?;
        if policy["workspaceId"] != self.scope.owner_id
            || policy["regionId"] != self.scope.authority_id
            || policy["organizationId"] != organization
            || policy["userId"] != user
            || !policy["denied"].is_boolean()
        {
            return Err(error("MANAGED_POLICY_MISSING"));
        }
        if policy["denied"] == true {
            return Err(ServiceError::new(403, "POLICY_DENIED"));
        }
        match policy["identity"]["kind"].as_str() {
            Some("oidc")
                if policy["identity"]["issuer"]
                    .as_str()
                    .is_some_and(|v| !v.is_empty())
                    && policy["identity"]["subject"]
                        .as_str()
                        .is_some_and(|v| !v.is_empty()) => {}
            Some("guest") => {
                let guest_id = policy["identity"]["guestId"]
                    .as_str()
                    .ok_or_else(|| error("MANAGED_POLICY_MISSING"))?;
                let verifier = policy["identity"]["verifier"]
                    .as_str()
                    .ok_or_else(|| error("MANAGED_POLICY_MISSING"))?;
                if Uuid::parse_str(guest_id).is_err()
                    || verifier.len() != 64
                    || !hex::decode(verifier).is_ok_and(|value| value.len() == 32)
                {
                    return Err(error("MANAGED_POLICY_MISSING"));
                }
                let expiry = policy["identity"]["expiresAt"]
                    .as_i64()
                    .ok_or_else(|| error("MANAGED_POLICY_MISSING"))?;
                let created = policy["identity"]["createdAt"]
                    .as_i64()
                    .ok_or_else(|| error("MANAGED_POLICY_MISSING"))?;
                if created.checked_add(86_400) != Some(expiry) {
                    return Err(error("MANAGED_POLICY_MISSING"));
                }
                if chrono::Utc::now().timestamp() >= expiry {
                    return Err(ServiceError::new(401, "GUEST_EXPIRED"));
                }
            }
            _ => return Err(error("MANAGED_POLICY_MISSING")),
        }
        Ok((user.into(), generation))
    }
    async fn commit(&self, changes: Vec<Value>) -> Result<()> {
        if changes.is_empty() {
            return Ok(());
        }
        self.call(MetaRequest::Commit {
            scope: self.scope.clone(),
            guard: Some(self.guard.clone()),
            mutation_id: Uuid::new_v4().to_string(),
            changes,
        })
        .await?;
        Ok(())
    }
    async fn records(&self, prefix: &str) -> Result<Records> {
        let mut after = None;
        let mut result = Records::new();
        let mut bytes = 0;
        loop {
            let page = self
                .call(MetaRequest::List {
                    scope: self.scope.clone(),
                    guard: Some(self.guard.clone()),
                    prefix: prefix.into(),
                    after,
                    limit: 100,
                })
                .await?;
            let values = page["records"]
                .as_array()
                .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
            for record in values {
                let key = record["key"]
                    .as_str()
                    .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
                bytes += serde_json::to_vec(record)
                    .map_err(|_| error("META_RECORD_CORRUPT"))?
                    .len();
                if result.len() >= 4096 || bytes > 24 * 1024 * 1024 {
                    return Err(ServiceError::new(413, "WORKSPACE_VIEW_LIMIT"));
                }
                if result
                    .insert(
                        key.into(),
                        json!({"version":record["version"],"value":record["value"]}),
                    )
                    .is_some()
                {
                    return Err(error("META_RECORD_CORRUPT"));
                }
            }
            after = page["nextCursor"].as_str().map(str::to_owned);
            if after.is_none() {
                break;
            }
        }
        Ok(result)
    }
    pub async fn read(&self) -> Result<Value> {
        let _lock = self.queue.write().await;
        inflate(&self.records("state/").await?)
    }
    pub async fn transaction<T>(
        &self,
        apply: impl FnOnce(&mut Value) -> Result<(T, bool)> + Send,
    ) -> Result<T> {
        let _lock = self.queue.write().await;
        let previous = self.records("state/").await?;
        self.apply_transaction(previous, apply).await
    }

    /// Key, settings and event operations need only their bounded collections and the
    /// resources named in grants/events. Keep the legacy gate until all writers migrate.
    pub async fn workspace_transaction<T>(
        &self,
        selected_resources: Vec<String>,
        include_event_resources: bool,
        include_files: bool,
        apply: impl FnOnce(&mut Value) -> Result<(T, bool)> + Send,
    ) -> Result<T> {
        let _lock = self.queue.write().await;
        let mut previous = self.records("state/keys/").await?;
        previous.extend(self.records("state/events/").await?);
        if include_files {
            previous.extend(self.records("state/files/").await?);
        }
        for key in ["state/workspace", "state/profile"] {
            let value = self.get(key).await?;
            if !value.is_null() {
                previous.insert(key.into(), value);
            }
        }
        let mut ids = selected_resources
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>();
        if include_event_resources {
            ids.extend(
                previous
                    .iter()
                    .filter(|(key, _)| key.starts_with("state/events/"))
                    .filter_map(|(_, value)| {
                        value["value"]["record"]["resourceId"]
                            .as_str()
                            .map(str::to_owned)
                    }),
            );
        }
        let paths = ids
            .into_iter()
            .filter(|id| {
                id != "*"
                    && !id.is_empty()
                    && id.len() <= 496
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"/_-.:".contains(&b))
            })
            .map(|id| format!("state/resources/{id}"))
            .collect::<Vec<_>>();
        for batch in paths.chunks(512) {
            let result = self
                .call(MetaRequest::Get {
                    scope: self.scope.clone(),
                    guard: Some(self.guard.clone()),
                    keys: batch.to_vec(),
                })
                .await?;
            for key in batch {
                let value = &result["records"][key];
                if !value.is_null() {
                    previous.insert(key.clone(), value.clone());
                }
            }
        }
        self.apply_transaction(previous, apply).await
    }

    async fn apply_transaction<T>(
        &self,
        previous: Records,
        apply: impl FnOnce(&mut Value) -> Result<(T, bool)> + Send,
    ) -> Result<T> {
        let mut state = inflate(&previous)?;
        let (result, dirty) = apply(&mut state)?;
        if !dirty {
            return Ok(result);
        }
        let next = flatten(&state, &previous)?;
        let mut changes = Vec::new();
        for (key, value) in &next {
            if previous
                .get(key)
                .is_none_or(|prior| prior["value"] != *value)
            {
                changes.push(json!({"key":key,"expectedVersion":previous.get(key).map(version).unwrap_or(Value::Null),"value":value}));
            }
        }
        for (key, prior) in &previous {
            if !next.contains_key(key) {
                changes.push(json!({"key":key,"expectedVersion":version(prior),"delete":true}));
            }
        }
        // Digest indexes are committed with their canonical Key; authorization is a point lookup.
        let old_keys = inflate(&previous)?["keys"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let new_keys = state["keys"]
            .as_array()
            .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
        for key in &old_keys {
            if !new_keys.iter().any(|k| k["digest"] == key["digest"]) {
                let path = format!(
                    "indexes/key-digest/{}",
                    key["digest"]
                        .as_str()
                        .ok_or_else(|| error("META_RECORD_CORRUPT"))?
                );
                let prior = self.get(&path).await?;
                if !prior.is_null() {
                    changes
                        .push(json!({"key":path,"expectedVersion":version(&prior),"delete":true}));
                }
            }
        }
        for key in new_keys {
            if !old_keys.iter().any(|k| k["digest"] == key["digest"]) {
                let path = format!(
                    "indexes/key-digest/{}",
                    key["digest"]
                        .as_str()
                        .ok_or_else(|| error("META_RECORD_CORRUPT"))?
                );
                let prior = self.get(&path).await?;
                changes
                    .push(json!({"key":path,"expectedVersion":version(&prior),"value":key["id"]}));
            }
        }
        self.commit(changes).await?;
        Ok(result)
    }
    pub async fn resource(&self, id: &str) -> Result<Value> {
        Ok(self.get(&format!("state/resources/{id}")).await?["value"]["record"].clone())
    }

    /// Keep the legacy event retention and ordering without loading unrelated resources.
    /// The write gate coordinates this append with legacy snapshot transactions.
    pub async fn append_event(&self, event: Value) -> Result<()> {
        let id = event["id"]
            .as_str()
            .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
        let _lock = self.queue.write().await;
        let previous = self.records("state/events/").await?;
        let mut ordered = previous.iter().collect::<Vec<_>>();
        ordered.sort_by(|(key_a, a), (key_b, b)| {
            a["value"]["position"]
                .as_u64()
                .unwrap_or(0)
                .cmp(&b["value"]["position"].as_u64().unwrap_or(0))
                .then_with(|| key_a.cmp(key_b))
        });
        let position = ordered
            .last()
            .map(|(_, record)| record["value"]["position"].as_u64().unwrap_or(0))
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
        let key = format!("state/events/{id}");
        let mut changes = vec![
            json!({"key":key,"expectedVersion":null,"value":{"position":position,"record":event}}),
        ];
        for (key, prior) in ordered.into_iter().take(previous.len().saturating_sub(199)) {
            changes.push(json!({"key":key,"expectedVersion":version(prior),"delete":true}));
        }
        self.commit(changes).await
    }

    pub async fn resources_by_id(&self, ids: &[&str]) -> Result<Vec<Value>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let keys = ids
            .iter()
            .map(|id| format!("state/resources/{id}"))
            .collect::<Vec<_>>();
        let result = self
            .call(MetaRequest::Get {
                scope: self.scope.clone(),
                guard: Some(self.guard.clone()),
                keys: keys.clone(),
            })
            .await?;
        let mut resources = Vec::with_capacity(ids.len());
        for (id, key) in ids.iter().zip(keys) {
            let stored = &result["records"][&key];
            if stored.is_null() {
                continue;
            }
            let resource = &stored["value"]["record"];
            if resource["id"] != *id {
                return Err(error("META_RECORD_CORRUPT"));
            }
            resources.push(resource.clone());
        }
        Ok(resources)
    }

    /// Coordinate with legacy snapshots while allowing independent point updates to
    /// proceed concurrently. Retry only a confirmed CAS conflict, never an unknown commit.
    pub async fn update_resource<T>(
        &self,
        id: &str,
        apply: impl Fn(&mut Value) -> Result<T> + Send,
    ) -> Result<T> {
        let _lock = self.queue.read().await;
        let key = format!("state/resources/{id}");
        for attempt in 0..4 {
            let stored = self.get(&key).await?;
            let mut value = stored["value"].clone();
            if value["record"]["id"] != id {
                return Err(ServiceError::new(404, "NOT_FOUND"));
            }
            let result = apply(&mut value["record"])?;
            if value == stored["value"] {
                return Ok(result);
            }
            match self
                .commit(vec![
                    json!({"key":key,"expectedVersion":version(&stored),"value":value}),
                ])
                .await
            {
                Ok(()) => return Ok(result),
                Err(error) if error.code == "META_CONFLICT" && attempt < 3 => continue,
                Err(error) => return Err(error),
            }
        }
        unreachable!()
    }

    /// Bounded ID-ordered inventory. Guest cleanup must first fence and drain its operations.
    pub async fn resources_page(
        &self,
        after: Option<String>,
        limit: usize,
    ) -> Result<(Vec<Value>, Option<String>)> {
        if limit == 0 || limit > 512 {
            return Err(ServiceError::new(400, "INVALID_PAGE_LIMIT"));
        }
        let page = self
            .call(MetaRequest::List {
                scope: self.scope.clone(),
                guard: Some(self.guard.clone()),
                prefix: "state/resources/".into(),
                after,
                limit,
            })
            .await?;
        let records = page["records"]
            .as_array()
            .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
        let mut resources = Vec::with_capacity(records.len());
        for entry in records {
            let value = entry["value"]["record"].clone();
            let id = value["id"]
                .as_str()
                .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
            if entry["key"] != format!("state/resources/{id}") {
                return Err(error("META_RECORD_CORRUPT"));
            }
            resources.push(value);
        }
        Ok((resources, page["nextCursor"].as_str().map(str::to_owned)))
    }
    pub async fn authenticate_key(&self, token: &str) -> Result<crate::Principal> {
        let _lock = self.queue.write().await;
        let state = self
            .key_state(&hex::encode(Sha256::digest(token.as_bytes())))
            .await?;
        let credential = crate::Credential::Bearer(token.into());
        let principal = crate::principal(&state, &credential)?;
        let path = format!("state/keys/{}", principal.id);
        let mut stored = self.get(&path).await?;
        let current = stored["value"]["record"].clone();
        // Revalidate the canonical record before touching usage; revocations never rely on an index/cache.
        let principal = crate::principal(&json!({"keys":[current]}), &credential)?;
        let recent = stored["value"]["record"]["lastUsedAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .is_some_and(|t| {
                chrono::Utc::now().signed_duration_since(t) < chrono::Duration::minutes(1)
            });
        if !recent {
            stored["value"]["record"]["lastUsedAt"] =
                json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            self.commit(vec![
                json!({"key":path,"expectedVersion":version(&stored),"value":stored["value"]}),
            ])
            .await?;
        }
        Ok(principal)
    }
    pub async fn key_state(&self, digest: &str) -> Result<Value> {
        let index = self.get(&format!("indexes/key-digest/{digest}")).await?;
        let Some(id) = index["value"].as_str() else {
            return Ok(json!({"keys":[]}));
        };
        let key = self.get(&format!("state/keys/{id}")).await?;
        if key["value"]["record"]["digest"] != digest {
            return Err(error("META_RECORD_CORRUPT"));
        }
        Ok(json!({"keys":[key["value"]["record"]]}))
    }
    pub async fn binding(&self, provider: &str, id: &str) -> Result<Value> {
        let keys = vec![
            format!("bindings/{provider}/{id}"),
            format!("credentials/{provider}/{id}"),
        ];
        let r = self
            .call(MetaRequest::Get {
                scope: self.scope.clone(),
                guard: Some(self.guard.clone()),
                keys: keys.clone(),
            })
            .await?;
        let mut value = r["records"][&keys[0]]["value"].clone();
        if let Some(object) = value.as_object_mut() {
            object.remove("credentialRef");
            if let Some(secret) = r["records"][&keys[1]]["value"].as_object() {
                object.extend(secret.clone());
            }
        }
        Ok(value)
    }
    pub async fn save_binding(&self, provider: &str, id: &str, value: Value) -> Result<()> {
        let _lock = self.queue.write().await;
        let mut public = serde_json::Map::new();
        let mut secret = serde_json::Map::new();
        let keys = [
            format!("bindings/{provider}/{id}"),
            format!("credentials/{provider}/{id}"),
        ];
        if let Some(value) = value.as_object() {
            for (key, value) in value {
                if [
                    "state",
                    "storageId",
                    "instanceId",
                    "expiresAt",
                    "name",
                    "role",
                    "user",
                ]
                .contains(&key.as_str())
                {
                    public.insert(key.clone(), value.clone());
                } else {
                    secret.insert(key.clone(), value.clone());
                }
            }
        }
        if !secret.is_empty() {
            public.insert("credentialRef".into(), json!(keys[1]));
        }
        let old = self
            .call(MetaRequest::Get {
                scope: self.scope.clone(),
                guard: Some(self.guard.clone()),
                keys: keys.to_vec(),
            })
            .await?;
        let mut changes = Vec::new();
        for (path, map) in keys.into_iter().zip([public, secret]) {
            let prior = &old["records"][&path];
            if map.is_empty() {
                if !prior.is_null() {
                    changes
                        .push(json!({"key":path,"expectedVersion":version(prior),"delete":true}));
                }
            } else {
                changes.push(json!({"key":path,"expectedVersion":version(prior),"value":map}));
            }
        }
        self.commit(changes).await
    }
    pub async fn account(&self, provider: &str) -> Result<Value> {
        Ok(self
            .get(&format!("credentials/accounts/{provider}"))
            .await?["value"]
            .clone())
    }
    pub async fn save_account(&self, provider: &str, value: Value) -> Result<()> {
        let _lock = self.queue.write().await;
        let path = format!("credentials/accounts/{provider}");
        let prior = self.get(&path).await?;
        self.commit(vec![
            json!({"key":path,"expectedVersion":version(&prior),"value":value}),
        ])
        .await
    }
    pub async fn health(&self) -> Result<()> {
        let workspace = self.get("state/workspace").await?;
        if workspace.is_null() {
            return Err(error("META_WORKSPACE_MISSING"));
        }
        Ok(())
    }

    /// Operator-only retirement of the old shared hosted Workspace. This removes live
    /// metadata and credentials, not historical S3 object versions or provider resources.
    /// The repository's exclusive writer must be held and the API stopped beforehand.
    pub async fn purge_legacy_records(&self) -> Result<()> {
        if self.scope.owner_id != "ws_agentlab"
            || !self.get("ownership/onboarding").await?.is_null()
        {
            return Err(ServiceError::new(403, "LEGACY_PURGE_DENIED"));
        }
        let _lock = self.queue.write().await;
        let mut after = None;
        loop {
            let page = self
                .call(MetaRequest::List {
                    scope: self.scope.clone(),
                    guard: Some(self.guard.clone()),
                    prefix: "".into(),
                    after,
                    limit: 100,
                })
                .await?;
            let records = page["records"]
                .as_array()
                .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
            let mut changes = Vec::new();
            for record in records {
                let key = record["key"]
                    .as_str()
                    .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
                if key != "system/writer" && key != "state/workspace" {
                    let version = record["version"]
                        .as_str()
                        .filter(|v| !v.is_empty())
                        .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
                    changes.push(json!({"key": key, "expectedVersion": version, "delete": true}));
                }
            }
            self.commit(changes).await?;
            after = page["nextCursor"].as_str().map(str::to_owned);
            if after.is_none() {
                break;
            }
        }
        // Keep the core record until every other page is gone so an interrupted purge can
        // reopen the same Workspace. Remove the core and writer atomically at the end.
        let core = self.get("state/workspace").await?;
        let writer = self.get("system/writer").await?;
        if core.is_null() || writer["value"]["ownerId"] != self.guard.owner_id {
            return Err(error("LEGACY_PURGE_STATE_INVALID"));
        }
        self.commit(vec![
            json!({"key":"state/workspace", "expectedVersion":version(&core), "delete":true}),
            json!({"key":"system/writer", "expectedVersion":version(&writer), "delete":true}),
        ])
        .await?;
        self.closed.store(true, Ordering::Release);
        Ok(())
    }
    pub async fn close(&self) -> Result<()> {
        let _lock = self.queue.write().await;
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let prior = self
            .metadata
            .execute(MetaRequest::Get {
                scope: self.scope.clone(),
                guard: None,
                keys: vec!["system/writer".into()],
            })
            .await?;
        let writer = &prior["records"]["system/writer"];
        if writer["value"]["ownerId"] == self.guard.owner_id {
            self.metadata.execute(MetaRequest::Commit{scope:self.scope.clone(),guard:Some(self.guard.clone()),mutation_id:Uuid::new_v4().to_string(),changes:vec![json!({"key":"system/writer","expectedVersion":version(writer),"delete":true})]}).await?;
        }
        Ok(())
    }
}
fn inflate(records: &Records) -> Result<Value> {
    let mut state = json!({"resources":[],"keys":[],"files":[],"events":[],"idempotency":{},"resourceQueryCounts":{}});
    for (key, envelope) in records {
        let path = key
            .strip_prefix("state/")
            .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
        let value = envelope["value"].clone();
        if let Some((family, _id)) = path.split_once('/') {
            if ["resources", "keys", "files", "events"].contains(&family) {
                state[family]
                    .as_array_mut()
                    .ok_or_else(|| error("META_RECORD_CORRUPT"))?
                    .push(value);
            } else if ["idempotency", "resourceQueryCounts"].contains(&family) {
                let logical = value["mapKey"]
                    .as_str()
                    .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
                state[family][logical] = value["record"].clone();
            } else {
                return Err(error("META_RECORD_CORRUPT"));
            }
        } else {
            state[path] = value;
        }
    }
    for name in ["resources", "keys", "files", "events"] {
        let values = state[name]
            .as_array_mut()
            .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
        values.sort_by_key(|v| v["position"].as_u64().unwrap_or(0));
        if name == "events" {
            values.reverse();
        }
        for v in values {
            *v = v["record"].clone();
        }
    }
    if !state["workspace"].is_object() || !state["profile"].is_object() {
        return Err(error("META_RECORD_CORRUPT"));
    }
    Ok(state)
}
fn flatten(state: &Value, previous: &Records) -> Result<BTreeMap<String, Value>> {
    let mut result = BTreeMap::new();
    for (family, value) in state
        .as_object()
        .ok_or_else(|| error("META_RECORD_CORRUPT"))?
    {
        if ["resources", "keys", "files", "events"].contains(&family.as_str()) {
            let values = value
                .as_array()
                .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
            let prefix = format!("state/{family}/");
            let maximum = previous
                .iter()
                .filter(|(k, _)| k.starts_with(&prefix))
                .filter_map(|(_, v)| v["value"]["position"].as_u64())
                .max()
                .unwrap_or(0);
            let mut next = maximum + 1;
            let mut new_events = values
                .iter()
                .filter(|v| {
                    v["id"]
                        .as_str()
                        .is_some_and(|id| !previous.contains_key(&format!("{prefix}{id}")))
                })
                .count() as u64;
            for item in values {
                let id = item["id"]
                    .as_str()
                    .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
                let key = format!("{prefix}{id}");
                let position = previous
                    .get(&key)
                    .and_then(|v| v["value"]["position"].as_u64())
                    .unwrap_or_else(|| {
                        if family == "events" {
                            let p = maximum + new_events;
                            new_events -= 1;
                            p
                        } else {
                            let p = next;
                            next += 1;
                            p
                        }
                    });
                if result
                    .insert(key, json!({"position":position,"record":item}))
                    .is_some()
                {
                    return Err(error("META_RECORD_CORRUPT"));
                }
            }
        } else if ["idempotency", "resourceQueryCounts"].contains(&family.as_str()) {
            for (key, item) in value
                .as_object()
                .ok_or_else(|| error("META_RECORD_CORRUPT"))?
            {
                result.insert(
                    format!(
                        "state/{family}/{}",
                        hex::encode(Sha256::digest(key.as_bytes()))
                    ),
                    json!({"mapKey":key,"record":item}),
                );
            }
        } else {
            result.insert(format!("state/{family}"), value.clone());
        }
    }
    Ok(result)
}

#[cfg(test)]
mod concurrency_tests {
    use super::*;
    use tokio::sync::Notify;
    use workspace_contracts::Call;

    struct MetadataGate {
        values: std::sync::Mutex<Records>,
        paused: Notify,
        resume: Notify,
        first: AtomicBool,
    }

    impl Metadata for MetadataGate {
        fn health(&self) -> Call<'_> {
            Box::pin(async { Ok(json!({})) })
        }

        fn execute(&self, request: MetaRequest) -> Call<'_> {
            Box::pin(async move {
                match request {
                    MetaRequest::Get { keys, .. } => {
                        if keys == ["state/resources/a"] && self.first.swap(false, Ordering::AcqRel)
                        {
                            self.paused.notify_one();
                            self.resume.notified().await;
                        }
                        let values = self.values.lock().unwrap();
                        let records = keys
                            .into_iter()
                            .map(|key| {
                                let value = values.get(&key).cloned().unwrap_or(Value::Null);
                                (key, value)
                            })
                            .collect::<serde_json::Map<_, _>>();
                        Ok(json!({"records":records}))
                    }
                    MetaRequest::Commit { changes, .. } => {
                        let mut values = self.values.lock().unwrap();
                        for change in changes {
                            let key = change["key"].as_str().unwrap();
                            if version(values.get(key).unwrap_or(&Value::Null))
                                != change["expectedVersion"]
                            {
                                return Err(ServiceError::new(409, "META_CONFLICT"));
                            }
                            if change["delete"] == true {
                                values.remove(key);
                            } else {
                                values.insert(key.into(), json!({"version":Uuid::new_v4().to_string(),"value":change["value"]}));
                            }
                        }
                        Ok(json!({}))
                    }
                    MetaRequest::List {
                        prefix,
                        after,
                        limit,
                        ..
                    } => {
                        let values = self.values.lock().unwrap();
                        let mut selected = values
                            .iter()
                            .filter(|(key, _)| {
                                key.starts_with(&prefix)
                                    && after.as_ref().is_none_or(|cursor| *key > cursor)
                            })
                            .take(limit + 1)
                            .collect::<Vec<_>>();
                        let more = selected.len() > limit;
                        if more {
                            selected.pop();
                        }
                        let cursor = if more {
                            selected.last().map(|(key, _)| (*key).clone())
                        } else {
                            None
                        };
                        let records = selected.into_iter().map(|(key, value)|
                            json!({"key":key,"version":value["version"],"value":value["value"]})
                        ).collect::<Vec<_>>();
                        Ok(json!({"records":records,"nextCursor":cursor}))
                    }
                    _ => panic!("unexpected request"),
                }
            })
        }
    }

    #[tokio::test]
    async fn independent_point_updates_do_not_wait_for_a_stalled_resource() {
        let metadata = Arc::new(MetadataGate {
            values: std::sync::Mutex::new(
                ["a", "b"]
                    .into_iter()
                    .map(|id| {
                        (
                            format!("state/resources/{id}"),
                            json!({"version":"v1","value":{"position":0,"record":{"id":id,"n":0}}}),
                        )
                    })
                    .collect(),
            ),
            paused: Notify::new(),
            resume: Notify::new(),
            first: AtomicBool::new(true),
        });
        let repository = Arc::new(Repository {
            metadata: metadata.clone(),
            scope: Scope {
                authority_id: "region:test".into(),
                owner_kind: "workspace".into(),
                owner_id: "test".into(),
                family: "workspace".into(),
                partition_id: "primary".into(),
            },
            guard: WriterGuard {
                owner_id: "test".into(),
            },
            queue: RwLock::new(()),
            closed: AtomicBool::new(false),
        });
        let stalled = tokio::spawn({
            let repository = repository.clone();
            async move {
                repository
                    .update_resource("a", |resource| {
                        resource["n"] = json!(1);
                        Ok(())
                    })
                    .await
            }
        });
        metadata.paused.notified().await;
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            repository.update_resource("b", |resource| {
                resource["n"] = json!(2);
                Ok(())
            }),
        )
        .await
        .expect("independent update was serialized")
        .unwrap();
        metadata.resume.notify_one();
        stalled.await.unwrap().unwrap();
        let values = metadata.values.lock().unwrap();
        assert_eq!(values["state/resources/a"]["value"]["record"]["n"], 1);
        assert_eq!(values["state/resources/b"]["value"]["record"]["n"], 2);
    }

    #[tokio::test]
    async fn event_append_keeps_only_the_most_recent_200() {
        let metadata = Arc::new(MetadataGate {
            values: std::sync::Mutex::new(
                (0..200)
                    .map(|n| {
                        let id = format!("event-{n:03}");
                        (
                            format!("state/events/{id}"),
                            json!({"version":"v1","value":{"position":n,"record":{"id":id}}}),
                        )
                    })
                    .collect(),
            ),
            paused: Notify::new(),
            resume: Notify::new(),
            first: AtomicBool::new(false),
        });
        let repository = Repository {
            metadata: metadata.clone(),
            scope: Scope {
                authority_id: "region:test".into(),
                owner_kind: "workspace".into(),
                owner_id: "test".into(),
                family: "workspace".into(),
                partition_id: "primary".into(),
            },
            guard: WriterGuard {
                owner_id: "test".into(),
            },
            queue: RwLock::new(()),
            closed: AtomicBool::new(false),
        };
        repository
            .append_event(json!({"id":"event-new"}))
            .await
            .unwrap();
        let values = metadata.values.lock().unwrap();
        assert_eq!(values.len(), 200);
        assert!(!values.contains_key("state/events/event-000"));
        assert_eq!(values["state/events/event-new"]["value"]["position"], 200);
    }
}
