//! Multi-Workspace and reopen checks for the inactive history storage boundary.
use crate::{Repository, observability::*};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use uuid::Uuid;
use workspace_contracts::{Call, MetaRequest, Metadata, ServiceError};

#[derive(Default)]
struct ScopedMetadata {
    scopes: Mutex<BTreeMap<String, BTreeMap<String, Value>>>,
    fail_after_audit_commit: AtomicBool,
}

impl Metadata for ScopedMetadata {
    fn health(&self) -> Call<'_> {
        Box::pin(async { Ok(json!({"authorityId":"region:test","capabilities":["recordsV1"]})) })
    }
    fn execute(&self, request: MetaRequest) -> Call<'_> {
        Box::pin(async move {
            let (scope, guard) = match &request {
                MetaRequest::Get { scope, guard, .. }
                | MetaRequest::List { scope, guard, .. }
                | MetaRequest::Commit { scope, guard, .. }
                | MetaRequest::Resolve { scope, guard, .. } => (scope, guard),
            };
            let name = serde_json::to_string(scope).unwrap();
            let mut all = self.scopes.lock().unwrap();
            let records = all.entry(name).or_default();
            if let Some(guard) = guard
                && records
                    .get("system/writer")
                    .and_then(|value| value["value"]["ownerId"].as_str())
                    != Some(guard.owner_id.as_str())
            {
                return Err(ServiceError::new(409, "META_WRITER_FENCED"));
            }
            match request {
                MetaRequest::Get { keys, .. } => Ok(
                    json!({"records":keys.into_iter().map(|key| {let value=records.get(&key).cloned().unwrap_or(Value::Null);(key,value)}).collect::<serde_json::Map<_,_>>()}),
                ),
                MetaRequest::List {
                    prefix,
                    after,
                    limit,
                    ..
                } => {
                    let mut selected = records
                        .iter()
                        .filter(|(key, _)| {
                            key.starts_with(&prefix)
                                && after.as_ref().is_none_or(|after| *key > after)
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
                    Ok(
                        json!({"records":selected.into_iter().map(|(key,value)|json!({"key":key,"version":value["version"],"value":value["value"]})).collect::<Vec<_>>(),"nextCursor":cursor}),
                    )
                }
                MetaRequest::Commit { changes, .. } => {
                    let unknown = changes
                        .iter()
                        .any(|change| change["key"] == "observability/audit-v1/head")
                        && self.fail_after_audit_commit.swap(false, Ordering::AcqRel);
                    for change in &changes {
                        let key = change["key"].as_str().unwrap();
                        let current = records
                            .get(key)
                            .map(|record| record["version"].clone())
                            .unwrap_or(Value::Null);
                        if current != change["expectedVersion"] {
                            return Err(ServiceError::new(409, "META_CONFLICT"));
                        }
                    }
                    for change in changes {
                        let key = change["key"].as_str().unwrap().to_owned();
                        if change["delete"] == true {
                            records.remove(&key);
                        } else {
                            records.insert(key,json!({"version":Uuid::new_v4().to_string(),"value":change["value"]}));
                        }
                    }
                    if unknown {
                        return Err(ServiceError::new(503, "META_COMMIT_UNKNOWN"));
                    }
                    Ok(json!({}))
                }
                MetaRequest::Resolve { .. } => Ok(json!({"outcome":"unknown"})),
            }
        })
    }
}

fn filter<'a>(cursor: Option<&'a str>) -> HistoryFilter<'a> {
    HistoryFilter {
        cursor,
        limit: 1,
        from: None,
        to: None,
    }
}

#[tokio::test]
async fn history_remains_workspace_scoped_and_survives_repository_reopen() {
    let metadata = Arc::new(ScopedMetadata::default());
    let first = Repository::open(metadata.clone(), "region:test", "workspace-a", true, None)
        .await
        .unwrap();
    let second = Repository::open(metadata.clone(), "region:test", "workspace-b", true, None)
        .await
        .unwrap();
    let entry = |status| RequestEntry {
        request_id: Uuid::new_v4(),
        actor_kind: ActorKind::Owner,
        actor_id: "owner-a",
        operation: HttpOperation::Files,
        method: HttpMethod::Get,
        completion: HttpCompletion::Responded(status),
        started_at: chrono::Utc::now(),
        duration_ms: 3,
    };
    first
        .append_request_batch(&[entry(200), entry(403)])
        .await
        .unwrap();
    let operation = first
        .begin_audit_operation(AuditIntent {
            request_id: None,
            actor_kind: ActorKind::Owner,
            actor_id: "owner-a",
            action: AuditAction::FileWrite,
            target_id: None,
        })
        .await
        .unwrap();
    first
        .finish_audit_operation(operation, AuditOutcome::Succeeded)
        .await
        .unwrap();
    let unfinished = first
        .begin_audit_operation(AuditIntent {
            request_id: None,
            actor_kind: ActorKind::Owner,
            actor_id: "owner-a",
            action: AuditAction::QueryWrite,
            target_id: None,
        })
        .await
        .unwrap();
    let page = first
        .history_page(HistoryStream::Requests, filter(None))
        .await
        .unwrap();
    let cursor = page["nextCursor"].as_str().unwrap().to_owned();
    assert_eq!(page["data"][0]["status"], 403);
    assert!(
        second
            .history_page(HistoryStream::Requests, filter(None))
            .await
            .unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        second
            .history_page(HistoryStream::Audit, filter(None))
            .await
            .unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        second
            .history_page(HistoryStream::Requests, filter(Some(&cursor)))
            .await
            .unwrap_err()
            .code,
        "INVALID_HISTORY_CURSOR"
    );
    first.close().await.unwrap();
    let reopened = Repository::open(metadata, "region:test", "workspace-a", false, None)
        .await
        .unwrap();
    assert_eq!(
        reopened
            .history_page(HistoryStream::Requests, filter(Some(&cursor)))
            .await
            .unwrap()["data"][0]["status"],
        200
    );
    assert_eq!(
        reopened
            .finish_audit_operation(unfinished, AuditOutcome::Succeeded)
            .await
            .unwrap_err()
            .code,
        "INVALID_AUDIT_TRANSITION"
    );
    let audit = reopened
        .history_page(HistoryStream::Audit, filter(None))
        .await
        .unwrap();
    assert_eq!(audit["data"][0]["outcome"], "attempted");
    assert_eq!(audit["data"][0]["resolution"], "unknown");
    assert_eq!(
        reopened
            .history_page(HistoryStream::Audit, filter(audit["nextCursor"].as_str()))
            .await
            .unwrap()["data"][0]["outcome"],
        "succeeded"
    );
    assert_eq!(
        first
            .history_page(HistoryStream::Requests, filter(None))
            .await
            .unwrap_err()
            .code,
        "META_WRITER_CLOSED"
    );
    reopened.close().await.unwrap();
    second.close().await.unwrap();
}

#[tokio::test]
async fn uncertain_audit_intent_returns_no_permit_and_retains_attempt() {
    let metadata = Arc::new(ScopedMetadata::default());
    let workspace = Repository::open(metadata.clone(), "region:test", "workspace-a", true, None)
        .await
        .unwrap();
    metadata
        .fail_after_audit_commit
        .store(true, Ordering::Release);
    let permit = workspace
        .begin_audit_operation(AuditIntent {
            request_id: None,
            actor_kind: ActorKind::Owner,
            actor_id: "owner-a",
            action: AuditAction::FileWrite,
            target_id: None,
        })
        .await;
    assert_eq!(permit.err().unwrap().code, "META_COMMIT_UNKNOWN");
    let page = workspace
        .history_page(
            HistoryStream::Audit,
            HistoryFilter {
                cursor: None,
                limit: 100,
                from: None,
                to: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(page["data"].as_array().unwrap().len(), 1);
    assert_eq!(page["data"][0]["outcome"], "attempted");
    assert_eq!(page["data"][0]["resolution"], "inProgress");
    workspace.close().await.unwrap();
    let reopened = Repository::open(metadata, "region:test", "workspace-a", false, None)
        .await
        .unwrap();
    let recovered = reopened
        .history_page(HistoryStream::Audit, filter(None))
        .await
        .unwrap();
    assert_eq!(recovered["data"][0]["outcome"], "attempted");
    assert_eq!(recovered["data"][0]["resolution"], "unknown");
    assert!(recovered["data"][0].get("writerId").is_none());
    reopened.close().await.unwrap();
}
