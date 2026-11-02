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
    fail_history_registration: AtomicBool,
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
            let is_history_maintenance = scope.family == "history-maintenance";
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
                    if is_history_maintenance
                        && self.fail_history_registration.load(Ordering::Acquire)
                    {
                        return Err(ServiceError::new(503, "META_UNAVAILABLE"));
                    }
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
    assert_eq!(
        first
            .recover_stale_audit_batch(None, 64)
            .await
            .unwrap()
            .resolved,
        0
    );
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
        reopened
            .recover_stale_audit_batch(None, 64)
            .await
            .unwrap()
            .resolved,
        1
    );
    assert_eq!(
        reopened
            .recover_stale_audit_batch(None, 64)
            .await
            .unwrap()
            .resolved,
        0
    );
    assert_eq!(
        reopened
            .history_page(HistoryStream::Audit, filter(None))
            .await
            .unwrap()["data"][0]["outcome"],
        "unknown"
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

#[tokio::test]
async fn history_writes_require_durable_maintenance_registration() {
    let metadata = Arc::new(ScopedMetadata::default());
    let workspace = Repository::open(metadata.clone(), "region:test", "workspace-a", true, None)
        .await
        .unwrap();
    let intent = || AuditIntent {
        request_id: None,
        actor_kind: ActorKind::Owner,
        actor_id: "owner-a",
        action: AuditAction::FileWrite,
        target_id: None,
    };
    metadata
        .fail_history_registration
        .store(true, Ordering::Release);
    assert_eq!(
        workspace
            .begin_audit_operation(intent())
            .await
            .err()
            .unwrap()
            .code,
        "META_UNAVAILABLE"
    );
    assert!(
        workspace
            .history_page(HistoryStream::Audit, filter(None))
            .await
            .unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    metadata
        .fail_history_registration
        .store(false, Ordering::Release);
    let operation = workspace.begin_audit_operation(intent()).await.unwrap();
    workspace
        .finish_audit_operation(operation, AuditOutcome::Succeeded)
        .await
        .unwrap();
    workspace.close().await.unwrap();
    let reopened = Repository::open(metadata.clone(), "region:test", "workspace-a", false, None)
        .await
        .unwrap();
    let second = reopened.begin_audit_operation(intent()).await.unwrap();
    reopened
        .finish_audit_operation(second, AuditOutcome::Succeeded)
        .await
        .unwrap();
    let maintenance = HistoryMaintenance::new(metadata.clone(), "region:test").unwrap();
    let now = chrono::Utc::now().timestamp() as u64 + 1;
    let mut due_job = None;
    let mut due_shard = 0;
    for shard in 0..HistoryMaintenance::shard_count() {
        let page = maintenance.due(shard, now, None, 10).await.unwrap();
        if let Some(job) = page.jobs.into_iter().next() {
            assert!(due_job.is_none());
            assert_eq!(job.workspace_id, "workspace-a");
            due_job = Some(job);
            due_shard = shard;
        }
    }
    let job = due_job.expect("registered maintenance job");
    maintenance.reschedule(&job, now + 100).await.unwrap();
    assert!(
        maintenance
            .due(due_shard, now, None, 10)
            .await
            .unwrap()
            .jobs
            .is_empty()
    );
    assert_eq!(
        maintenance
            .reschedule(&job, now + 101)
            .await
            .unwrap_err()
            .code,
        "META_CONFLICT"
    );
    assert_eq!(
        maintenance
            .due(due_shard, now + 100, None, 10)
            .await
            .unwrap()
            .jobs[0]
            .workspace_id,
        "workspace-a"
    );
    {
        let scopes = metadata.scopes.lock().unwrap();
        let system = scopes
            .iter()
            .filter(|(scope, _)| scope.contains("history-maintenance"))
            .flat_map(|(_, records)| records.keys())
            .collect::<Vec<_>>();
        assert_eq!(
            system.iter().filter(|key| key.starts_with("jobs/")).count(),
            1
        );
        assert_eq!(
            system.iter().filter(|key| key.starts_with("due/")).count(),
            1
        );
    }
    reopened.close().await.unwrap();
}
