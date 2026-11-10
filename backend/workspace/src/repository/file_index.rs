//! Resumable index from a public File System to its existing local file records.
use super::*;

const HEAD: &str = "indexes/file-v1/head";
const PREFIX: &str = "indexes/file-v1/by-resource/";

fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn file_prefix(resource: &str) -> String {
    format!("{PREFIX}{}/", digest(resource))
}
fn index_key(resource: &str, id: &str) -> String {
    format!("{}{}", file_prefix(resource), digest(id))
}
fn identity(file: &Value) -> Result<(&str, &str)> {
    let id = file["id"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
    let resource = file["resourceId"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
    Ok((resource, id))
}

impl Repository {
    pub(super) async fn file_index_ready(&self) -> Result<bool> {
        let head = self.get(HEAD).await?;
        if head.is_null() {
            return Ok(false);
        }
        if head["value"]["format"] != 1 {
            return Err(error("FILE_INDEX_CORRUPT"));
        }
        match head["value"]["phase"].as_str() {
            Some("ready") => Ok(true),
            Some("building") => Ok(false),
            _ => Err(error("FILE_INDEX_CORRUPT")),
        }
    }
    /// One atomic checkpoint; conditional versions fence concurrent mutations.
    pub(super) async fn advance_file_index(&self) -> Result<bool> {
        let mut head = self.get(HEAD).await?;
        if head.is_null() {
            self.commit(vec![json!({"key":HEAD,"expectedVersion":null,"value":{"format":1,"phase":"building","after":null}})]).await?;
            head = self.get(HEAD).await?;
        }
        let state = &head["value"];
        if state["format"] != 1 {
            return Err(error("FILE_INDEX_CORRUPT"));
        }
        if state["phase"] == "ready" {
            return Ok(true);
        }
        if state["phase"] != "building" {
            return Err(error("FILE_INDEX_CORRUPT"));
        }
        let after = match &state["after"] {
            Value::Null => None,
            Value::String(value) => Some(value.clone()),
            _ => return Err(error("FILE_INDEX_CORRUPT")),
        };
        let page = self
            .call(MetaRequest::List {
                scope: self.scope.clone(),
                guard: Some(self.guard.clone()),
                prefix: "state/files/".into(),
                after,
                limit: 512,
            })
            .await?;
        let records = page["records"]
            .as_array()
            .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
        let mut changes = Vec::new();
        for entry in records {
            let file = &entry["value"]["record"];
            let (resource, id) = identity(file)?;
            if entry["key"] != format!("state/files/{id}") {
                return Err(error("META_RECORD_CORRUPT"));
            }
            changes.push(json!({"key":index_key(resource,id),"expectedVersion":null,"value":{"resourceId":resource,"id":id}}));
        }
        let next = page["nextCursor"].as_str().map(str::to_owned);
        changes.push(json!({"key":HEAD,"expectedVersion":version(&head),"value":{"format":1,"phase":if next.is_some(){"building"}else{"ready"},"after":next}}));
        self.commit(changes).await?;
        Ok(next.is_none())
    }

    pub(super) async fn files_for_resources(&self, ids: &[String]) -> Result<Records> {
        let mut result = Records::new();
        let mut bytes = 0usize;
        for resource in ids {
            let prefix = file_prefix(resource);
            let mut after = None;
            loop {
                let page = self
                    .call(MetaRequest::List {
                        scope: self.scope.clone(),
                        guard: Some(self.guard.clone()),
                        prefix: prefix.clone(),
                        after,
                        limit: 512,
                    })
                    .await?;
                let entries = page["records"]
                    .as_array()
                    .ok_or_else(|| error("FILE_INDEX_CORRUPT"))?;
                let mut paths = Vec::with_capacity(entries.len());
                let mut indexes = BTreeMap::new();
                for entry in entries {
                    let index = &entry["value"];
                    let id = index["id"]
                        .as_str()
                        .ok_or_else(|| error("FILE_INDEX_CORRUPT"))?;
                    if index["resourceId"] != *resource || entry["key"] != index_key(resource, id) {
                        return Err(error("FILE_INDEX_CORRUPT"));
                    }
                    let path = format!("state/files/{id}");
                    indexes.insert(
                        path.clone(),
                        (index_key(resource, id), entry["version"].clone()),
                    );
                    paths.push(path);
                }
                for batch in paths.chunks(32) {
                    let records = self.get_many(batch.to_vec()).await?;
                    for (key, record) in records {
                        if record.is_null()
                            || record["value"]["record"]["resourceId"] != *resource
                            || key
                                != format!(
                                    "state/files/{}",
                                    record["value"]["record"]["id"]
                                        .as_str()
                                        .ok_or_else(|| error("FILE_INDEX_CORRUPT"))?
                                )
                        {
                            let (index_key, expected) = &indexes[&key];
                            if version(&self.get(index_key).await?) != *expected {
                                return Err(ServiceError::new(409, "META_CONFLICT"));
                            }
                            return Err(error("FILE_INDEX_CORRUPT"));
                        }
                        bytes += serde_json::to_vec(&record)
                            .map_err(|_| error("META_RECORD_CORRUPT"))?
                            .len();
                        if result.insert(key, record).is_some() {
                            return Err(error("FILE_INDEX_CORRUPT"));
                        }
                        if result.len() > 4096 || bytes > 24 * 1024 * 1024 {
                            return Err(ServiceError::new(413, "WORKSPACE_VIEW_LIMIT"));
                        }
                    }
                }
                after = page["nextCursor"].as_str().map(str::to_owned);
                if after.is_none() {
                    break;
                }
            }
        }
        Ok(result)
    }

    pub(super) async fn file_index_changes(
        &self,
        updates: &[(Value, Value)],
    ) -> Result<Vec<Value>> {
        let mut actions = BTreeMap::<String, (String, String, bool)>::new();
        for (before, after) in updates {
            let old = if before.is_null() {
                None
            } else {
                Some(identity(before)?)
            };
            let new = if after.is_null() {
                None
            } else {
                Some(identity(after)?)
            };
            if old == new {
                continue;
            }
            for (entry, deleting) in [(old, true), (new, false)] {
                if let Some((resource, id)) = entry
                    && actions
                        .insert(
                            index_key(resource, id),
                            (resource.into(), id.into(), deleting),
                        )
                        .is_some()
                {
                    return Err(error("FILE_INDEX_CORRUPT"));
                }
            }
        }
        if actions.is_empty() {
            return Ok(Vec::new());
        }
        let head = self.get(HEAD).await?;
        if head.is_null() {
            return Ok(vec![
                json!({"key":HEAD,"expectedVersion":null,"delete":true}),
            ]);
        }
        if head["value"]["format"] != 1 {
            return Err(error("FILE_INDEX_CORRUPT"));
        }
        if head["value"]["phase"] != "ready" {
            return Err(error("FILE_INDEX_MIGRATING"));
        }
        let previous = self.get_many(actions.keys().cloned().collect()).await?;
        let mut changes = Vec::new();
        for (path, (resource, id, deleting)) in actions {
            let prior = &previous[&path];
            if deleting {
                if prior["value"]["resourceId"] != resource || prior["value"]["id"] != id {
                    return Err(error("FILE_INDEX_CORRUPT"));
                }
                changes.push(json!({"key":path,"expectedVersion":version(prior),"delete":true}));
            } else {
                if !prior.is_null() {
                    return Err(error("FILE_INDEX_CORRUPT"));
                }
                changes.push(json!({"key":path,"expectedVersion":null,"value":{"resourceId":resource,"id":id}}));
            }
        }
        Ok(changes)
    }
}

impl Repository {
    /// Remove a deleted File System's local metadata in bounded, restartable batches.
    pub async fn purge_local_files(
        &self,
        resource: &str,
        credential: &crate::Credential,
    ) -> Result<()> {
        self.ensure_file_indexes().await?;
        loop {
            let mut finished = false;
            for attempt in 0..8 {
                let _lock = self.queue.read().await;
                let state = match credential {
                    crate::Credential::Bearer(token) => {
                        self.key_state(&hex::encode(Sha256::digest(token.as_bytes())))
                            .await?
                    }
                    _ => json!({"workspace":{"id":self.workspace_id()}}),
                };
                let actor = crate::principal(&state, credential)?;
                actor.scope("resources:write")?;
                let resource_key = format!("state/resources/{resource}");
                let owner = self.get(&resource_key).await?;
                if !actor.permits_record(&owner["value"]["record"]) {
                    return Err(ServiceError::new(403, "RESOURCE_ACCESS_DENIED"));
                }
                if owner["value"]["record"]["kind"] != "filesystem"
                    || !["deleting", "deleted"]
                        .contains(&owner["value"]["record"]["status"].as_str().unwrap_or(""))
                {
                    return Err(error("FILE_CLEANUP_STATE_INVALID"));
                }
                let page = self
                    .call(MetaRequest::List {
                        scope: self.scope.clone(),
                        guard: Some(self.guard.clone()),
                        prefix: file_prefix(resource),
                        after: None,
                        limit: 8,
                    })
                    .await?;
                let indexes = page["records"]
                    .as_array()
                    .ok_or_else(|| error("FILE_INDEX_CORRUPT"))?;
                if indexes.is_empty() {
                    finished = true;
                    break;
                }
                let mut paths = Vec::new();
                for entry in indexes {
                    let id = entry["value"]["id"]
                        .as_str()
                        .ok_or_else(|| error("FILE_INDEX_CORRUPT"))?;
                    if entry["value"]["resourceId"] != resource
                        || entry["key"] != index_key(resource, id)
                    {
                        return Err(error("FILE_INDEX_CORRUPT"));
                    }
                    paths.push(format!("state/files/{id}"));
                }
                let records = self.get_many(paths.clone()).await?;
                let mut updates = Vec::new();
                let mut changes = Vec::new();
                for path in paths {
                    let prior = &records[&path];
                    if prior.is_null() || prior["value"]["record"]["resourceId"] != resource {
                        return Err(error("FILE_INDEX_CORRUPT"));
                    }
                    updates.push((prior["value"]["record"].clone(), Value::Null));
                    changes
                        .push(json!({"key":path,"expectedVersion":version(prior),"delete":true}));
                }
                changes.extend(self.file_index_changes(&updates).await?);
                changes.extend(self.file_path_changes(&updates, true).await?);
                changes.push(json!({"key":resource_key,"expectedVersion":version(&owner),"value":owner["value"]}));
                crate::principal(&state, credential)?.scope("resources:write")?;
                if !self.get("ownership/onboarding").await?.is_null() {
                    let (owner_id, generation) = self.managed_owner().await?;
                    match credential {
                        crate::Credential::SessionOwner {
                            id,
                            policy_generation: Some(current),
                            ..
                        } if *id == owner_id && *current == generation => {}
                        crate::Credential::Bearer(_) => {}
                        _ => return Err(ServiceError::new(401, "UNAUTHENTICATED")),
                    }
                }
                if matches!(credential, crate::Credential::Bearer(_)) {
                    let key = state["keys"]
                        .as_array()
                        .and_then(|keys| keys.first())
                        .ok_or_else(|| ServiceError::new(401, "INVALID_KEY"))?;
                    let id = key["id"]
                        .as_str()
                        .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
                    let path = format!("state/keys/{id}");
                    let prior_key = self.get(&path).await?;
                    if prior_key["value"]["record"] != *key {
                        if attempt < 7 {
                            continue;
                        }
                        return Err(ServiceError::new(409, "META_CONFLICT"));
                    }
                    changes.push(json!({"key":path,"expectedVersion":version(&prior_key),"value":prior_key["value"]}));
                }
                match self.commit(changes).await {
                    Ok(()) => break,
                    Err(error) if error.code == "META_CONFLICT" && attempt < 7 => continue,
                    Err(error) => return Err(error),
                }
            }
            if finished {
                return Ok(());
            }
            tokio::task::yield_now().await;
        }
    }
}
