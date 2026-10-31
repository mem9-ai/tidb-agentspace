//! Resource-name, quota and idempotency records in the Workspace consistency group.
use super::*;
use crate::{Credential, principal};
use std::collections::{BTreeMap, BTreeSet};

const SCHEMA: &str = "indexes/resource-v1/schema";

fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn name_key(name: &str) -> String {
    format!("indexes/resource-v1/names/{}", digest(name))
}
fn quota_key(group: &str) -> String {
    format!("indexes/resource-v1/quotas/{}", digest(group))
}
fn idempotency_key(slot: &str) -> String {
    format!("state/idempotency/{}", digest(slot))
}
fn name(resource: &Value) -> Option<&str> {
    if resource["status"] == "deleted" {
        None
    } else {
        resource["name"].as_str()
    }
}
fn quota(resource: &Value) -> Option<String> {
    if resource["status"] == "deleted" {
        return None;
    }
    let kind = resource["kind"].as_str()?;
    if kind == "filesystem" {
        Some(
            json!([
                "filesystem",
                resource["region"].as_str()?,
                resource["provider"].as_str().unwrap_or("local")
            ])
            .to_string(),
        )
    } else if ["mysql", "duckdb", "postgresql"].contains(&kind)
        && (kind != "postgresql" || resource["provider"] == "db9-anonymous")
    {
        Some(json!(["database", kind]).to_string())
    } else {
        None
    }
}
fn counter(record: &Value, group: &str) -> Result<u64> {
    if record.is_null() {
        return Ok(0);
    }
    if record["value"]["group"] != group {
        return Err(error("RESOURCE_INDEX_CORRUPT"));
    }
    record["value"]["count"]
        .as_u64()
        .ok_or_else(|| error("RESOURCE_INDEX_CORRUPT"))
}

impl Repository {
    fn start_resource_backfill(self: &Arc<Self>) {
        if self.resource_backfill_running.swap(true, Ordering::AcqRel) {
            return;
        }
        let repository = self.clone();
        tokio::spawn(async move {
            struct Reset(Arc<Repository>);
            impl Drop for Reset {
                fn drop(&mut self) {
                    self.0
                        .resource_backfill_running
                        .store(false, Ordering::Release);
                }
            }
            let _reset = Reset(repository.clone());
            loop {
                let lock = repository.queue.write().await;
                let result = repository.advance_resource_indexes().await;
                drop(lock);
                match result {
                    Ok(marker) if marker["value"]["phase"] == "ready" => return,
                    Ok(_) => tokio::task::yield_now().await,
                    Err(error) => {
                        if let Ok(mut failure) = repository.resource_backfill_error.lock() {
                            *failure = Some(error);
                        }
                        return;
                    }
                }
            }
        });
    }
    pub(super) async fn get_many(&self, keys: Vec<String>) -> Result<Records> {
        let mut output = Records::new();
        for batch in keys.chunks(512) {
            let result = self
                .call(MetaRequest::Get {
                    scope: self.scope.clone(),
                    guard: Some(self.guard.clone()),
                    keys: batch.to_vec(),
                })
                .await?;
            let records = result["records"]
                .as_object()
                .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
            for key in batch {
                output.insert(
                    key.clone(),
                    records
                        .get(key)
                        .cloned()
                        .ok_or_else(|| error("META_RECORD_CORRUPT"))?,
                );
            }
        }
        Ok(output)
    }

    /// Advance at most one batch while the writer gate is held. Each checkpoint is atomic.
    async fn advance_resource_indexes(&self) -> Result<Value> {
        let mut marker = self.get(SCHEMA).await?;
        if marker.is_null() {
            self.commit(vec![json!({"key":SCHEMA,"expectedVersion":null,"value":{"format":1,"phase":"building","after":null,"position":0}})]).await?;
            marker = self.get(SCHEMA).await?;
        }
        {
            let state = &marker["value"];
            if state["format"] != 1 {
                return Err(error("RESOURCE_INDEX_CORRUPT"));
            }
            if state["phase"] == "ready" {
                return Ok(marker);
            }
            if state["phase"] != "building" {
                return Err(error("RESOURCE_INDEX_CORRUPT"));
            }
            let mut next = match &state["after"] {
                Value::Null => None,
                Value::String(s) => Some(s.clone()),
                _ => return Err(error("RESOURCE_INDEX_CORRUPT")),
            };
            let mut names = BTreeMap::<String, (String, String)>::new();
            let mut counts = BTreeMap::<String, u64>::new();
            let mut position = state["position"]
                .as_u64()
                .ok_or_else(|| error("RESOURCE_INDEX_CORRUPT"))?;
            // Aggregate three bounded list pages into one atomic checkpoint. Index records
            // are small even when the source resource descriptors are large.
            for _ in 0..3 {
                let page = self
                    .call(MetaRequest::List {
                        scope: self.scope.clone(),
                        guard: Some(self.guard.clone()),
                        prefix: "state/resources/".into(),
                        after: next,
                        limit: 512,
                    })
                    .await?;
                let entries = page["records"]
                    .as_array()
                    .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
                for entry in entries {
                    let resource = &entry["value"]["record"];
                    let id = resource["id"]
                        .as_str()
                        .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
                    if entry["key"] != format!("state/resources/{id}") {
                        return Err(error("META_RECORD_CORRUPT"));
                    }
                    position = position.max(entry["value"]["position"].as_u64().unwrap_or(0));
                    if let Some(value) = name(resource) {
                        let key = name_key(value);
                        if let Some((other, _)) = names.insert(key, (id.into(), value.into()))
                            && other != id
                        {
                            return Err(error("RESOURCE_INDEX_DUPLICATE_NAME"));
                        }
                    }
                    if let Some(group) = quota(resource) {
                        *counts.entry(group).or_default() += 1;
                    }
                }
                next = page["nextCursor"].as_str().map(str::to_owned);
                if next.is_none() {
                    break;
                }
            }
            let keys = counts.keys().map(|group| quota_key(group)).collect();
            let previous = self.get_many(keys).await?;
            let mut changes = Vec::new();
            for (key, (id, value)) in &names {
                changes
                    .push(json!({"key":key,"expectedVersion":null,"value":{"id":id,"name":value}}));
            }
            for (group, increment) in counts {
                let key = quota_key(&group);
                let prior = &previous[&key];
                let count = counter(prior, &group)?
                    .checked_add(increment)
                    .ok_or_else(|| error("RESOURCE_INDEX_CORRUPT"))?;
                changes.push(json!({"key":key,"expectedVersion":version(prior),"value":{"group":group,"count":count}}));
            }
            changes.push(json!({"key":SCHEMA,"expectedVersion":version(&marker),"value":{"format":1,"phase":if next.is_some(){"building"}else{"ready"},"after":next,"position":position}}));
            if let Err(failure) = self.commit(changes).await {
                if failure.code == "META_CONFLICT" {
                    let existing = self.get_many(names.keys().cloned().collect()).await?;
                    if names.iter().any(|(key, (id, value))| {
                        !existing[key].is_null()
                            && (existing[key]["value"]["id"] != *id
                                || existing[key]["value"]["name"] != *value)
                    }) {
                        return Err(error("RESOURCE_INDEX_DUPLICATE_NAME"));
                    }
                }
                return Err(failure);
            }
            if next.is_some() {
                Ok(Value::Null)
            } else {
                self.get(SCHEMA).await
            }
        }
    }

    /// Index maintenance for a single changed resource. Call while the caller's legacy
    /// gate is held and commit the returned changes atomically with the resource record.
    pub(super) async fn resource_index_changes(
        &self,
        before: &Value,
        after: &Value,
    ) -> Result<Vec<Value>> {
        let old_name = name(before);
        let new_name = name(after);
        let old_group = quota(before);
        let new_group = quota(after);
        if old_name == new_name && old_group == new_group {
            return Ok(Vec::new());
        }
        let marker = self.get(SCHEMA).await?;
        if marker.is_null() {
            return Ok(Vec::new());
        }
        if marker["value"]["format"] != 1 {
            return Err(error("RESOURCE_INDEX_CORRUPT"));
        }
        if marker["value"]["phase"] != "ready" {
            return Err(error("RESOURCE_INDEX_MIGRATING"));
        }
        let id = after["id"]
            .as_str()
            .or_else(|| before["id"].as_str())
            .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
        let mut paths = BTreeSet::new();
        if old_name != new_name {
            for value in [old_name, new_name].into_iter().flatten() {
                paths.insert(name_key(value));
            }
        }
        if old_group != new_group {
            for group in [old_group.as_ref(), new_group.as_ref()]
                .into_iter()
                .flatten()
            {
                paths.insert(quota_key(group));
            }
        }
        let previous = self.get_many(paths.into_iter().collect()).await?;
        let mut changes = Vec::new();
        if old_name != new_name {
            if let Some(value) = old_name {
                let key = name_key(value);
                let prior = &previous[&key];
                if prior["value"]["id"] != id || prior["value"]["name"] != value {
                    return Err(error("RESOURCE_INDEX_CORRUPT"));
                }
                changes.push(json!({"key":key,"expectedVersion":version(prior),"delete":true}));
            }
            if let Some(value) = new_name {
                let key = name_key(value);
                let prior = &previous[&key];
                if !prior.is_null() {
                    return Err(ServiceError::new(409, "NAME_EXISTS"));
                }
                changes
                    .push(json!({"key":key,"expectedVersion":null,"value":{"id":id,"name":value}}));
            }
        }
        if old_group != new_group {
            if let Some(group) = old_group {
                let key = quota_key(&group);
                let prior = &previous[&key];
                let count = counter(prior, &group)?
                    .checked_sub(1)
                    .ok_or_else(|| error("RESOURCE_INDEX_CORRUPT"))?;
                changes.push(json!({"key":key,"expectedVersion":version(prior),"value":{"group":group,"count":count}}));
            }
            if let Some(group) = new_group {
                let key = quota_key(&group);
                let prior = &previous[&key];
                let count = counter(prior, &group)?
                    .checked_add(1)
                    .ok_or_else(|| error("RESOURCE_INDEX_CORRUPT"))?;
                changes.push(json!({"key":key,"expectedVersion":version(prior),"value":{"group":group,"count":count}}));
            }
        }
        Ok(changes)
    }

    pub async fn create_indexed_resource(
        self: &Arc<Self>,
        credential: &Credential,
        slot: Option<&str>,
        fingerprint: &str,
        resource: Value,
        event: Value,
    ) -> Result<Value> {
        let slot_key = slot.map(idempotency_key);
        let (marker, _lock, state) = loop {
            let lock = self.queue.write().await;
            let state = match credential {
                Credential::Bearer(token) => {
                    self.key_state(&hex::encode(Sha256::digest(token.as_bytes())))
                        .await?
                }
                _ => json!({"workspace":{"id":self.workspace_id()}}),
            };
            let actor = principal(&state, credential)?;
            actor.scope("resources:write")?;
            if !actor.has("*") {
                return Err(ServiceError::new(403, "WORKSPACE_GRANT_REQUIRED"));
            }
            if let (Some(slot), Some(key)) = (slot, slot_key.as_ref()) {
                let prior = self.get(key).await?;
                if !prior.is_null() {
                    if prior["value"]["mapKey"] != slot {
                        return Err(error("RESOURCE_INDEX_CORRUPT"));
                    }
                    let record = &prior["value"]["record"];
                    if record["fingerprint"] != fingerprint {
                        return Err(ServiceError::new(409, "IDEMPOTENCY_CONFLICT"));
                    }
                    let id = record["resource"]["id"]
                        .as_str()
                        .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
                    let current = self.resource(id).await?;
                    return Ok(if current.is_null() {
                        record["resource"].clone()
                    } else {
                        current
                    });
                }
            }
            let marker = self.get(SCHEMA).await?;
            if let Some(failure) = self
                .resource_backfill_error
                .lock()
                .map_err(|_| error("RESOURCE_INDEX_RECOVERY_FAILED"))?
                .take()
            {
                return Err(failure);
            }
            if marker["value"]["phase"] != "ready" {
                drop(lock);
                self.start_resource_backfill();
                if tokio::time::timeout(std::time::Duration::from_millis(250), async {
                    while self.resource_backfill_running.load(Ordering::Acquire) {
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                })
                .await
                .is_err()
                {
                    return Err(ServiceError::new(503, "RESOURCE_INDEX_MIGRATING"));
                }
                continue;
            }
            break (marker, lock, state);
        };
        let id = resource["id"]
            .as_str()
            .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
        let value = name(&resource).ok_or_else(|| error("META_RECORD_CORRUPT"))?;
        let group = quota(&resource).ok_or_else(|| error("META_RECORD_CORRUPT"))?;
        let name_path = name_key(value);
        let quota_path = quota_key(&group);
        let mut paths = vec![
            name_path.clone(),
            quota_path.clone(),
            format!("state/resources/{id}"),
        ];
        if let Some(key) = &slot_key {
            paths.push(key.clone());
        }
        let prior = self.get_many(paths).await?;
        if !prior[&name_path].is_null() {
            return Err(ServiceError::new(409, "NAME_EXISTS"));
        }
        let count = counter(&prior[&quota_path], &group)?;
        let limit = if resource["kind"] == "filesystem" {
            1
        } else {
            5
        };
        if count >= limit {
            return Err(ServiceError::new(409, "FREE_TIER_LIMIT"));
        }
        let position = marker["value"]["position"]
            .as_u64()
            .and_then(|n| n.checked_add(1))
            .ok_or_else(|| error("RESOURCE_INDEX_CORRUPT"))?;
        let resource_path = format!("state/resources/{id}");
        if !prior[&resource_path].is_null() {
            return Err(error("RESOURCE_ID_CONFLICT"));
        }
        let mut changes = vec![
            json!({"key":resource_path,"expectedVersion":null,"value":{"position":position,"record":resource}}),
            json!({"key":name_path,"expectedVersion":null,"value":{"name":value,"id":id}}),
            json!({"key":quota_path,"expectedVersion":version(&prior[&quota_path]),"value":{"group":group,"count":count+1}}),
            json!({"key":SCHEMA,"expectedVersion":version(&marker),"value":{"format":1,"phase":"ready","after":null,"position":position}}),
        ];
        if let (Some(slot), Some(key)) = (slot, slot_key) {
            changes.push(json!({"key":key,"expectedVersion":version(&prior[&key]),"value":{"mapKey":slot,"record":{"fingerprint":fingerprint,"resource":resource}}}));
        }
        changes.extend(self.event_changes(&event).await?);
        // Backfill can take a long time. Recheck expiry and the Region-owned policy before
        // publishing the intent; this never calls Global.
        let caller = principal(&state, credential)?;
        caller.scope("resources:write")?;
        if !caller.has("*") {
            return Err(ServiceError::new(403, "WORKSPACE_GRANT_REQUIRED"));
        }
        if !self.get("ownership/onboarding").await?.is_null() {
            let (owner, generation) = self.managed_owner().await?;
            match credential {
                Credential::SessionOwner {
                    id,
                    policy_generation: Some(value),
                    ..
                } if id == &owner && *value == generation => {}
                Credential::Bearer(_) => {}
                _ => return Err(ServiceError::new(401, "UNAUTHENTICATED")),
            }
        }
        self.commit(changes).await?;
        Ok(resource)
    }
}
