//! Batched diagnostic records, kept separately from the durable audit journal.
use super::*;

pub(super) const HEAD: &str = "observability/requests-v1/head";
pub(super) const RECORDS: &str = "observability/requests-v1/records/";
pub(super) const ORDER: &str = "observability/requests-v1/order/";
pub(super) const EXPIRY: &str = "observability/requests-v1/expiry/";
pub(super) const CAPACITY: u64 = 100_000;
const MAX_BATCH: usize = 64;

#[derive(Clone, Copy)]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Other,
}

#[derive(Clone, Copy)]
pub enum HttpOperation {
    Workspace,
    Resources,
    Files,
    Query,
    Other,
}

#[derive(Clone, Copy)]
pub enum HttpCompletion {
    Responded(u16),
    Canceled,
    Unknown,
}

/// The caller supplies identities only after authentication. No part of the raw request,
/// headers, query string, URL, body, SQL, command, or provider error is accepted here.
pub struct RequestEntry<'a> {
    pub request_id: Uuid,
    pub actor_kind: ActorKind,
    pub actor_id: &'a str,
    pub operation: HttpOperation,
    pub method: HttpMethod,
    pub completion: HttpCompletion,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub duration_ms: u64,
}

fn record_key(position: u64) -> String {
    format!("{RECORDS}{:020}", u64::MAX - position)
}
fn order_key(position: u64) -> String {
    format!("{ORDER}{position:020}")
}
fn expiry_key(deadline: u64, position: u64) -> String {
    format!("{EXPIRY}{deadline:020}/{position:020}")
}

impl Repository {
    /// Delete at most one bounded batch of expired diagnostics. The regional scheduler
    /// revisits inactive Workspaces after their deadlines.
    pub async fn purge_expired_request_batch(
        &self,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<usize> {
        let current = u64::try_from(now.timestamp())
            .map_err(|_| ServiceError::new(400, "INVALID_REQUEST_TIME"))?;
        let _guard = self.queue.read().await;
        'attempts: for attempt in 0..8 {
            let head = self.get(HEAD).await?;
            if head.is_null() {
                return Ok(0);
            }
            let position = head["value"]["position"]
                .as_u64()
                .ok_or_else(|| error("REQUEST_INDEX_CORRUPT"))?;
            let count = head["value"]["count"]
                .as_u64()
                .filter(|count| *count <= CAPACITY && *count <= position)
                .ok_or_else(|| error("REQUEST_INDEX_CORRUPT"))?;
            if head["value"]["format"] != 1 {
                return Err(error("REQUEST_INDEX_CORRUPT"));
            }
            let page = self
                .call(MetaRequest::List {
                    scope: self.scope.clone(),
                    guard: Some(self.guard.clone()),
                    prefix: EXPIRY.into(),
                    after: None,
                    limit: MAX_BATCH,
                })
                .await?;
            let indexes = page["records"]
                .as_array()
                .ok_or_else(|| error("REQUEST_INDEX_CORRUPT"))?;
            let mut expired = Vec::new();
            let mut keys = Vec::new();
            for index in indexes {
                let sequence = index["value"]["sequence"]
                    .as_u64()
                    .filter(|sequence| *sequence > 0 && *sequence <= position)
                    .ok_or_else(|| error("REQUEST_INDEX_CORRUPT"))?;
                let deadline = index["value"]["deadline"]
                    .as_u64()
                    .ok_or_else(|| error("REQUEST_INDEX_CORRUPT"))?;
                if index["key"] != expiry_key(deadline, sequence) {
                    return Err(error("REQUEST_INDEX_CORRUPT"));
                }
                if deadline > current {
                    break;
                }
                keys.push(record_key(sequence));
                keys.push(order_key(sequence));
                expired.push(index);
            }
            if expired.is_empty() {
                return Ok(0);
            }
            if expired.len() as u64 > count {
                return Err(error("REQUEST_INDEX_CORRUPT"));
            }
            let prior = self
                .call(MetaRequest::Get {
                    scope: self.scope.clone(),
                    guard: Some(self.guard.clone()),
                    keys: keys.clone(),
                })
                .await?["records"]
                .clone();
            for index in &expired {
                let sequence = index["value"]["sequence"]
                    .as_u64()
                    .ok_or_else(|| error("REQUEST_INDEX_CORRUPT"))?;
                let deadline = index["value"]["deadline"]
                    .as_u64()
                    .ok_or_else(|| error("REQUEST_INDEX_CORRUPT"))?;
                let ordered = &prior[&order_key(sequence)];
                if !ordered.is_null()
                    && (ordered["value"]["sequence"] != sequence
                        || ordered["value"]["deadline"] != deadline)
                {
                    return Err(error("REQUEST_INDEX_CORRUPT"));
                }
            }
            let mut changes = Vec::with_capacity(keys.len() + expired.len() + 1);
            for key in keys {
                let record = &prior[&key];
                if record.is_null() {
                    if version(&self.get(HEAD).await?) != version(&head) && attempt < 7 {
                        continue 'attempts;
                    }
                    return Err(error("REQUEST_INDEX_CORRUPT"));
                }
                changes.push(json!({"key":key,"expectedVersion":version(record),"delete":true}));
            }
            for index in &expired {
                changes.push(
                    json!({"key":index["key"],"expectedVersion":index["version"],"delete":true}),
                );
            }
            changes.push(json!({"key":HEAD,"expectedVersion":version(&head),"value":{"format":1,"position":position,"count":count-expired.len() as u64}}));
            match self.commit(changes).await {
                Ok(()) => return Ok(expired.len()),
                Err(failure) if failure.code == "META_CONFLICT" && attempt < 7 => continue,
                Err(failure) => return Err(failure),
            }
        }
        unreachable!()
    }

    /// The host must use a bounded queue and disclose diagnostic loss. This method performs
    /// one Workspace-local metadata commit per batch and is not an audit journal.
    pub async fn append_request_batch(&self, entries: &[RequestEntry<'_>]) -> Result<()> {
        if entries.is_empty() || entries.len() > MAX_BATCH {
            return Err(ServiceError::new(400, "INVALID_REQUEST_BATCH"));
        }
        let mut records = Vec::with_capacity(entries.len());
        for entry in entries {
            if !safe_id(entry.actor_id) {
                return Err(ServiceError::new(400, "INVALID_REQUEST_ACTOR"));
            }
            let deadline = entry
                .started_at
                .timestamp()
                .checked_add(7 * 86_400)
                .and_then(|value| u64::try_from(value).ok())
                .ok_or_else(|| ServiceError::new(400, "INVALID_REQUEST_TIME"))?;
            let (completion, status) = match entry.completion {
                HttpCompletion::Responded(code) if (100..=599).contains(&code) => {
                    ("responded", Some(code))
                }
                HttpCompletion::Responded(_) => {
                    return Err(ServiceError::new(400, "INVALID_REQUEST_STATUS"));
                }
                HttpCompletion::Canceled => ("canceled", None),
                HttpCompletion::Unknown => ("unknown", None),
            };
            let method = match entry.method {
                HttpMethod::Get => "GET",
                HttpMethod::Post => "POST",
                HttpMethod::Put => "PUT",
                HttpMethod::Patch => "PATCH",
                HttpMethod::Delete => "DELETE",
                HttpMethod::Other => "OTHER",
            };
            let operation = match entry.operation {
                HttpOperation::Workspace => "workspace",
                HttpOperation::Resources => "resources",
                HttpOperation::Files => "files",
                HttpOperation::Query => "query",
                HttpOperation::Other => "other",
            };
            let actor = match entry.actor_kind {
                ActorKind::Owner => "owner",
                ActorKind::WorkspaceKey => "workspaceKey",
            };
            records.push((json!({
                "id":Uuid::new_v4().to_string(),"requestId":entry.request_id.to_string(),
                "authority":self.authority_id(),"actor":{"kind":actor,"id":entry.actor_id},
                "operation":operation,"method":method,"status":status,"completion":completion,
                "startedAt":entry.started_at.to_rfc3339_opts(chrono::SecondsFormat::Millis,true),
                "durationMs":entry.duration_ms,
            }), deadline));
        }
        self.ensure_history_maintenance().await?;
        let _guard = self.queue.read().await;
        'attempts: for attempt in 0..8 {
            let head = self.get(HEAD).await?;
            let (position, count) = if head.is_null() {
                (0, 0)
            } else {
                if head["value"]["format"] != 1 {
                    return Err(error("REQUEST_INDEX_CORRUPT"));
                }
                let position = head["value"]["position"]
                    .as_u64()
                    .ok_or_else(|| error("REQUEST_INDEX_CORRUPT"))?;
                let count = head["value"]["count"]
                    .as_u64()
                    .filter(|count| *count <= CAPACITY && *count <= position)
                    .ok_or_else(|| error("REQUEST_INDEX_CORRUPT"))?;
                (position, count)
            };
            let batch = records.len() as u64;
            let next = position
                .checked_add(batch)
                .ok_or_else(|| error("REQUEST_INDEX_CORRUPT"))?;
            let excess = (count + batch).saturating_sub(CAPACITY);
            let mut changes = Vec::with_capacity(records.len() * 3 + excess as usize * 3 + 1);
            let old_index = if excess == 0 {
                Vec::new()
            } else {
                let page = self
                    .call(MetaRequest::List {
                        scope: self.scope.clone(),
                        guard: Some(self.guard.clone()),
                        prefix: ORDER.into(),
                        after: None,
                        limit: excess as usize,
                    })
                    .await?;
                page["records"]
                    .as_array()
                    .ok_or_else(|| error("REQUEST_INDEX_CORRUPT"))?
                    .clone()
            };
            if old_index.len() != excess as usize {
                if version(&self.get(HEAD).await?) != version(&head) && attempt < 7 {
                    continue 'attempts;
                }
                return Err(error("REQUEST_INDEX_CORRUPT"));
            }
            let mut old_keys = Vec::with_capacity(excess as usize * 2);
            for index in &old_index {
                let sequence = index["value"]["sequence"]
                    .as_u64()
                    .filter(|value| *value > 0 && *value <= position)
                    .ok_or_else(|| error("REQUEST_INDEX_CORRUPT"))?;
                let deadline = index["value"]["deadline"]
                    .as_u64()
                    .ok_or_else(|| error("REQUEST_INDEX_CORRUPT"))?;
                if index["key"] != order_key(sequence) {
                    return Err(error("REQUEST_INDEX_CORRUPT"));
                }
                old_keys.push(record_key(sequence));
                old_keys.push(expiry_key(deadline, sequence));
                changes.push(json!({"key":order_key(sequence),"expectedVersion":index["version"],"delete":true}));
            }
            let old_records = if old_keys.is_empty() {
                json!({})
            } else {
                self.call(MetaRequest::Get {
                    scope: self.scope.clone(),
                    guard: Some(self.guard.clone()),
                    keys: old_keys.clone(),
                })
                .await?["records"]
                    .clone()
            };
            for key in old_keys {
                let old = &old_records[&key];
                if old.is_null() {
                    if version(&self.get(HEAD).await?) != version(&head) && attempt < 7 {
                        continue 'attempts;
                    }
                    return Err(error("REQUEST_INDEX_CORRUPT"));
                }
                changes.push(json!({"key":key,"expectedVersion":version(old),"delete":true}));
            }
            changes.push(json!({"key":HEAD,"expectedVersion":version(&head),"value":{"format":1,"position":next,"count":count+batch-excess}}));
            for (offset, (record, deadline)) in records.iter().enumerate() {
                let sequence = position + offset as u64 + 1;
                changes.push(
                    json!({"key":record_key(sequence),"expectedVersion":null,"value":record}),
                );
                changes.push(json!({"key":order_key(sequence),"expectedVersion":null,"value":{"sequence":sequence,"deadline":deadline}}));
                changes.push(json!({"key":expiry_key(*deadline,sequence),"expectedVersion":null,"value":{"sequence":sequence,"deadline":deadline}}));
            }
            match self.commit(changes).await {
                Ok(()) => return Ok(()),
                Err(failure) if failure.code == "META_CONFLICT" && attempt < 7 => continue,
                Err(failure) => return Err(failure),
            }
        }
        unreachable!()
    }
}
