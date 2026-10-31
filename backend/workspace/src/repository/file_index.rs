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
    /// One atomic checkpoint; callers release the Workspace gate between batches.
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
            return Ok(Vec::new());
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
