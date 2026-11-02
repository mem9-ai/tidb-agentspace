//! Workspace-scoped audit primitives. This module is not yet connected to API operations.
//!
//! The stored schema deliberately has no free-form text or metadata maps: callers must not
//! persist requests, credentials, provider errors, SQL, commands, or customer content here.
use super::*;

const AUDIT_HEAD: &str = "observability/audit-v1/head";
const AUDIT_RECORDS: &str = "observability/audit-v1/records/";
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

impl Repository {
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
        let _guard = self.queue.read().await;
        let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
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
        for attempt in 0..8 {
            let head = self.get(AUDIT_HEAD).await?;
            let (position, count) = if head.is_null() {
                (0, 0)
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
                (position, count)
            };
            let next = position
                .checked_add(1)
                .ok_or_else(|| error("AUDIT_INDEX_CORRUPT"))?;
            let mut changes = vec![
                json!({"key":AUDIT_HEAD,"expectedVersion":version(&head),"value":{"format":1,"position":next,"count":(count+1).min(AUDIT_CAPACITY)}}),
                json!({"key":record_key(next),"expectedVersion":null,"value":record}),
            ];
            if count == AUDIT_CAPACITY {
                let oldest_key = record_key(position - count + 1);
                let oldest = self.get(&oldest_key).await?;
                if oldest.is_null() {
                    if version(&self.get(AUDIT_HEAD).await?) != version(&head) && attempt < 7 {
                        continue;
                    }
                    return Err(error("AUDIT_INDEX_CORRUPT"));
                }
                changes.push(
                    json!({"key":oldest_key,"expectedVersion":version(&oldest),"delete":true}),
                );
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
