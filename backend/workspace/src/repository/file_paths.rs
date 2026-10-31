//! Path and directory indexes for bounded local file access.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

const HEAD: &str = "indexes/file-v2/head";
fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn path_key(resource: &str, path: &str) -> String {
    format!("indexes/file-v2/path/{}/{}", hash(resource), hash(path))
}
fn directory_prefix(resource: &str, directory: &str) -> String {
    format!(
        "indexes/file-v2/directory/{}/{}/",
        hash(resource),
        hash(directory)
    )
}
fn directory_key(resource: &str, path: &str) -> String {
    format!(
        "{}{}",
        directory_prefix(resource, &parent(path)),
        hash(path)
    )
}
fn summary_key(resource: &str) -> String {
    format!("indexes/file-v2/summary/{}", hash(resource))
}
fn children_key(resource: &str, directory: &str) -> String {
    format!(
        "indexes/file-v2/children/{}/{}",
        hash(resource),
        hash(directory)
    )
}
fn parent(path: &str) -> String {
    let p = path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    if p.is_empty() { "/".into() } else { p.into() }
}
fn fields(file: &Value) -> Result<(&str, &str, &str)> {
    let id = file["id"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| error("FILE_INDEX_CORRUPT"))?;
    let resource = file["resourceId"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| error("FILE_INDEX_CORRUPT"))?;
    let path = file["path"]
        .as_str()
        .filter(|v| v.starts_with('/') && v.len() > 1)
        .ok_or_else(|| error("FILE_INDEX_CORRUPT"))?;
    Ok((resource, path, id))
}
fn size(file: &Value) -> i64 {
    file["content"].as_str().unwrap_or("").len() as i64
}
fn adjust(prior: &Value, field: &str, delta: i64) -> Result<u64> {
    let current = if prior.is_null() {
        0
    } else {
        prior["value"][field]
            .as_u64()
            .ok_or_else(|| error("FILE_INDEX_CORRUPT"))?
    };
    current
        .checked_add_signed(delta)
        .ok_or_else(|| error("FILE_INDEX_CORRUPT"))
}

impl Repository {
    pub(super) async fn file_paths_ready(&self) -> Result<bool> {
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
    pub(super) async fn advance_file_paths(&self) -> Result<bool> {
        let mut head = self.get(HEAD).await?;
        if head.is_null() {
            self.commit(vec![json!({"key":HEAD,"expectedVersion":null,"value":{"format":1,"phase":"building","after":null}})]).await?;
            head = self.get(HEAD).await?;
        }
        if head["value"]["format"] != 1 {
            return Err(error("FILE_INDEX_CORRUPT"));
        }
        if head["value"]["phase"] == "ready" {
            return Ok(true);
        }
        if head["value"]["phase"] != "building" {
            return Err(error("FILE_INDEX_CORRUPT"));
        }
        let after = match &head["value"]["after"] {
            Value::Null => None,
            Value::String(v) => Some(v.clone()),
            _ => return Err(error("FILE_INDEX_CORRUPT")),
        };
        let page = self
            .call(MetaRequest::List {
                scope: self.scope.clone(),
                guard: Some(self.guard.clone()),
                prefix: "state/files/".into(),
                after,
                limit: 128,
            })
            .await?;
        let records = page["records"]
            .as_array()
            .ok_or_else(|| error("FILE_INDEX_CORRUPT"))?;
        let mut entries = Vec::new();
        let mut summaries = BTreeMap::<String, (String, i64, i64, i64)>::new();
        let mut directories = BTreeMap::<String, (String, String, i64)>::new();
        let mut seen = BTreeSet::new();
        for entry in records {
            let file = &entry["value"]["record"];
            let (resource, path, id) = fields(file)?;
            if entry["key"] != format!("state/files/{id}")
                || !seen.insert((resource.to_owned(), path.to_owned()))
            {
                return Err(error("FILE_INDEX_CORRUPT"));
            }
            let index = json!({"resourceId":resource,"path":path,"id":id});
            entries
                .push(json!({"key":path_key(resource,path),"expectedVersion":null,"value":index}));
            entries.push(
                json!({"key":directory_key(resource,path),"expectedVersion":null,"value":index}),
            );
            let summary =
                summaries
                    .entry(summary_key(resource))
                    .or_insert((resource.into(), 0, 0, 0));
            summary.1 += 1;
            summary.2 += i64::from(file["type"] == "file");
            summary.3 += size(file);
            let dir = parent(path);
            directories
                .entry(children_key(resource, &dir))
                .or_insert((resource.into(), dir, 0))
                .2 += 1;
        }
        let keys = summaries
            .keys()
            .chain(directories.keys())
            .cloned()
            .collect();
        let previous = self.get_many(keys).await?;
        for (key, (resource, count, files, bytes)) in summaries {
            let prior = &previous[&key];
            if !prior.is_null() && prior["value"]["resourceId"] != resource {
                return Err(error("FILE_INDEX_CORRUPT"));
            }
            entries.push(json!({"key":key,"expectedVersion":version(prior),"value":{"resourceId":resource,"count":adjust(prior,"count",count)?,"files":adjust(prior,"files",files)?,"bytes":adjust(prior,"bytes",bytes)?}}));
        }
        for (key, (resource, directory, count)) in directories {
            let prior = &previous[&key];
            if !prior.is_null()
                && (prior["value"]["resourceId"] != resource
                    || prior["value"]["directory"] != directory)
            {
                return Err(error("FILE_INDEX_CORRUPT"));
            }
            entries.push(json!({"key":key,"expectedVersion":version(prior),"value":{"resourceId":resource,"directory":directory,"count":adjust(prior,"count",count)?}}));
        }
        let next = page["nextCursor"].as_str().map(str::to_owned);
        entries.push(json!({"key":HEAD,"expectedVersion":version(&head),"value":{"format":1,"phase":if next.is_some(){"building"}else{"ready"},"after":next}}));
        self.commit(entries).await?;
        Ok(next.is_none())
    }

    pub(super) async fn files_for_paths(
        &self,
        resource: &str,
        paths: &[String],
    ) -> Result<Records> {
        let indexes = paths
            .iter()
            .map(|p| path_key(resource, p))
            .collect::<Vec<_>>();
        let index_records = self.get_many(indexes.clone()).await?;
        let mut wanted = BTreeMap::new();
        for (path, key) in paths.iter().zip(indexes) {
            let record = &index_records[&key];
            if record.is_null() {
                continue;
            }
            if record["value"]["resourceId"] != resource || record["value"]["path"] != *path {
                return Err(error("FILE_INDEX_CORRUPT"));
            }
            let id = record["value"]["id"]
                .as_str()
                .ok_or_else(|| error("FILE_INDEX_CORRUPT"))?;
            wanted.insert(
                format!("state/files/{id}"),
                (path.clone(), key, version(record)),
            );
        }
        let mut result = Records::new();
        for chunk in wanted.keys().cloned().collect::<Vec<_>>().chunks(8) {
            for (key, record) in self.get_many(chunk.to_vec()).await? {
                let (path, index, prior_version) = &wanted[&key];
                if record.is_null()
                    || record["value"]["record"]["resourceId"] != resource
                    || record["value"]["record"]["path"] != *path
                {
                    if version(&self.get(index).await?) != *prior_version {
                        return Err(ServiceError::new(409, "META_CONFLICT"));
                    }
                    return Err(error("FILE_INDEX_CORRUPT"));
                }
                result.insert(key, record);
            }
        }
        Ok(result)
    }
}

impl Repository {
    pub(super) async fn file_path_changes(
        &self,
        updates: &[(Value, Value)],
        deleting_resource: bool,
    ) -> Result<Vec<Value>> {
        if updates.is_empty() {
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
        let mut paths = BTreeMap::<String, (String, String, String, bool)>::new();
        let mut summaries = BTreeMap::<String, (String, i64, i64, i64)>::new();
        let mut directories = BTreeMap::<String, (String, String, i64, bool)>::new();
        for (before, after) in updates {
            for (file, delta) in [(before, -1), (after, 1)] {
                if file.is_null() {
                    continue;
                }
                let (resource, _, _) = fields(file)?;
                let summary =
                    summaries
                        .entry(summary_key(resource))
                        .or_insert((resource.into(), 0, 0, 0));
                summary.1 += delta;
                summary.2 += delta * i64::from(file["type"] == "file");
                summary.3 += delta * size(file);
            }
            let old = if before.is_null() {
                None
            } else {
                Some(fields(before)?)
            };
            let new = if after.is_null() {
                None
            } else {
                Some(fields(after)?)
            };
            if before["type"] == "directory"
                && (after.is_null() || old != new || after["type"] != "directory")
            {
                let (resource, path, _) = fields(before)?;
                directories
                    .entry(children_key(resource, path))
                    .or_insert((resource.into(), path.into(), 0, false))
                    .3 = true;
            }
            if old == new {
                continue;
            }
            for (entry, deleting) in [(old, true), (new, false)] {
                if let Some((resource, path, id)) = entry {
                    for key in [path_key(resource, path), directory_key(resource, path)] {
                        if paths
                            .insert(key, (resource.into(), path.into(), id.into(), deleting))
                            .is_some()
                        {
                            return Err(error("FILE_INDEX_CORRUPT"));
                        }
                    }
                    let dir = parent(path);
                    directories
                        .entry(children_key(resource, &dir))
                        .or_insert((resource.into(), dir, 0, false))
                        .2 += if deleting { -1 } else { 1 };
                }
            }
        }
        let keys = paths
            .keys()
            .chain(summaries.keys())
            .chain(directories.keys())
            .cloned()
            .collect();
        let previous = self.get_many(keys).await?;
        let mut changes = Vec::new();
        for (key, (resource, path, id, deleting)) in paths {
            let prior = &previous[&key];
            if deleting {
                if prior["value"]["resourceId"] != resource
                    || prior["value"]["path"] != path
                    || prior["value"]["id"] != id
                {
                    return Err(error("FILE_INDEX_CORRUPT"));
                }
                changes.push(json!({"key":key,"expectedVersion":version(prior),"delete":true}));
            } else {
                if !prior.is_null() {
                    return Err(ServiceError::new(409, "META_CONFLICT"));
                }
                changes.push(json!({"key":key,"expectedVersion":null,"value":{"resourceId":resource,"path":path,"id":id}}));
            }
        }
        for (key, (resource, count, files, bytes)) in summaries {
            let prior = &previous[&key];
            if !prior.is_null() && prior["value"]["resourceId"] != resource {
                return Err(error("FILE_INDEX_CORRUPT"));
            }
            let updated = adjust(prior, "count", count)?;
            if count > 0 && updated > 2000 {
                return Err(ServiceError::new(409, "FREE_TIER_LIMIT"));
            }
            changes.push(json!({"key":key,"expectedVersion":version(prior),"value":{"resourceId":resource,"count":updated,"files":adjust(prior,"files",files)?,"bytes":adjust(prior,"bytes",bytes)?}}));
        }
        for (key, (resource, directory, count, checking_empty)) in directories {
            let prior = &previous[&key];
            if !prior.is_null()
                && (prior["value"]["resourceId"] != resource
                    || prior["value"]["directory"] != directory)
            {
                return Err(error("FILE_INDEX_CORRUPT"));
            }
            let updated = adjust(prior, "count", count)?;
            if checking_empty && updated != 0 && !deleting_resource {
                return Err(ServiceError::new(409, "DIRECTORY_NOT_EMPTY"));
            }
            // Writing even a zero counter fences concurrent child creation against directory deletion.
            changes.push(json!({"key":key,"expectedVersion":version(prior),"value":{"resourceId":resource,"directory":directory,"count":updated}}));
        }
        Ok(changes)
    }

    pub async fn local_file_summary(&self, resource: &str) -> Result<Value> {
        let prior = self.get(&summary_key(resource)).await?;
        if prior.is_null() {
            return Ok(json!({"count":0,"files":0,"bytes":0}));
        }
        if prior["value"]["resourceId"] != resource {
            return Err(error("FILE_INDEX_CORRUPT"));
        }
        Ok(prior["value"].clone())
    }
}

impl Repository {
    pub async fn local_file_page(
        &self,
        resource: &str,
        directory: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<Value>, Option<String>)> {
        self.ensure_file_indexes().await?;
        let prefix = directory_prefix(resource, directory);
        let after = match cursor {
            None => None,
            Some(value)
                if value.len() == 64
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) =>
            {
                Some(format!("{prefix}{value}"))
            }
            _ => return Err(ServiceError::new(400, "INVALID_CURSOR")),
        };
        for attempt in 0..8 {
            let _lock = self.queue.read().await;
            let page = self
                .call(MetaRequest::List {
                    scope: self.scope.clone(),
                    guard: Some(self.guard.clone()),
                    prefix: prefix.clone(),
                    after: after.clone(),
                    limit: limit.clamp(1, 32),
                })
                .await?;
            let indexes = page["records"]
                .as_array()
                .ok_or_else(|| error("FILE_INDEX_CORRUPT"))?;
            let mut paths = Vec::new();
            let mut expected = BTreeMap::new();
            for entry in indexes {
                let value = &entry["value"];
                let path = value["path"]
                    .as_str()
                    .ok_or_else(|| error("FILE_INDEX_CORRUPT"))?;
                let id = value["id"]
                    .as_str()
                    .ok_or_else(|| error("FILE_INDEX_CORRUPT"))?;
                if value["resourceId"] != resource
                    || parent(path) != directory
                    || entry["key"] != directory_key(resource, path)
                {
                    return Err(error("FILE_INDEX_CORRUPT"));
                }
                let key = format!("state/files/{id}");
                expected.insert(
                    key.clone(),
                    (
                        path.to_owned(),
                        directory_key(resource, path),
                        entry["version"].clone(),
                    ),
                );
                paths.push(key);
            }
            let mut records = Records::new();
            for chunk in paths.chunks(8) {
                records.extend(self.get_many(chunk.to_vec()).await?);
            }
            let mut output = Vec::new();
            let mut conflict = false;
            for key in paths {
                let record = &records[&key];
                let (path, index, index_version) = &expected[&key];
                if record.is_null()
                    || record["value"]["record"]["resourceId"] != resource
                    || record["value"]["record"]["path"] != *path
                {
                    if version(&self.get(index).await?) != *index_version {
                        conflict = true;
                        break;
                    }
                    return Err(error("FILE_INDEX_CORRUPT"));
                }
                output.push(record["value"]["record"].clone());
            }
            if conflict {
                if attempt < 7 {
                    continue;
                }
                return Err(ServiceError::new(409, "META_CONFLICT"));
            }
            let next = page["nextCursor"]
                .as_str()
                .map(|value| {
                    value
                        .strip_prefix(&prefix)
                        .map(str::to_owned)
                        .ok_or_else(|| error("FILE_INDEX_CORRUPT"))
                })
                .transpose()?;
            return Ok((output, next));
        }
        unreachable!()
    }
}
