//! Batched diagnostic records, kept separately from the durable audit journal.
use super::*;

pub(super) const HEAD: &str = "observability/requests-v1/head";
pub(super) const RECORDS: &str = "observability/requests-v1/records/";
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

impl Repository {
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
            records.push(json!({
                "id":Uuid::new_v4().to_string(),"requestId":entry.request_id.to_string(),
                "authority":self.authority_id(),"actor":{"kind":actor,"id":entry.actor_id},
                "operation":operation,"method":method,"status":status,"completion":completion,
                "startedAt":entry.started_at.to_rfc3339_opts(chrono::SecondsFormat::Millis,true),
                "durationMs":entry.duration_ms,
            }));
        }
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
            let mut changes = Vec::with_capacity(records.len() + excess as usize + 1);
            let old_keys = (0..excess)
                .map(|offset| record_key(position - count + 1 + offset))
                .collect::<Vec<_>>();
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
            for (offset, record) in records.iter().enumerate() {
                changes.push(json!({"key":record_key(position+offset as u64+1),"expectedVersion":null,"value":record}));
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
