//! Workspace-scoped audit primitives. This module is not yet connected to API operations.
//!
//! The stored schema deliberately has no free-form text or metadata maps: callers must not
//! persist requests, credentials, provider errors, SQL, commands, or customer content here.
use super::*;
mod history;
mod maintenance;
mod requests;
pub use history::{HistoryFilter, HistoryStream};
pub use maintenance::{HistoryJob, HistoryMaintenance, HistoryMaintenancePage};
pub use requests::{HttpCompletion, HttpMethod, HttpOperation, RequestEntry};

const AUDIT_HEAD: &str = "observability/audit-v1/head";
const AUDIT_RECORDS: &str = "observability/audit-v1/records/";
const AUDIT_OPERATIONS: &str = "observability/audit-v1/operations/";
const AUDIT_ORDER: &str = "observability/audit-v1/order/";
const AUDIT_EXPIRY: &str = "observability/audit-v1/expiry/";
const AUDIT_CAPACITY: u64 = 100_000;

#[derive(Clone, Copy)]
pub enum ActorKind {
    Owner,
    WorkspaceKey,
}

#[derive(Clone, Copy)]
pub enum AuditAction {
    ResourceCreate,
    ResourceDelete,
    FileWrite,
    FileDelete,
    QueryWrite,
}

#[derive(Clone, Copy)]
pub enum AuditOutcome {
    Attempted,
    Succeeded,
    Denied,
    Failed,
    Unknown,
}

/// Values must be obtained from authenticated, authority-bound state, never from a URL or
/// an unauthenticated request. IDs are identifiers only, not labels, paths or credentials.
pub struct AuditIntent<'a> {
    pub request_id: Option<Uuid>,
    pub actor_kind: ActorKind,
    pub actor_id: &'a str,
    pub action: AuditAction,
    pub target_id: Option<&'a str>,
}

/// Returned only after a durable attempt. Dropping it leaves that attempt unresolved, which
/// downstream readers must treat as unknown rather than assuming success or failure.
pub struct AuditOperation {
    operation_id: Uuid,
    request_id: Option<Uuid>,
    actor_kind: ActorKind,
    actor_id: String,
    action: AuditAction,
    target_id: Option<String>,
    workspace_id: String,
    authority_id: String,
}

pub struct AuditPurge {
    pub removed: usize,
    pub pending: usize,
}

fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.:".contains(&byte))
}

fn record_key(position: u64) -> String {
    format!("{AUDIT_RECORDS}{:020}", u64::MAX - position)
}
fn order_key(position: u64) -> String {
    format!("{AUDIT_ORDER}{position:020}")
}
fn expiry_key(deadline: u64, position: u64) -> String {
    format!("{AUDIT_EXPIRY}{deadline:020}/{position:020}")
}

impl Repository {
    /// Remove expired confirmed records in a bounded batch. Unresolved attempts are retained
    /// for reconciliation, and a durable host scheduler is still required for idle Workspaces.
    pub async fn purge_expired_audit_batch(
        &self,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<AuditPurge> {
        let current = u64::try_from(now.timestamp())
            .map_err(|_| ServiceError::new(400, "AUDIT_CLOCK_INVALID"))?;
        let _guard = self.queue.read().await;
        'attempts: for attempt in 0..8 {
            let head = self.get(AUDIT_HEAD).await?;
            if head.is_null() {
                return Ok(AuditPurge {
                    removed: 0,
                    pending: 0,
                });
            }
            let position = head["value"]["position"]
                .as_u64()
                .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?;
            let count = head["value"]["count"]
                .as_u64()
                .filter(|count| *count <= AUDIT_CAPACITY && *count <= position)
                .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?;
            let pending = head["value"]["pending"]
                .as_u64()
                .filter(|pending| *pending <= AUDIT_CAPACITY - count)
                .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?;
            if head["value"]["format"] != 1 {
                return Err(error("AUDIT_INDEX_CORRUPT"));
            }
            let page = self
                .call(MetaRequest::List {
                    scope: self.scope.clone(),
                    guard: Some(self.guard.clone()),
                    prefix: AUDIT_EXPIRY.into(),
                    after: None,
                    limit: 64,
                })
                .await?;
            let indexes = page["records"]
                .as_array()
                .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?;
            let mut expired = Vec::new();
            let mut keys = Vec::new();
            for index in indexes {
                let sequence = index["value"]["sequence"]
                    .as_u64()
                    .filter(|value| *value > 0 && *value <= position)
                    .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?;
                let deadline = index["value"]["deadline"]
                    .as_u64()
                    .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?;
                if index["key"] != expiry_key(deadline, sequence) {
                    return Err(error("AUDIT_INDEX_CORRUPT"));
                }
                if deadline > current {
                    break;
                }
                keys.push(record_key(sequence));
                keys.push(order_key(sequence));
                expired.push((index, sequence, deadline));
            }
            if expired.is_empty() {
                return Ok(AuditPurge {
                    removed: 0,
                    pending: 0,
                });
            }
            if expired.len() as u64 > count {
                return Err(error("AUDIT_INDEX_CORRUPT"));
            }
            let prior = self
                .call(MetaRequest::Get {
                    scope: self.scope.clone(),
                    guard: Some(self.guard.clone()),
                    keys: keys.clone(),
                })
                .await?["records"]
                .clone();
            let mut operation_keys = std::collections::BTreeSet::new();
            for (_, sequence, deadline) in &expired {
                let record = &prior[&record_key(*sequence)];
                let order = &prior[&order_key(*sequence)];
                if record.is_null() || order.is_null() {
                    if version(&self.get(AUDIT_HEAD).await?) != version(&head) && attempt < 7 {
                        continue 'attempts;
                    }
                    return Err(error("AUDIT_INDEX_CORRUPT"));
                }
                if order["value"]["sequence"] != *sequence
                    || order["value"]["deadline"] != *deadline
                {
                    return Err(error("AUDIT_INDEX_CORRUPT"));
                }
                let id = record["value"]["operationId"]
                    .as_str()
                    .and_then(|id| Uuid::parse_str(id).ok())
                    .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?;
                operation_keys.insert(format!("{AUDIT_OPERATIONS}{id}"));
            }
            let operations = self
                .call(MetaRequest::Get {
                    scope: self.scope.clone(),
                    guard: Some(self.guard.clone()),
                    keys: operation_keys.into_iter().collect(),
                })
                .await?["records"]
                .clone();
            let mut removed = 0usize;
            let mut blocked = 0usize;
            let mut changes = Vec::new();
            let mut updates = BTreeMap::<String, u64>::new();
            for (index, sequence, _) in &expired {
                let record_key = record_key(*sequence);
                let order_key = order_key(*sequence);
                let record = &prior[&record_key];
                let id = record["value"]["operationId"]
                    .as_str()
                    .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?;
                let operation_key = format!("{AUDIT_OPERATIONS}{id}");
                let operation = &operations[&operation_key];
                if operation.is_null() {
                    if version(&self.get(AUDIT_HEAD).await?) != version(&head) && attempt < 7 {
                        continue 'attempts;
                    }
                    return Err(error("AUDIT_INDEX_CORRUPT"));
                }
                if operation["value"]["status"] == "pending" {
                    blocked += 1;
                    continue;
                }
                *updates.entry(operation_key).or_default() += 1;
                changes.push(
                    json!({"key":record_key,"expectedVersion":version(record),"delete":true}),
                );
                changes.push(json!({"key":order_key,"expectedVersion":version(&prior[&order_key]),"delete":true}));
                changes.push(
                    json!({"key":index["key"],"expectedVersion":index["version"],"delete":true}),
                );
                removed += 1;
            }
            if removed == 0 {
                return Ok(AuditPurge {
                    removed,
                    pending: blocked,
                });
            }
            for (key, removed_for_operation) in updates {
                let stored = &operations[&key];
                let remaining = stored["value"]["remaining"]
                    .as_u64()
                    .filter(|value| *value >= removed_for_operation && *value <= 2)
                    .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?;
                if remaining == removed_for_operation {
                    changes
                        .push(json!({"key":key,"expectedVersion":version(stored),"delete":true}));
                } else {
                    let mut value = stored["value"].clone();
                    value["remaining"] = json!(remaining - removed_for_operation);
                    changes
                        .push(json!({"key":key,"expectedVersion":version(stored),"value":value}));
                }
            }
            changes.push(json!({"key":AUDIT_HEAD,"expectedVersion":version(&head),"value":{"format":1,"position":position,"count":count-removed as u64,"pending":pending}}));
            match self.commit(changes).await {
                Ok(()) => {
                    return Ok(AuditPurge {
                        removed,
                        pending: blocked,
                    });
                }
                Err(failure) if failure.code == "META_CONFLICT" && attempt < 7 => continue,
                Err(failure) => return Err(failure),
            }
        }
        unreachable!()
    }

    pub async fn begin_audit_operation(&self, intent: AuditIntent<'_>) -> Result<AuditOperation> {
        let operation = AuditOperation {
            operation_id: Uuid::new_v4(),
            request_id: intent.request_id,
            actor_kind: intent.actor_kind,
            actor_id: intent.actor_id.into(),
            action: intent.action,
            target_id: intent.target_id.map(str::to_owned),
            workspace_id: self.workspace_id().into(),
            authority_id: self.authority_id().into(),
        };
        self.append_audit_transition(&operation, AuditOutcome::Attempted)
            .await?;
        Ok(operation)
    }

    pub async fn finish_audit_operation(
        &self,
        operation: AuditOperation,
        outcome: AuditOutcome,
    ) -> Result<()> {
        if matches!(outcome, AuditOutcome::Attempted)
            || operation.workspace_id != self.workspace_id()
            || operation.authority_id != self.authority_id()
        {
            return Err(ServiceError::new(400, "INVALID_AUDIT_TRANSITION"));
        }
        self.append_audit_transition(&operation, outcome).await
    }

    /// Append one immutable transition under this repository's Workspace and writer fence.
    /// The caller must persist an attempt before authorizing any covered external effect.
    /// An uncertain commit is returned as an error and must never trigger an automatic effect.
    async fn append_audit_transition(
        &self,
        entry: &AuditOperation,
        outcome: AuditOutcome,
    ) -> Result<()> {
        if !safe_id(&entry.actor_id) || entry.target_id.as_deref().is_some_and(|id| !safe_id(id)) {
            return Err(ServiceError::new(400, "INVALID_AUDIT_ID"));
        }
        self.ensure_history_maintenance().await?;
        let _guard = self.queue.read().await;
        let now = chrono::Utc::now();
        let timestamp = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let deadline = now
            .timestamp()
            .checked_add(30 * 86_400)
            .and_then(|value| u64::try_from(value).ok())
            .ok_or_else(|| error("AUDIT_CLOCK_INVALID"))?;
        let record_id = Uuid::new_v4();
        let action = match entry.action {
            AuditAction::ResourceCreate => "resource.create",
            AuditAction::ResourceDelete => "resource.delete",
            AuditAction::FileWrite => "file.write",
            AuditAction::FileDelete => "file.delete",
            AuditAction::QueryWrite => "query.write",
        };
        let outcome = match outcome {
            AuditOutcome::Attempted => "attempted",
            AuditOutcome::Succeeded => "succeeded",
            AuditOutcome::Denied => "denied",
            AuditOutcome::Failed => "failed",
            AuditOutcome::Unknown => "unknown",
        };
        let actor_kind = match entry.actor_kind {
            ActorKind::Owner => "owner",
            ActorKind::WorkspaceKey => "workspaceKey",
        };
        let record = json!({
            "id":record_id.to_string(), "operationId":entry.operation_id.to_string(),
            "requestId":entry.request_id.map(|id|id.to_string()),
            "authority":self.authority_id(), "actor":{"kind":actor_kind,"id":entry.actor_id},
            "action":action, "targetId":entry.target_id, "outcome":outcome, "occurredAt":timestamp,
        });
        let operation_key = format!("{AUDIT_OPERATIONS}{}", entry.operation_id);
        let starting = outcome == "attempted";
        'attempts: for attempt in 0..8 {
            let head = self.get(AUDIT_HEAD).await?;
            let (position, count, pending) = if head.is_null() {
                (0, 0, 0)
            } else {
                if head["value"]["format"] != 1 {
                    return Err(error("AUDIT_INDEX_CORRUPT"));
                }
                let position = head["value"]["position"]
                    .as_u64()
                    .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?;
                let count = head["value"]["count"]
                    .as_u64()
                    .filter(|count| *count <= AUDIT_CAPACITY && *count <= position)
                    .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?;
                let pending = head["value"]["pending"]
                    .as_u64()
                    .filter(|pending| *pending <= AUDIT_CAPACITY - count)
                    .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?;
                (position, count, pending)
            };
            let operation = self.get(&operation_key).await?;
            if starting && !operation.is_null()
                || !starting
                    && (operation["value"]["status"] != "pending"
                        || operation["value"]["writerId"] != self.guard.owner_id
                        || pending == 0)
            {
                return Err(ServiceError::new(409, "INVALID_AUDIT_TRANSITION"));
            }
            let next = position
                .checked_add(1)
                .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?;
            // Each pending operation reserves space for its eventual outcome. If the oldest
            // attempt is still pending, refuse new work rather than discard an unresolved effect.
            let next_pending = if starting { pending + 1 } else { pending - 1 };
            let excess = (count + 1 + next_pending).saturating_sub(AUDIT_CAPACITY);
            let mut changes = Vec::new();
            let mut old_operations = BTreeMap::<String, (Value, u64)>::new();
            let old_index = if excess == 0 {
                Vec::new()
            } else {
                let page = self
                    .call(MetaRequest::List {
                        scope: self.scope.clone(),
                        guard: Some(self.guard.clone()),
                        prefix: AUDIT_ORDER.into(),
                        after: None,
                        limit: excess as usize,
                    })
                    .await?;
                page["records"]
                    .as_array()
                    .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?
                    .clone()
            };
            if old_index.len() != excess as usize {
                if version(&self.get(AUDIT_HEAD).await?) != version(&head) && attempt < 7 {
                    continue 'attempts;
                }
                return Err(error("AUDIT_INDEX_CORRUPT"));
            }
            for index in old_index {
                let sequence = index["value"]["sequence"]
                    .as_u64()
                    .filter(|value| *value > 0 && *value <= position)
                    .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?;
                let old_deadline = index["value"]["deadline"]
                    .as_u64()
                    .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?;
                if index["key"] != order_key(sequence) {
                    return Err(error("AUDIT_INDEX_CORRUPT"));
                }
                let oldest_key = record_key(sequence);
                let oldest = self.get(&oldest_key).await?;
                if oldest.is_null() {
                    if version(&self.get(AUDIT_HEAD).await?) != version(&head) && attempt < 7 {
                        continue 'attempts;
                    }
                    return Err(error("AUDIT_INDEX_CORRUPT"));
                }
                let old_id = oldest["value"]["operationId"]
                    .as_str()
                    .and_then(|id| Uuid::parse_str(id).ok())
                    .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?;
                let old_operation_key = format!("{AUDIT_OPERATIONS}{old_id}");
                let old_operation = self.get(&old_operation_key).await?;
                if old_operation.is_null() {
                    if version(&self.get(AUDIT_HEAD).await?) != version(&head) && attempt < 7 {
                        continue 'attempts;
                    }
                    return Err(error("AUDIT_INDEX_CORRUPT"));
                }
                if old_operation["value"]["status"] == "pending" {
                    return Err(ServiceError::new(503, "AUDIT_CAPACITY"));
                }
                let state = old_operations
                    .entry(old_operation_key)
                    .or_insert((old_operation, 0));
                state.1 += 1;
                let old_expiry_key = expiry_key(old_deadline, sequence);
                let old_expiry = self.get(&old_expiry_key).await?;
                if old_expiry.is_null() {
                    if version(&self.get(AUDIT_HEAD).await?) != version(&head) && attempt < 7 {
                        continue 'attempts;
                    }
                    return Err(error("AUDIT_INDEX_CORRUPT"));
                }
                changes.push(json!({"key":order_key(sequence),"expectedVersion":index["version"],"delete":true}));
                changes.push(json!({"key":old_expiry_key,"expectedVersion":version(&old_expiry),"delete":true}));
                changes.push(
                    json!({"key":oldest_key,"expectedVersion":version(&oldest),"delete":true}),
                );
            }
            for (key, (stored, removed)) in old_operations {
                let remaining = stored["value"]["remaining"]
                    .as_u64()
                    .filter(|remaining| *remaining >= removed && *remaining <= 2)
                    .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?;
                if remaining == removed {
                    changes
                        .push(json!({"key":key,"expectedVersion":version(&stored),"delete":true}));
                } else {
                    let mut value = stored["value"].clone();
                    value["remaining"] = json!(remaining - removed);
                    changes
                        .push(json!({"key":key,"expectedVersion":version(&stored),"value":value}));
                }
            }
            let operation_state = if starting {
                json!({"status":"pending","attempt":record,"remaining":1,"writerId":self.guard.owner_id})
            } else {
                if operation["value"]["remaining"] != 1 {
                    return Err(error("AUDIT_INDEX_CORRUPT"));
                }
                json!({"status":outcome,"attempt":operation["value"]["attempt"],"remaining":2,"writerId":operation["value"]["writerId"]})
            };
            changes.extend([
                json!({"key":AUDIT_HEAD,"expectedVersion":version(&head),"value":{"format":1,"position":next,"count":count+1-excess,"pending":next_pending}}),
                json!({"key":record_key(next),"expectedVersion":null,"value":record}),
                json!({"key":order_key(next),"expectedVersion":null,"value":{"sequence":next,"deadline":deadline}}),
                json!({"key":expiry_key(deadline,next),"expectedVersion":null,"value":{"sequence":next,"deadline":deadline}}),
                json!({"key":operation_key,"expectedVersion":version(&operation),"value":operation_state}),
            ]);
            match self.commit(changes).await {
                Ok(()) => return Ok(()),
                Err(failure) if failure.code == "META_CONFLICT" && attempt < 7 => continue,
                Err(failure) => return Err(failure),
            }
        }
        unreachable!()
    }
}
