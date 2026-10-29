use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Mutex;
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
    queue: Mutex<()>,
    closed: AtomicBool,
}
impl Repository {
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
            queue: Mutex::new(()),
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
        let _lock = self.queue.lock().await;
        inflate(&self.records("state/").await?)
    }
    pub async fn transaction<T>(
        &self,
        apply: impl FnOnce(&mut Value) -> Result<(T, bool)> + Send,
    ) -> Result<T> {
        let _lock = self.queue.lock().await;
        let previous = self.records("state/").await?;
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
    pub async fn authenticate_key(&self, token: &str) -> Result<crate::Principal> {
        let _lock = self.queue.lock().await;
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
        let _lock = self.queue.lock().await;
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
        let _lock = self.queue.lock().await;
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
    pub async fn close(&self) -> Result<()> {
        let _lock = self.queue.lock().await;
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
