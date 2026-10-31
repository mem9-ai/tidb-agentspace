mod event_index;
mod file_index;
mod resource_index;
mod setup_attempts;
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
#[derive(Clone, Copy)]
enum KeyLoad<'a> {
    All,
    Credential(&'a crate::Credential),
    One(&'a str),
    None,
}
struct Projection<'a> {
    resources: Vec<String>,
    events: bool,
    files: bool,
    statistics: bool,
    keys: KeyLoad<'a>,
    exclusive: bool,
}
pub struct Repository {
    metadata: Arc<dyn Metadata>,
    scope: Scope,
    guard: WriterGuard,
    queue: RwLock<()>,
    closed: AtomicBool,
    resource_backfill_running: AtomicBool,
    resource_backfill_error: std::sync::Mutex<Option<ServiceError>>,
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
            resource_backfill_running: AtomicBool::new(false),
            resource_backfill_error: std::sync::Mutex::new(None),
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
        self.apply_transaction(previous, apply, false).await
    }

    /// Key, settings and event operations need only their bounded collections and the
    /// resources named in grants/events. Keep the legacy gate until all writers migrate.
    pub async fn workspace_transaction<T>(
        &self,
        selected_resources: Vec<String>,
        include_event_resources: bool,
        include_files: bool,
        include_statistics: bool,
        apply: impl FnOnce(&mut Value) -> Result<(T, bool)> + Send,
    ) -> Result<T> {
        let mut apply = Some(apply);
        self.projected_transaction(
            Projection {
                resources: selected_resources,
                events: include_event_resources,
                files: include_files,
                statistics: include_statistics,
                keys: KeyLoad::All,
                exclusive: true,
            },
            move |state| apply.take().expect("exclusive transaction invoked once")(state),
        )
        .await
    }

    /// Resource operations need only the caller's Key, never the whole Key collection.
    pub async fn resource_transaction<T>(
        &self,
        selected_resources: Vec<String>,
        include_event_resources: bool,
        include_files: bool,
        include_statistics: bool,
        credential: &crate::Credential,
        apply: impl FnMut(&mut Value) -> Result<(T, bool)> + Send,
    ) -> Result<T> {
        self.projected_transaction(
            Projection {
                resources: selected_resources,
                events: include_event_resources,
                files: include_files,
                statistics: include_statistics,
                keys: KeyLoad::Credential(credential),
                exclusive: false,
            },
            apply,
        )
        .await
    }

    pub async fn key_transaction<T>(
        &self,
        selected_resources: Vec<String>,
        key_id: Option<&str>,
        apply: impl FnMut(&mut Value) -> Result<(T, bool)> + Send,
    ) -> Result<T> {
        let keys = key_id.map_or(KeyLoad::None, KeyLoad::One);
        self.projected_transaction(
            Projection {
                resources: selected_resources,
                events: false,
                files: false,
                statistics: false,
                keys,
                exclusive: false,
            },
            apply,
        )
        .await
    }

    async fn projected_transaction<T>(
        &self,
        projection: Projection<'_>,
        mut apply: impl FnMut(&mut Value) -> Result<(T, bool)> + Send,
    ) -> Result<T> {
        if projection.exclusive {
            let _lock = self.queue.write().await;
            if projection.files {
                while !self.advance_file_index().await? {}
            }
            return self.projected_once(&projection, &mut apply, false).await;
        }
        if projection.files {
            loop {
                {
                    let _lock = self.queue.read().await;
                    if self.file_index_ready().await? {
                        break;
                    }
                }
                let lock = self.queue.write().await;
                let ready = self.advance_file_index().await?;
                drop(lock);
                if ready {
                    break;
                }
                tokio::task::yield_now().await;
            }
        }
        for attempt in 0..8 {
            let _lock = self.queue.read().await;
            match self.projected_once(&projection, &mut apply, true).await {
                Ok(result) => return Ok(result),
                Err(error) if error.code == "META_CONFLICT" && attempt < 7 => continue,
                Err(error) => return Err(error),
            }
        }
        unreachable!()
    }

    async fn projected_once<T>(
        &self,
        projection: &Projection<'_>,
        apply: &mut (impl FnMut(&mut Value) -> Result<(T, bool)> + Send),
        fence_reads: bool,
    ) -> Result<T> {
        let mut previous = match projection.keys {
            KeyLoad::All => self.records("state/keys/").await?,
            KeyLoad::Credential(crate::Credential::Bearer(token)) => {
                let digest = hex::encode(Sha256::digest(token.as_bytes()));
                let index = self.get(&format!("indexes/key-digest/{digest}")).await?;
                let mut keys = Records::new();
                if let Some(id) = index["value"].as_str() {
                    let path = format!("state/keys/{id}");
                    let key = self.get(&path).await?;
                    if key["value"]["record"]["digest"] != digest {
                        return Err(error("META_RECORD_CORRUPT"));
                    }
                    keys.insert(path, key);
                }
                keys
            }
            KeyLoad::One(id) => {
                let path = format!("state/keys/{id}");
                let value = self.get(&path).await?;
                let mut keys = Records::new();
                if !value.is_null() {
                    keys.insert(path, value);
                }
                keys
            }
            KeyLoad::Credential(_) | KeyLoad::None => Records::new(),
        };
        if projection.events {
            previous.extend(self.records("state/events/").await?);
        }
        for key in ["state/workspace", "state/profile", "state/queryCount"] {
            let value = self.get(key).await?;
            if !value.is_null() {
                previous.insert(key.into(), value);
            }
        }
        let selected_file_resources = projection.resources.clone();
        let mut ids = projection
            .resources
            .iter()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        if projection.statistics {
            for id in &ids {
                let key = format!(
                    "state/resourceQueryCounts/{}",
                    hex::encode(Sha256::digest(id.as_bytes()))
                );
                let value = self.get(&key).await?;
                if !value.is_null() {
                    if value["value"]["mapKey"] != *id {
                        return Err(error("META_RECORD_CORRUPT"));
                    }
                    previous.insert(key, value);
                }
            }
        }
        if projection.events {
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
        if projection.files {
            let filesystems = selected_file_resources
                .into_iter()
                .filter(|id| {
                    previous
                        .get(&format!("state/resources/{id}"))
                        .is_some_and(|record| record["value"]["record"]["kind"] == "filesystem")
                })
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            previous.extend(self.files_for_resources(&filesystems).await?);
        }
        self.apply_transaction(previous, apply, fence_reads).await
    }

    pub async fn view_selected(
        &self,
        ids: Vec<String>,
        include_files: bool,
        credential: Option<&crate::Credential>,
    ) -> Result<Value> {
        let keys = credential.map_or(KeyLoad::None, KeyLoad::Credential);
        self.projected_transaction(
            Projection {
                resources: ids,
                events: false,
                files: include_files,
                statistics: false,
                keys,
                exclusive: false,
            },
            |state| Ok((state.clone(), false)),
        )
        .await
    }

    async fn apply_transaction<T>(
        &self,
        previous: Records,
        apply: impl FnOnce(&mut Value) -> Result<(T, bool)> + Send,
        fence_reads: bool,
    ) -> Result<T> {
        let mut state = inflate(&previous)?;
        let (result, dirty) = apply(&mut state)?;
        if !dirty {
            return Ok(result);
        }
        let next = flatten(&state, &previous)?;
        let new_events = state["events"]
            .as_array()
            .ok_or_else(|| error("META_RECORD_CORRUPT"))?
            .iter()
            .filter(|event| {
                event["id"]
                    .as_str()
                    .is_some_and(|id| !previous.contains_key(&format!("state/events/{id}")))
            })
            .cloned()
            .collect::<Vec<_>>();
        if new_events.len() > 1 {
            return Err(error("EVENT_INDEX_BATCH_UNSUPPORTED"));
        }
        let mut changes = Vec::new();
        let mut file_updates = Vec::new();
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
                if key.starts_with("state/resources/")
                    && !self.get("indexes/resource-v1/schema").await?.is_null()
                {
                    return Err(error("RESOURCE_INDEX_BATCH_UNSUPPORTED"));
                }
                changes.push(json!({"key":key,"expectedVersion":version(prior),"delete":true}));
            }
        }
        for (key, value) in &next {
            if key.starts_with("state/files/")
                && previous
                    .get(key)
                    .is_none_or(|prior| prior["value"] != *value)
            {
                let before = previous
                    .get(key)
                    .map(|prior| &prior["value"]["record"])
                    .unwrap_or(&Value::Null);
                file_updates.push((before.clone(), value["record"].clone()));
            }
        }
        for (key, prior) in &previous {
            if key.starts_with("state/files/") && !next.contains_key(key) {
                file_updates.push((prior["value"]["record"].clone(), Value::Null));
            }
        }
        changes.extend(self.file_index_changes(&file_updates).await?);
        if let Some(event) = new_events.first() {
            changes.retain(|change| {
                !change["key"]
                    .as_str()
                    .is_some_and(|key| key.starts_with("state/events/"))
            });
            changes.extend(self.event_changes(event).await?);
        }
        let resource_changes = next
            .iter()
            .filter(|(key, value)| {
                key.starts_with("state/resources/")
                    && previous
                        .get(*key)
                        .is_none_or(|prior| prior["value"] != **value)
            })
            .collect::<Vec<_>>();
        if resource_changes.len() > 1 && !self.get("indexes/resource-v1/schema").await?.is_null() {
            return Err(error("RESOURCE_INDEX_BATCH_UNSUPPORTED"));
        }
        for (key, value) in resource_changes {
            let before = previous
                .get(key)
                .map(|v| &v["value"]["record"])
                .unwrap_or(&Value::Null);
            changes.extend(
                self.resource_index_changes(before, &value["record"])
                    .await?,
            );
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
                if !prior.is_null() {
                    return Err(error("KEY_DIGEST_CONFLICT"));
                }
                changes
                    .push(json!({"key":path,"expectedVersion":version(&prior),"value":key["id"]}));
            }
        }
        if fence_reads {
            // A Key revocation or resource transition racing this mutation must win or
            // force a fresh authorization/read before retry. These bounded no-op writes
            // act as version preconditions; unknown outcomes are never retried here.
            let written = changes
                .iter()
                .filter_map(|change| change["key"].as_str())
                .map(str::to_owned)
                .collect::<std::collections::BTreeSet<_>>();
            for (key, prior) in &previous {
                if (key.starts_with("state/keys/") || key.starts_with("state/resources/"))
                    && !written.contains(key)
                {
                    changes.push(
                        json!({"key":key,"expectedVersion":version(prior),"value":prior["value"]}),
                    );
                }
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
        let _lock = self.queue.read().await;
        for attempt in 0..8 {
            let changes = self.event_changes(&event).await?;
            match self.commit(changes).await {
                Ok(()) => return Ok(()),
                Err(error) if error.code == "META_CONFLICT" && attempt < 7 => continue,
                Err(error) => return Err(error),
            }
        }
        unreachable!()
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

    pub async fn keys_page(
        &self,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<Value>, Option<String>)> {
        if !(1..=512).contains(&limit) {
            return Err(ServiceError::new(400, "INVALID_PAGE_LIMIT"));
        }
        let after = cursor
            .map(|cursor| {
                if cursor.len() > 1024 {
                    return Err(ServiceError::new(400, "INVALID_PAGE_CURSOR"));
                }
                let id = String::from_utf8(
                    hex::decode(cursor)
                        .map_err(|_| ServiceError::new(400, "INVALID_PAGE_CURSOR"))?,
                )
                .map_err(|_| ServiceError::new(400, "INVALID_PAGE_CURSOR"))?;
                if id.is_empty()
                    || id.len() > 501
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
                {
                    return Err(ServiceError::new(400, "INVALID_PAGE_CURSOR"));
                }
                Ok(format!("state/keys/{id}"))
            })
            .transpose()?;
        let page = self
            .call(MetaRequest::List {
                scope: self.scope.clone(),
                guard: Some(self.guard.clone()),
                prefix: "state/keys/".into(),
                after,
                limit,
            })
            .await?;
        let records = page["records"]
            .as_array()
            .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
        let mut keys = Vec::with_capacity(records.len());
        for entry in records {
            let record = &entry["value"]["record"];
            let id = record["id"]
                .as_str()
                .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
            if entry["key"] != format!("state/keys/{id}") || !record.is_object() {
                return Err(error("META_RECORD_CORRUPT"));
            }
            keys.push(crate::key_view(record));
        }
        let next = page["nextCursor"]
            .as_str()
            .map(|key| {
                key.strip_prefix("state/keys/")
                    .map(hex::encode)
                    .ok_or_else(|| error("META_RECORD_CORRUPT"))
            })
            .transpose()?;
        Ok((keys, next))
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
            let mut changes =
                vec![json!({"key":key,"expectedVersion":version(&stored),"value":value})];
            changes.extend(
                self.resource_index_changes(&stored["value"]["record"], &value["record"])
                    .await?,
            );
            match self.commit(changes).await {
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
        // Authentication of unrelated Keys can proceed concurrently. The read gate still
        // fences legacy revocation transactions; the per-record CAS resolves simultaneous
        // last-used updates for the same Key without serializing every Workspace request.
        let _lock = self.queue.read().await;
        let digest = hex::encode(Sha256::digest(token.as_bytes()));
        let credential = crate::Credential::Bearer(token.into());
        for attempt in 0..4 {
            let state = self.key_state(&digest).await?;
            let principal = crate::principal(&state, &credential)?;
            let path = format!("state/keys/{}", principal.id);
            let mut stored = self.get(&path).await?;
            let current = stored["value"]["record"].clone();
            // Revocations never rely on the index or a cached principal.
            let principal = crate::principal(&json!({"keys":[current]}), &credential)?;
            let recent = stored["value"]["record"]["lastUsedAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .is_some_and(|t| {
                    chrono::Utc::now().signed_duration_since(t) < chrono::Duration::minutes(1)
                });
            if recent {
                return Ok(principal);
            }
            stored["value"]["record"]["lastUsedAt"] =
                json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            match self
                .commit(vec![
                    json!({"key":path,"expectedVersion":version(&stored),"value":stored["value"]}),
                ])
                .await
            {
                Ok(()) => return Ok(principal),
                Err(error) if error.code == "META_CONFLICT" && attempt < 3 => continue,
                Err(error) => return Err(error),
            }
        }
        unreachable!()
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
        fail_backfill_once: AtomicBool,
        fail_file_backfill_once: AtomicBool,
        fail_event_backfill_once: AtomicBool,
        forbid_event_scan: AtomicBool,
        forbid_file_scan: AtomicBool,
    }

    impl Metadata for MetadataGate {
        fn health(&self) -> Call<'_> {
            Box::pin(async { Ok(json!({})) })
        }

        fn execute(&self, request: MetaRequest) -> Call<'_> {
            Box::pin(async move {
                match request {
                    MetaRequest::Get { keys, .. } => {
                        let should_pause = keys == ["state/resources/a"]
                            && self.first.swap(false, Ordering::AcqRel);
                        let records = {
                            let values = self.values.lock().unwrap();
                            keys.into_iter()
                                .map(|key| {
                                    let value = values.get(&key).cloned().unwrap_or(Value::Null);
                                    (key, value)
                                })
                                .collect::<serde_json::Map<_, _>>()
                        };
                        if should_pause {
                            self.paused.notify_one();
                            self.resume.notified().await;
                        }
                        Ok(json!({"records":records}))
                    }
                    MetaRequest::Commit { changes, .. } => {
                        let unknown_after_commit =
                            changes.iter().any(|change| {
                                change["key"] == "indexes/resource-v1/schema"
                                    && change["value"]["after"] == "state/resources/db_001535"
                            }) && self.fail_backfill_once.swap(false, Ordering::AcqRel);
                        let file_unknown_after_commit =
                            changes.iter().any(|change| {
                                change["key"] == "indexes/file-v1/head"
                                    && change["value"]["after"] == "state/files/file_000511"
                            }) && self.fail_file_backfill_once.swap(false, Ordering::AcqRel);
                        let event_unknown_after_commit =
                            changes.iter().any(|change| {
                                change["key"] == "indexes/event-v1/head"
                                    && change["expectedVersion"].is_null()
                            }) && self.fail_event_backfill_once.swap(false, Ordering::AcqRel);
                        let mut values = self.values.lock().unwrap();
                        for change in &changes {
                            let key = change["key"].as_str().unwrap();
                            if version(values.get(key).unwrap_or(&Value::Null))
                                != change["expectedVersion"]
                            {
                                return Err(ServiceError::new(409, "META_CONFLICT"));
                            }
                        }
                        for change in changes {
                            let key = change["key"].as_str().unwrap();
                            if change["delete"] == true {
                                values.remove(key);
                            } else {
                                values.insert(key.into(), json!({"version":Uuid::new_v4().to_string(),"value":change["value"]}));
                            }
                        }
                        if unknown_after_commit
                            || file_unknown_after_commit
                            || event_unknown_after_commit
                        {
                            Err(error("META_COMMIT_UNKNOWN"))
                        } else {
                            Ok(json!({}))
                        }
                    }
                    MetaRequest::List {
                        prefix,
                        after,
                        limit,
                        ..
                    } => {
                        assert!(
                            !(prefix == "state/events/"
                                && self.forbid_event_scan.load(Ordering::Acquire)),
                            "steady event append must not enumerate the event collection"
                        );
                        assert!(
                            !(prefix == "state/files/"
                                && self.forbid_file_scan.load(Ordering::Acquire)),
                            "steady file access must not enumerate all Workspace files"
                        );
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
            fail_backfill_once: AtomicBool::new(false),
            fail_file_backfill_once: AtomicBool::new(false),
            fail_event_backfill_once: AtomicBool::new(false),
            forbid_event_scan: AtomicBool::new(false),
            forbid_file_scan: AtomicBool::new(false),
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
            resource_backfill_running: AtomicBool::new(false),
            resource_backfill_error: std::sync::Mutex::new(None),
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
        let setup = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            repository.begin_setup_attempt("b", "owner", "once", json!({"id":"attempt-a"})),
        )
        .await
        .expect("independent setup was serialized")
        .unwrap();
        assert!(setup.1);
        let replay = repository
            .begin_setup_attempt("b", "owner", "once", json!({"id":"attempt-b"}))
            .await
            .unwrap();
        assert!(!replay.1);
        assert_eq!(replay.0["id"], "attempt-a");
        metadata.resume.notify_one();
        stalled.await.unwrap().unwrap();
        let values = metadata.values.lock().unwrap();
        assert_eq!(values["state/resources/a"]["value"]["record"]["n"], 1);
        assert_eq!(values["state/resources/b"]["value"]["record"]["n"], 2);
    }

    #[tokio::test]
    async fn independent_resource_transactions_do_not_share_an_exclusive_gate() {
        let metadata = Arc::new(MetadataGate {
            values: std::sync::Mutex::new(
                [
                    (
                        "state/workspace".into(),
                        json!({"version":"v1","value":{"id":"test"}}),
                    ),
                    ("state/profile".into(), json!({"version":"v1","value":{}})),
                    (
                        "state/resources/a".into(),
                        json!({"version":"v1","value":{"position":1,"record":{"id":"a","n":0}}}),
                    ),
                    (
                        "state/resources/b".into(),
                        json!({"version":"v1","value":{"position":2,"record":{"id":"b","n":0}}}),
                    ),
                ]
                .into_iter()
                .collect(),
            ),
            paused: Notify::new(),
            resume: Notify::new(),
            first: AtomicBool::new(true),
            fail_backfill_once: AtomicBool::new(false),
            fail_file_backfill_once: AtomicBool::new(false),
            fail_event_backfill_once: AtomicBool::new(false),
            forbid_event_scan: AtomicBool::new(false),
            forbid_file_scan: AtomicBool::new(false),
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
            resource_backfill_running: AtomicBool::new(false),
            resource_backfill_error: std::sync::Mutex::new(None),
        });
        let stalled = tokio::spawn({
            let repository = repository.clone();
            async move {
                repository
                    .resource_transaction(
                        vec!["a".into()],
                        false,
                        false,
                        false,
                        &crate::Credential::LocalDemoOwner,
                        |state| {
                            state["resources"][0]["n"] = json!(1);
                            Ok(((), true))
                        },
                    )
                    .await
            }
        });
        metadata.paused.notified().await;
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            repository.resource_transaction(
                vec!["b".into()],
                false,
                false,
                false,
                &crate::Credential::LocalDemoOwner,
                |state| {
                    state["resources"][0]["n"] = json!(1);
                    Ok(((), true))
                },
            ),
        )
        .await
        .expect("unrelated resource transaction was blocked")
        .unwrap();
        metadata.resume.notify_one();
        stalled.await.unwrap().unwrap();
        let records = metadata.values.lock().unwrap();
        assert_eq!(records["state/resources/a"]["value"]["record"]["n"], 1);
        assert_eq!(records["state/resources/b"]["value"]["record"]["n"], 1);
    }

    #[tokio::test]
    async fn key_revocation_fences_a_concurrent_resource_commit() {
        let token = "concurrent-key";
        let digest = hex::encode(Sha256::digest(token.as_bytes()));
        let metadata = Arc::new(MetadataGate {
            values: std::sync::Mutex::new([
                ("state/workspace".into(), json!({"version":"v1","value":{"id":"test"}})),
                ("state/profile".into(), json!({"version":"v1","value":{}})),
                (format!("indexes/key-digest/{digest}"), json!({"version":"v1","value":"key-a"})),
                ("state/keys/key-a".into(), json!({"version":"v1","value":{"position":1,"record":{"id":"key-a","name":"key","digest":digest,"scopes":["files:write"],"resourceIds":["a"],"expiresAt":"2099-01-01T00:00:00Z","revokedAt":null}}})),
                ("state/resources/a".into(), json!({"version":"v1","value":{"position":1,"record":{"id":"a","kind":"filesystem","n":0}}})),
            ].into_iter().collect()),
            paused: Notify::new(), resume: Notify::new(), first: AtomicBool::new(true),
            fail_backfill_once: AtomicBool::new(false), fail_file_backfill_once: AtomicBool::new(false),
            fail_event_backfill_once: AtomicBool::new(false), forbid_event_scan: AtomicBool::new(false),
            forbid_file_scan: AtomicBool::new(false),
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
            resource_backfill_running: AtomicBool::new(false),
            resource_backfill_error: std::sync::Mutex::new(None),
        });
        let stalled = tokio::spawn({
            let repository = repository.clone();
            async move {
                let credential = crate::Credential::Bearer(token.into());
                repository
                    .resource_transaction(
                        vec!["a".into()],
                        false,
                        false,
                        false,
                        &credential,
                        |state| {
                            crate::principal(state, &credential)?.scope("files:write")?;
                            state["resources"][0]["n"] = json!(1);
                            Ok(((), true))
                        },
                    )
                    .await
            }
        });
        metadata.paused.notified().await;
        repository
            .key_transaction(Vec::new(), Some("key-a"), |state| {
                state["keys"][0]["revokedAt"] = json!("2026-01-01T00:00:00Z");
                Ok(((), true))
            })
            .await
            .unwrap();
        metadata.resume.notify_one();
        assert_eq!(stalled.await.unwrap().unwrap_err().code, "INVALID_KEY");
        assert_eq!(
            metadata.values.lock().unwrap()["state/resources/a"]["value"]["record"]["n"],
            0
        );
    }

    #[tokio::test]
    async fn conflicting_point_updates_retry_against_the_latest_value() {
        let metadata = Arc::new(MetadataGate {
            values: std::sync::Mutex::new(
                [(
                    "state/resources/a".into(),
                    json!({"version":"v1","value":{"position":0,"record":{"id":"a","n":0}}}),
                )]
                .into_iter()
                .collect(),
            ),
            paused: Notify::new(),
            resume: Notify::new(),
            first: AtomicBool::new(true),
            fail_backfill_once: AtomicBool::new(false),
            fail_file_backfill_once: AtomicBool::new(false),
            fail_event_backfill_once: AtomicBool::new(false),
            forbid_event_scan: AtomicBool::new(false),
            forbid_file_scan: AtomicBool::new(false),
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
            resource_backfill_running: AtomicBool::new(false),
            resource_backfill_error: std::sync::Mutex::new(None),
        });
        let stalled = tokio::spawn({
            let repository = repository.clone();
            async move {
                repository
                    .update_resource("a", |resource| {
                        resource["n"] = json!(resource["n"].as_u64().unwrap() + 1);
                        Ok(())
                    })
                    .await
            }
        });
        metadata.paused.notified().await;
        repository
            .update_resource("a", |resource| {
                resource["n"] = json!(resource["n"].as_u64().unwrap() + 1);
                Ok(())
            })
            .await
            .unwrap();
        metadata.resume.notify_one();
        stalled.await.unwrap().unwrap();
        let values = metadata.values.lock().unwrap();
        assert_eq!(values["state/resources/a"]["value"]["record"]["n"], 2);
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
            fail_backfill_once: AtomicBool::new(false),
            fail_file_backfill_once: AtomicBool::new(false),
            fail_event_backfill_once: AtomicBool::new(false),
            forbid_event_scan: AtomicBool::new(false),
            forbid_file_scan: AtomicBool::new(false),
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
            resource_backfill_running: AtomicBool::new(false),
            resource_backfill_error: std::sync::Mutex::new(None),
        };
        repository
            .append_event(json!({"id":"event-new"}))
            .await
            .unwrap();
        {
            let values = metadata.values.lock().unwrap();
            assert_eq!(
                values
                    .keys()
                    .filter(|key| key.starts_with("state/events/"))
                    .count(),
                200
            );
            assert!(!values.contains_key("state/events/event-000"));
            assert_eq!(values["state/events/event-new"]["value"]["position"], 200);
        }
        metadata.forbid_event_scan.store(true, Ordering::Release);
        repository
            .append_event(json!({"id":"event-next"}))
            .await
            .unwrap();
        let values = metadata.values.lock().unwrap();
        assert_eq!(
            values
                .keys()
                .filter(|key| key.starts_with("state/events/"))
                .count(),
            200
        );
        assert!(!values.contains_key("state/events/event-001"));
        assert_eq!(values["state/events/event-next"]["value"]["position"], 201);
    }

    #[tokio::test]
    async fn resource_index_backfill_resumes_without_double_counting() {
        let metadata = Arc::new(MetadataGate {
            values: std::sync::Mutex::new((0..1541).map(|n| {
                let id = format!("db_{n:06}");
                (format!("state/resources/{id}"), json!({"version":"v1","value":{"position":n,"record":{
                    "id":id,"name":format!("existing-{n}"),"kind":"mysql","status":"active","region":"automatic"
                }}}))
            }).collect()),
            paused: Notify::new(),
            resume: Notify::new(),
            first: AtomicBool::new(false),
            fail_backfill_once: AtomicBool::new(true),
            fail_file_backfill_once: AtomicBool::new(false),
            fail_event_backfill_once: AtomicBool::new(false),
            forbid_event_scan: AtomicBool::new(false),
            forbid_file_scan: AtomicBool::new(false),
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
            resource_backfill_running: AtomicBool::new(false),
            resource_backfill_error: std::sync::Mutex::new(None),
        };
        let repository = Arc::new(repository);
        let resource = json!({"id":"db_new","name":"new-duck","kind":"duckdb","status":"active","region":"automatic","provider":"local"});
        let event = json!({"id":"event-new","action":"resource.created"});
        let result = repository
            .create_indexed_resource(
                &crate::Credential::LocalDemoOwner,
                Some("owner:retry"),
                "fingerprint",
                resource.clone(),
                event.clone(),
            )
            .await;
        assert_eq!(result.unwrap_err().code, "META_COMMIT_UNKNOWN");
        assert_eq!(
            metadata.values.lock().unwrap()["indexes/resource-v1/schema"]["value"]["after"],
            "state/resources/db_001535"
        );
        let created = repository
            .create_indexed_resource(
                &crate::Credential::LocalDemoOwner,
                Some("owner:retry"),
                "fingerprint",
                resource.clone(),
                event.clone(),
            )
            .await;
        let created = match created {
            Ok(created) => created,
            Err(error) if error.code == "RESOURCE_INDEX_MIGRATING" => {
                tokio::time::timeout(std::time::Duration::from_secs(5), async {
                    while repository.resource_backfill_running.load(Ordering::Acquire) {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
                repository
                    .create_indexed_resource(
                        &crate::Credential::LocalDemoOwner,
                        Some("owner:retry"),
                        "fingerprint",
                        resource,
                        event,
                    )
                    .await
                    .unwrap()
            }
            Err(error) => panic!("unexpected error: {error}"),
        };
        assert_eq!(created["id"], "db_new");
        let values = metadata.values.lock().unwrap();
        let counts = values
            .iter()
            .filter(|(key, _)| key.starts_with("indexes/resource-v1/quotas/"))
            .map(|(_, value)| {
                (
                    value["value"]["group"].as_str().unwrap(),
                    value["value"]["count"].as_u64().unwrap(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(counts.get("[\"database\",\"mysql\"]"), Some(&1541));
        assert_eq!(counts.get("[\"database\",\"duckdb\"]"), Some(&1));
        assert_eq!(
            values["indexes/resource-v1/schema"]["value"]["phase"],
            "ready"
        );
    }

    #[tokio::test]
    async fn backfill_detects_names_duplicated_across_checkpoints() {
        let metadata = Arc::new(MetadataGate {
            values: std::sync::Mutex::new((0..1542).map(|n| {
                let id = format!("db_{n:06}");
                let name = if n == 1540 { "existing-0".to_owned() } else { format!("existing-{n}") };
                (format!("state/resources/{id}"), json!({"version":"v1","value":{"position":n,"record":{
                    "id":id,"name":name,"kind":"mysql","status":"active","region":"automatic"
                }}}))
            }).collect()),
            paused: Notify::new(), resume: Notify::new(), first: AtomicBool::new(false),
            fail_backfill_once: AtomicBool::new(false),
            fail_file_backfill_once: AtomicBool::new(false),
            fail_event_backfill_once: AtomicBool::new(false),
            forbid_event_scan: AtomicBool::new(false),
            forbid_file_scan: AtomicBool::new(false),
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
            resource_backfill_running: AtomicBool::new(false),
            resource_backfill_error: std::sync::Mutex::new(None),
        };
        let repository = Arc::new(repository);
        let resource = json!({"id":"db_new","name":"new-duck","kind":"duckdb","status":"active","region":"automatic","provider":"local"});
        let event = json!({"id":"event-new","action":"resource.created"});
        let create = || {
            repository.create_indexed_resource(
                &crate::Credential::LocalDemoOwner,
                Some("owner:retry"),
                "fingerprint",
                resource.clone(),
                event.clone(),
            )
        };
        let mut failure = create().await.unwrap_err();
        if failure.code == "RESOURCE_INDEX_MIGRATING" {
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while repository.resource_backfill_running.load(Ordering::Acquire) {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            failure = create().await.unwrap_err();
        }
        assert_eq!(failure.code, "RESOURCE_INDEX_DUPLICATE_NAME");
        {
            let mut records = metadata.values.lock().unwrap();
            assert_eq!(
                records["indexes/resource-v1/schema"]["value"]["after"],
                "state/resources/db_001535"
            );
            records.get_mut("state/resources/db_001540").unwrap()["value"]["record"]["name"] =
                json!("existing-1540");
        }
        let mut created = create().await;
        if created
            .as_ref()
            .is_err_and(|error| error.code == "RESOURCE_INDEX_MIGRATING")
        {
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while repository.resource_backfill_running.load(Ordering::Acquire) {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            created = create().await;
        }
        assert_eq!(created.unwrap()["id"], "db_new");
        let records = metadata.values.lock().unwrap();
        assert!(records.values().any(|entry| entry["value"]["group"]
            == "[\"database\",\"mysql\"]"
            && entry["value"]["count"] == 1542));
    }

    #[tokio::test]
    async fn file_index_resumes_unknown_commit_and_keeps_resource_boundaries() {
        let metadata = Arc::new(MetadataGate {
            values: std::sync::Mutex::new((0..600).map(|n| {
                let id = format!("file_{n:06}");
                let resource = if n % 2 == 0 { "fs_a" } else { "fs_b" };
                (format!("state/files/{id}"), json!({"version":"v1","value":{"position":n,"record":{"id":id,"resourceId":resource,"path":"/kept.txt","type":"file","content":"kept"}}}))
            }).collect()),
            paused: Notify::new(), resume: Notify::new(), first: AtomicBool::new(false),
            fail_backfill_once: AtomicBool::new(false), fail_file_backfill_once: AtomicBool::new(true),
            fail_event_backfill_once: AtomicBool::new(false),
            forbid_event_scan: AtomicBool::new(false),
            forbid_file_scan: AtomicBool::new(false),
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
            resource_backfill_running: AtomicBool::new(false),
            resource_backfill_error: std::sync::Mutex::new(None),
        };
        assert_eq!(
            repository.advance_file_index().await.unwrap_err().code,
            "META_COMMIT_UNKNOWN"
        );
        assert_eq!(
            metadata.values.lock().unwrap()["indexes/file-v1/head"]["value"]["after"],
            "state/files/file_000511"
        );
        assert!(repository.advance_file_index().await.unwrap());
        metadata.forbid_file_scan.store(true, Ordering::Release);
        let files = repository
            .files_for_resources(&["fs_a".into()])
            .await
            .unwrap();
        assert_eq!(files.len(), 300);
        assert!(
            files
                .values()
                .all(|record| record["value"]["record"]["resourceId"] == "fs_a"
                    && record["value"]["record"]["content"] == "kept")
        );
        assert_eq!(
            metadata
                .values
                .lock()
                .unwrap()
                .keys()
                .filter(|key| key.starts_with("state/files/"))
                .count(),
            600
        );
    }

    #[tokio::test]
    async fn event_index_recovers_after_unknown_initialization() {
        let metadata = Arc::new(MetadataGate {
            values: std::sync::Mutex::new(
                (0..3)
                    .map(|n| {
                        let id = format!("event-{n}");
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
            fail_backfill_once: AtomicBool::new(false),
            fail_file_backfill_once: AtomicBool::new(false),
            fail_event_backfill_once: AtomicBool::new(true),
            forbid_event_scan: AtomicBool::new(false),
            forbid_file_scan: AtomicBool::new(false),
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
            resource_backfill_running: AtomicBool::new(false),
            resource_backfill_error: std::sync::Mutex::new(None),
        };
        assert_eq!(
            repository
                .append_event(json!({"id":"event-new"}))
                .await
                .unwrap_err()
                .code,
            "META_COMMIT_UNKNOWN"
        );
        metadata.forbid_event_scan.store(true, Ordering::Release);
        repository
            .append_event(json!({"id":"event-new"}))
            .await
            .unwrap();
        let records = metadata.values.lock().unwrap();
        assert_eq!(
            records
                .keys()
                .filter(|key| key.starts_with("state/events/"))
                .count(),
            4
        );
        assert_eq!(records["state/events/event-new"]["value"]["position"], 3);
        assert!(records.contains_key("state/events/event-0"));
    }
}
