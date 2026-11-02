//! Multi-Workspace and reopen checks for the inactive history storage boundary.
use crate::{Credential, Principal, Repository, ScopedAuthorization, Workspace, observability::*};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
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
    revoke_on_history_read: Mutex<Option<Arc<AtomicBool>>>,
}

struct HistoryKey;

#[tokio::test]
async fn cancelled_audit_guard_records_unknown_without_replaying_the_effect() {
    let metadata = Arc::new(ScopedMetadata::default());
    let repository = Arc::new(
        Repository::open(metadata, "region:test", "workspace-a", true, None)
            .await
            .unwrap(),
    );
    let intent = || AuditIntent {
        request_id: Some(Uuid::new_v4()),
        actor_kind: ActorKind::Owner,
        actor_id: "owner-a",
        action: AuditAction::FileWrite,
        target_id: None,
    };
    let guard = AuditGuard::begin(repository.clone(), intent())
        .await
        .unwrap();
    drop(guard);
    let page = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let page = repository
                .history_page(
                    HistoryStream::Audit,
                    HistoryFilter {
                        cursor: None,
                        limit: 20,
                        from: None,
                        to: None,
                    },
                )
                .await
                .unwrap();
            if page["data"]
                .as_array()
                .unwrap()
                .iter()
                .any(|record| record["outcome"] == "unknown")
            {
                break page;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cancelled audit transition");
    let records = page["data"].as_array().unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["outcome"], "unknown");
    assert_eq!(records[0]["decision"], "unknown");
    assert_eq!(records[1]["outcome"], "attempted");
    assert_eq!(records[0]["operationId"], records[1]["operationId"]);
    assert_eq!(records[1]["resolution"], "unknown");
    let guard = AuditGuard::begin(repository.clone(), intent())
        .await
        .unwrap();
    guard
        .finish_with_target(AuditOutcome::Succeeded, Some("fs_1"))
        .await
        .unwrap();
    let page = repository
        .history_page(
            HistoryStream::Audit,
            HistoryFilter {
                cursor: None,
                limit: 20,
                from: None,
                to: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(page["data"].as_array().unwrap().len(), 4);
    assert_eq!(page["data"][0]["outcome"], "succeeded");
    assert_eq!(page["data"][0]["decision"], "allowed");
    assert_eq!(
        page["data"][0]["target"],
        json!({"type":"filesystem", "id":"fs_1"})
    );
    repository.close().await.unwrap();
}
impl ScopedAuthorization for HistoryKey {
    fn workspace_id(&self) -> &str {
        "workspace-a"
    }
    fn workspace_key_id(&self) -> Option<&str> {
        Some("verified-key-id")
    }
    fn snapshot(&self) -> workspace_contracts::Result<Principal> {
        Ok(Principal {
            owner: false,
            actor: "Key".into(),
            id: "separate-principal-id".into(),
            scopes: vec!["*".into()],
            resource_ids: vec!["*".into()],
            expires_at: None,
        })
    }
    fn check(
        &self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = workspace_contracts::Result<Principal>> + Send + '_>,
    > {
        Box::pin(async { self.snapshot() })
    }
}

#[tokio::test]
async fn owner_history_denies_keys_cross_workspace_and_revocation_during_read() {
    let metadata = Arc::new(ScopedMetadata::default());
    let repository = Repository::open(metadata.clone(), "region:test", "workspace-a", true, None)
        .await
        .unwrap();
    let operation = repository
        .begin_audit_operation(AuditIntent {
            request_id: None,
            actor_kind: ActorKind::Owner,
            actor_id: "owner-a",
            action: AuditAction::ResourceCreate,
            target_id: None,
        })
        .await
        .unwrap();
    repository
        .finish_audit_operation(operation, AuditOutcome::Succeeded)
        .await
        .unwrap();
    let workspace = Workspace::new(repository);
    let revoked = Arc::new(AtomicBool::new(false));
    let owner = Credential::SessionOwner {
        id: "owner-a".into(),
        actor: "Owner".into(),
        workspace_id: "workspace-a".into(),
        policy_generation: None,
        expires_at: chrono::Utc::now().timestamp() + 3600,
        revoked: revoked.clone(),
    };
    let other = Credential::SessionOwner {
        id: "owner-b".into(),
        actor: "Owner".into(),
        workspace_id: "workspace-b".into(),
        policy_generation: None,
        expires_at: chrono::Utc::now().timestamp() + 3600,
        revoked: Arc::new(AtomicBool::new(false)),
    };
    let expired = Credential::SessionOwner {
        id: "owner-a".into(),
        actor: "Owner".into(),
        workspace_id: "workspace-a".into(),
        policy_generation: None,
        expires_at: chrono::Utc::now().timestamp() - 1,
        revoked: Arc::new(AtomicBool::new(false)),
    };
    let filter = || HistoryFilter {
        cursor: None,
        limit: 10,
        from: None,
        to: None,
    };
    let actor = workspace
        .history_actor(&Credential::Scoped(Arc::new(HistoryKey)))
        .await
        .unwrap();
    assert!(matches!(actor.kind, ActorKind::WorkspaceKey));
    assert_eq!(actor.id, "verified-key-id");
    let actor = workspace
        .history_actor_snapshot(&Credential::Scoped(Arc::new(HistoryKey)))
        .unwrap();
    assert_eq!(actor.id, "verified-key-id");
    assert_eq!(
        workspace
            .history_actor_snapshot(&Credential::Bearer("never-persist-this-token".into()))
            .err()
            .unwrap()
            .code,
        "HISTORY_ACTOR_UNAVAILABLE"
    );
    assert_eq!(
        workspace
            .history_actor_snapshot(&expired)
            .err()
            .unwrap()
            .code,
        "UNAUTHENTICATED"
    );
    let actor = workspace.history_actor(&owner).await.unwrap();
    assert!(matches!(actor.kind, ActorKind::Owner));
    assert_eq!(actor.id, "owner-a");
    assert_eq!(
        workspace
            .owner_history_page(&owner, HistoryStream::Audit, filter())
            .await
            .unwrap()["data"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        workspace
            .owner_history_page(
                &Credential::Scoped(Arc::new(HistoryKey)),
                HistoryStream::Audit,
                filter()
            )
            .await
            .unwrap_err()
            .code,
        "OWNER_REQUIRED"
    );
    assert_eq!(
        workspace
            .owner_history_page(&other, HistoryStream::Audit, filter())
            .await
            .unwrap_err()
            .code,
        "UNAUTHENTICATED"
    );
    assert_eq!(
        workspace
            .owner_history_page(&expired, HistoryStream::Audit, filter())
            .await
            .unwrap_err()
            .code,
        "UNAUTHENTICATED"
    );
    *metadata.revoke_on_history_read.lock().unwrap() = Some(revoked);
    assert_eq!(
        workspace
            .owner_history_page(&owner, HistoryStream::Audit, filter())
            .await
            .unwrap_err()
            .code,
        "UNAUTHENTICATED"
    );
    workspace.close().await.unwrap();
}

#[derive(Default)]
struct MaintenanceRecorder(Mutex<Vec<String>>);
impl HistoryMaintenanceProcessor for MaintenanceRecorder {
    fn process<'a>(
        &'a self,
        workspace: &'a str,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = workspace_contracts::Result<HistoryScheduleOutcome>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.0.lock().unwrap().push(workspace.to_owned());
            Ok(HistoryScheduleOutcome::Complete)
        })
    }
}

#[derive(Default)]
struct FailFirstMaintenance(Mutex<Vec<String>>);
impl HistoryMaintenanceProcessor for FailFirstMaintenance {
    fn process<'a>(
        &'a self,
        workspace: &'a str,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = workspace_contracts::Result<HistoryScheduleOutcome>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            let mut seen = self.0.lock().unwrap();
            seen.push(workspace.to_owned());
            if seen.len() == 1 {
                Err(ServiceError::new(503, "TEST_UNAVAILABLE"))
            } else {
                Ok(HistoryScheduleOutcome::Complete)
            }
        })
    }
}

#[tokio::test]
async fn unavailable_workspace_does_not_starve_other_history_cleanup() {
    let mut shards = BTreeMap::new();
    let (first, second) = (0..1000)
        .find_map(|index| {
            let id = format!("workspace-{index}");
            let shard = Sha256::digest(id.as_bytes())[0] % HistoryMaintenance::shard_count();
            shards
                .insert(shard, id.clone())
                .map(|previous| (previous, id))
        })
        .expect("two Workspaces in one shard");
    let metadata = Arc::new(ScopedMetadata::default());
    for id in [&first, &second] {
        let workspace = Repository::open(metadata.clone(), "region:test", id, true, None)
            .await
            .unwrap();
        let operation = workspace
            .begin_audit_operation(AuditIntent {
                request_id: None,
                actor_kind: ActorKind::Owner,
                actor_id: "owner",
                action: AuditAction::ResourceCreate,
                target_id: None,
            })
            .await
            .unwrap();
        workspace
            .finish_audit_operation(operation, AuditOutcome::Succeeded)
            .await
            .unwrap();
        workspace.close().await.unwrap();
    }
    let processor = Arc::new(FailFirstMaintenance::default());
    let queue = HistoryMaintenance::new(metadata.clone(), "region:test").unwrap();
    let mut scheduler = HistoryScheduler::new(queue, processor.clone());
    let mut delayed = 0;
    let now = chrono::Utc::now().timestamp() as u64 + 2;
    for _ in 0..HistoryMaintenance::shard_count() {
        if let Err(error) = scheduler.tick_at(now).await {
            assert_eq!(error.code, "HISTORY_MAINTENANCE_DELAYED");
            delayed += 1;
        }
    }
    assert_eq!(delayed, 1);
    let seen = processor.0.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    assert!(seen.contains(&first));
    assert!(seen.contains(&second));
    let shard = Sha256::digest(first.as_bytes())[0] % HistoryMaintenance::shard_count();
    let queue = HistoryMaintenance::new(metadata, "region:test").unwrap();
    let retry = queue.due(shard, now + 5, None, 10).await.unwrap();
    assert_eq!(retry.jobs.len(), 1);
    assert_eq!(retry.jobs[0].workspace_id, seen[0]);
}

impl Metadata for ScopedMetadata {
    fn health(&self) -> Call<'_> {
        Box::pin(async { Ok(json!({"authorityId":"region:test","capabilities":["recordsV1"]})) })
    }
    fn execute(&self, request: MetaRequest) -> Call<'_> {
        Box::pin(async move {
            if matches!(&request, MetaRequest::List { prefix, .. } if prefix == "observability/audit-v1/records/")
                && let Some(revoked) = self.revoke_on_history_read.lock().unwrap().as_ref()
            {
                revoked.store(true, Ordering::Release);
            }
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
    let request_start = page["coverageStartedAt"].as_str().unwrap().to_owned();
    let audit_start = first
        .history_page(HistoryStream::Audit, filter(None))
        .await
        .unwrap()["coverageStartedAt"]
        .as_str()
        .unwrap()
        .to_owned();
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
            .history_page(HistoryStream::Requests, filter(None))
            .await
            .unwrap()["coverageStartedAt"],
        request_start
    );
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
    assert_eq!(audit["coverageStartedAt"], audit_start);
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
    let recorder = Arc::new(MaintenanceRecorder::default());
    let mut scheduler = HistoryScheduler::new(maintenance, recorder.clone());
    for _ in 0..HistoryMaintenance::shard_count() {
        scheduler.tick_at(now + 100).await.unwrap();
    }
    assert_eq!(*recorder.0.lock().unwrap(), vec!["workspace-a"]);
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
