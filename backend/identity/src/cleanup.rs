//! Inactive Region-local Guest cleanup queue. This module does not run a scheduler, delete
//! provider resources, or establish that all of a Workspace's resources have been deleted.
//! Only the authenticated regional control workflow may enqueue jobs or acknowledge cleanup.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use uuid::Uuid;
use workspace_contracts::{MetaRequest, Metadata, Result, Scope};

use crate::{
    error, now,
    regional::{OwnerIdentity, Policies, Policy},
};

pub(crate) const SHARDS: u8 = 64;

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Status {
    Scheduled,
    Claimed {
        attempt_id: String,
    },
    Deferred {
        attempt_id: String,
        reason: DeferredReason,
    },
    Complete,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DeferredReason {
    ProviderDeletionUnsupported,
    ProviderOutcomeUncertain,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Job {
    pub workspace_id: String,
    pub guest_id: String,
    pub expires_at: i64,
    pub status: Status,
}

pub struct Page {
    pub jobs: Vec<Job>,
    pub next_cursor: Option<String>,
}

pub struct Queue {
    metadata: Arc<dyn Metadata>,
    policies: Policies,
    authority: String,
}

/// A one-use, internally issued permit for a single provider attempt. It is produced only
/// after the expired Guest job and the resource intent have been durably claimed.
pub struct ResourcePermit {
    authority: String,
    workspace_id: String,
    resource_id: String,
    provider: String,
    target_digest: String,
    expires_at: i64,
    attempt_id: String,
}
impl ResourcePermit {
    pub fn authority(&self) -> &str {
        &self.authority
    }
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }
    pub fn resource_id(&self) -> &str {
        &self.resource_id
    }
    pub fn provider(&self) -> &str {
        &self.provider
    }
    pub fn target_digest(&self) -> &str {
        &self.target_digest
    }
}

/// Fingerprints a private provider target; the raw provider identifier need not be indexed.
pub fn target_digest(provider: &str, target: &str) -> Result<String> {
    if !["db9-anonymous", "drive9-anonymous"].contains(&provider)
        || target.is_empty()
        || target.len() > 256
        || !target
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(error(400, "INVALID_CLEANUP_TARGET"));
    }
    let mut hash = Sha256::new();
    hash.update(b"workspace-cleanup\0target\0v1\0");
    hash.update((provider.len() as u64).to_be_bytes());
    hash.update(provider.as_bytes());
    hash.update((target.len() as u64).to_be_bytes());
    hash.update(target.as_bytes());
    Ok(hex::encode(hash.finalize()))
}

fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

pub(crate) fn shard(workspace: &str) -> Result<u8> {
    if !uuid(workspace) {
        return Err(error(400, "INVALID_CLEANUP_JOB"));
    }
    Ok(Sha256::digest(workspace.as_bytes())[0] % SHARDS)
}

fn key(job: &Job) -> Result<String> {
    if !uuid(&job.workspace_id) || !uuid(&job.guest_id) || job.expires_at < 0 {
        return Err(error(400, "INVALID_CLEANUP_JOB"));
    }
    if let Status::Claimed { attempt_id } = &job.status
        && !uuid(attempt_id)
    {
        return Err(error(400, "INVALID_CLEANUP_JOB"));
    }
    Ok(format!("job/{:020}/{}", job.expires_at, job.workspace_id))
}

impl Queue {
    pub async fn open(metadata: Arc<dyn Metadata>, authority: &str) -> Result<Self> {
        let policies = Policies::open(metadata.clone(), authority).await?;
        Ok(Self {
            metadata,
            policies,
            authority: authority.into(),
        })
    }

    fn scope(&self, shard: u8) -> Result<Scope> {
        if shard >= SHARDS {
            return Err(error(400, "INVALID_CLEANUP_SHARD"));
        }
        Ok(Scope {
            authority_id: self.authority.clone(),
            owner_kind: "system".into(),
            owner_id: "guest-cleanup".into(),
            family: "guest-cleanup".into(),
            partition_id: format!("shard-{shard:02}"),
        })
    }

    async fn stored_policy(&self, job: &Job) -> Result<Policy> {
        let scope = self.policies.scope(&job.workspace_id)?;
        let (policy, _) = self
            .policies
            .read(&scope)
            .await?
            .ok_or_else(|| error(403, "POLICY_NOT_INSTALLED"))?;
        match &policy.identity {
            OwnerIdentity::Guest {
                guest_id,
                expires_at,
                ..
            } if guest_id == &job.guest_id && *expires_at == job.expires_at => Ok(policy),
            _ => Err(error(409, "CLEANUP_OWNER_MISMATCH")),
        }
    }

    async fn record(&self, scope: &Scope, key: &str) -> Result<Option<(Job, String)>> {
        let result = self
            .metadata
            .execute(MetaRequest::Get {
                scope: scope.clone(),
                guard: None,
                keys: vec![key.into()],
            })
            .await?;
        let record = result["records"]
            .get(key)
            .ok_or_else(|| error(503, "CLEANUP_RECORD_CORRUPT"))?;
        if record.is_null() {
            return Ok(None);
        }
        let version = record["version"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| error(503, "CLEANUP_RECORD_CORRUPT"))?;
        let job: Job = serde_json::from_value(record["value"].clone())
            .map_err(|_| error(503, "CLEANUP_RECORD_CORRUPT"))?;
        if self.scope(shard(&job.workspace_id)?)?.partition_id != scope.partition_id
            || self.authority != scope.authority_id
            || crate::cleanup::key(&job)? != key
        {
            return Err(error(503, "CLEANUP_RECORD_CORRUPT"));
        }
        Ok(Some((job, version.into())))
    }

    async fn commit(
        &self,
        scope: &Scope,
        mutation_id: &str,
        key: &str,
        version: Value,
        job: &Job,
    ) -> Result<()> {
        let result = self
            .metadata
            .execute(MetaRequest::Commit {
                scope: scope.clone(),
                guard: None,
                mutation_id: mutation_id.into(),
                changes: vec![json!({"key":key,"expectedVersion":version,"value":job})],
            })
            .await;
        match result {
            Ok(_) => Ok(()),
            Err(e) if e.code == "META_COMMIT_UNKNOWN" => {
                let receipt = self
                    .metadata
                    .execute(MetaRequest::Resolve {
                        scope: scope.clone(),
                        guard: None,
                        mutation_id: mutation_id.into(),
                    })
                    .await;
                if receipt
                    .as_ref()
                    .is_ok_and(|value| value["outcome"] == "committed")
                {
                    Ok(())
                } else {
                    Err(e)
                }
            }
            Err(e) => Err(e),
        }
    }

    /// Must be durably queued before a Guest Workspace becomes ready. The installed Region
    /// policy is authoritative for the owner and expiration; callers cannot select another.
    pub async fn enqueue(&self, policy: &Policy, mutation_id: &str) -> Result<()> {
        if !uuid(mutation_id) {
            return Err(error(400, "INVALID_COMMAND"));
        }
        let (guest_id, expires_at) = match &policy.identity {
            OwnerIdentity::Guest {
                guest_id,
                expires_at,
                ..
            } => (guest_id.clone(), *expires_at),
            _ => return Err(error(400, "INVALID_CLEANUP_JOB")),
        };
        let job = Job {
            workspace_id: policy.workspace_id.clone(),
            guest_id,
            expires_at,
            status: Status::Scheduled,
        };
        if &self.stored_policy(&job).await? != policy {
            return Err(error(409, "CLEANUP_POLICY_MISMATCH"));
        }
        let scope = self.scope(shard(&job.workspace_id)?)?;
        let key = key(&job)?;
        if let Some((old, _)) = self.record(&scope, &key).await? {
            if old.workspace_id == job.workspace_id
                && old.guest_id == job.guest_id
                && old.expires_at == job.expires_at
            {
                return Ok(());
            }
            return Err(error(409, "CLEANUP_OWNER_MISMATCH"));
        }
        match self
            .commit(&scope, mutation_id, &key, Value::Null, &job)
            .await
        {
            Err(e) if e.code == "META_CONFLICT" => {
                let current = self
                    .record(&scope, &key)
                    .await?
                    .ok_or_else(|| error(503, "CLEANUP_CONFLICT_UNRESOLVED"))?
                    .0;
                if current.workspace_id == job.workspace_id
                    && current.guest_id == job.guest_id
                    && current.expires_at == job.expires_at
                {
                    Ok(())
                } else {
                    Err(error(409, "CLEANUP_OWNER_MISMATCH"))
                }
            }
            other => other,
        }
    }

    /// Bounded, ordered regional index. An executor must periodically scan all 64 shards,
    /// follow the cursor and wrap, including after restart; this method starts no executor.
    pub async fn due(&self, partition: u8, after: Option<String>, limit: usize) -> Result<Page> {
        self.due_at(partition, after, limit, now()?).await
    }

    async fn due_at(
        &self,
        partition: u8,
        after: Option<String>,
        limit: usize,
        current: i64,
    ) -> Result<Page> {
        if limit == 0 || limit > 512 {
            return Err(error(400, "INVALID_CLEANUP_LIMIT"));
        }
        let scope = self.scope(partition)?;
        let result = self
            .metadata
            .execute(MetaRequest::List {
                scope,
                guard: None,
                prefix: "job/".into(),
                after,
                limit,
            })
            .await?;
        let entries = result["records"]
            .as_array()
            .ok_or_else(|| error(503, "CLEANUP_RECORD_CORRUPT"))?;
        let mut jobs = Vec::new();
        let mut hit_future = false;
        for entry in entries {
            let stored_key = entry["key"]
                .as_str()
                .ok_or_else(|| error(503, "CLEANUP_RECORD_CORRUPT"))?;
            let job: Job = serde_json::from_value(entry["value"].clone())
                .map_err(|_| error(503, "CLEANUP_RECORD_CORRUPT"))?;
            if key(&job)? != stored_key || shard(&job.workspace_id)? != partition {
                return Err(error(503, "CLEANUP_RECORD_CORRUPT"));
            }
            if job.expires_at > current {
                hit_future = true;
                break;
            }
            jobs.push(job);
        }
        let next_cursor = if hit_future || result["nextCursor"].is_null() {
            None
        } else {
            Some(
                result["nextCursor"]
                    .as_str()
                    .ok_or_else(|| error(503, "CLEANUP_RECORD_CORRUPT"))?
                    .to_owned(),
            )
        };
        Ok(Page { jobs, next_cursor })
    }

    /// Exactly one new claim may be returned. A previously claimed job cannot be reclaimed
    /// automatically: the executor must reconcile provider effects and fence the old actor.
    pub async fn claim(&self, job: &Job, attempt_id: &str) -> Result<Job> {
        self.claim_at(job, attempt_id, now()?).await
    }

    async fn claim_at(&self, job: &Job, attempt_id: &str, current: i64) -> Result<Job> {
        if !uuid(attempt_id) {
            return Err(error(400, "INVALID_COMMAND"));
        }
        let scope = self.scope(shard(&job.workspace_id)?)?;
        let key = key(job)?;
        let (mut stored, version) = self
            .record(&scope, &key)
            .await?
            .ok_or_else(|| error(404, "CLEANUP_NOT_FOUND"))?;
        self.stored_policy(&stored).await?;
        if current < stored.expires_at {
            return Err(error(409, "GUEST_NOT_EXPIRED"));
        }
        if stored.status != Status::Scheduled {
            return Err(error(409, "CLEANUP_REQUIRES_RECONCILIATION"));
        }
        stored.status = Status::Claimed {
            attempt_id: attempt_id.into(),
        };
        self.commit(&scope, attempt_id, &key, Value::String(version), &stored)
            .await?;
        Ok(stored)
    }

    /// Call only after a trusted executor has verified deletion of every resource and fenced
    /// in-flight effects. Provider verification and cleanup are intentionally not implemented.
    pub async fn complete_verified(
        &self,
        job: &Job,
        attempt_id: &str,
        mutation_id: &str,
    ) -> Result<()> {
        if !uuid(attempt_id) || !uuid(mutation_id) {
            return Err(error(400, "INVALID_COMMAND"));
        }
        let scope = self.scope(shard(&job.workspace_id)?)?;
        let key = key(job)?;
        let (mut stored, version) = self
            .record(&scope, &key)
            .await?
            .ok_or_else(|| error(404, "CLEANUP_NOT_FOUND"))?;
        self.stored_policy(&stored).await?;
        if stored.status == Status::Complete {
            return Ok(());
        }
        if stored.status
            != (Status::Claimed {
                attempt_id: attempt_id.into(),
            })
        {
            return Err(error(409, "CLEANUP_ATTEMPT_MISMATCH"));
        }
        stored.status = Status::Complete;
        self.commit(&scope, mutation_id, &key, Value::String(version), &stored)
            .await
    }

    /// Retain a claimed job when a provider cannot delete or its outcome is uncertain. This
    /// never removes metadata, credentials or resources, and is not evidence of deletion.
    /// The executor must first fence and drain any in-flight effects for this job.
    pub async fn defer(
        &self,
        job: &Job,
        attempt_id: &str,
        reason: DeferredReason,
        mutation_id: &str,
    ) -> Result<()> {
        if !uuid(attempt_id) || !uuid(mutation_id) {
            return Err(error(400, "INVALID_COMMAND"));
        }
        let scope = self.scope(shard(&job.workspace_id)?)?;
        let key = key(job)?;
        let (mut stored, version) = self
            .record(&scope, &key)
            .await?
            .ok_or_else(|| error(404, "CLEANUP_NOT_FOUND"))?;
        self.stored_policy(&stored).await?;
        let deferred = Status::Deferred {
            attempt_id: attempt_id.into(),
            reason,
        };
        if stored.status == deferred {
            return Ok(());
        }
        if stored.status
            != (Status::Claimed {
                attempt_id: attempt_id.into(),
            })
        {
            return Err(error(409, "CLEANUP_ATTEMPT_MISMATCH"));
        }
        stored.status = deferred;
        self.commit(&scope, mutation_id, &key, Value::String(version), &stored)
            .await
    }

    /// Journal one resource effect before provider I/O. Existing or uncertain effects are
    /// never reissued automatically; a separate provider-specific reconciliation is required.
    /// The provider adapter must independently match the permit to the scoped Workspace
    /// resource, its private binding, and the exact target fingerprint before deleting.
    pub async fn begin_resource(
        &self,
        job: &Job,
        attempt_id: &str,
        resource_id: &str,
        provider: &str,
        target: &str,
        mutation_id: &str,
    ) -> Result<ResourcePermit> {
        if !uuid(attempt_id)
            || !uuid(mutation_id)
            || resource_id.is_empty()
            || resource_id.len() > 128
            || !resource_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err(error(400, "INVALID_CLEANUP_TARGET"));
        }
        let scope = self.scope(shard(&job.workspace_id)?)?;
        let job_key = key(job)?;
        let (stored, _) = self
            .record(&scope, &job_key)
            .await?
            .ok_or_else(|| error(404, "CLEANUP_NOT_FOUND"))?;
        self.stored_policy(&stored).await?;
        if now()? < stored.expires_at {
            return Err(error(409, "GUEST_NOT_EXPIRED"));
        }
        if stored.status
            != (Status::Claimed {
                attempt_id: attempt_id.into(),
            })
        {
            return Err(error(409, "CLEANUP_ATTEMPT_MISMATCH"));
        }
        let target_digest = target_digest(provider, target)?;
        let effect_key = format!(
            "effect/{:020}/{}/{resource_id}",
            stored.expires_at, stored.workspace_id
        );
        let existing = self
            .metadata
            .execute(MetaRequest::Get {
                scope: scope.clone(),
                guard: None,
                keys: vec![effect_key.clone()],
            })
            .await?;
        if !existing["records"]
            .get(&effect_key)
            .ok_or_else(|| error(503, "CLEANUP_RECORD_CORRUPT"))?
            .is_null()
        {
            return Err(error(409, "CLEANUP_EFFECT_REQUIRES_RECONCILIATION"));
        }
        let effect = json!({"workspaceId":stored.workspace_id,"resourceId":resource_id,"provider":provider,
            "targetDigest":target_digest,"jobAttemptId":attempt_id,"state":"requested"});
        let result = self
            .metadata
            .execute(MetaRequest::Commit {
                scope: scope.clone(),
                guard: None,
                mutation_id: mutation_id.into(),
                changes: vec![json!({"key":effect_key,"expectedVersion":null,"value":effect})],
            })
            .await;
        match result {
            Ok(_) => {}
            Err(e) if e.code == "META_CONFLICT" || e.code == "META_MUTATION_MISMATCH" => {
                return Err(error(409, "CLEANUP_EFFECT_REQUIRES_RECONCILIATION"));
            }
            Err(e) if e.code == "META_COMMIT_UNKNOWN" => {
                let receipt = self
                    .metadata
                    .execute(MetaRequest::Resolve {
                        scope,
                        guard: None,
                        mutation_id: mutation_id.into(),
                    })
                    .await;
                if !receipt
                    .as_ref()
                    .is_ok_and(|value| value["outcome"] == "committed")
                {
                    return Err(e);
                }
            }
            Err(e) => return Err(e),
        }
        Ok(ResourcePermit {
            authority: self.authority.clone(),
            workspace_id: stored.workspace_id,
            resource_id: resource_id.into(),
            provider: provider.into(),
            target_digest,
            expires_at: stored.expires_at,
            attempt_id: attempt_id.into(),
        })
    }

    /// Recheck the persisted claim, owner policy and effect immediately before provider I/O.
    /// The executor must additionally serialize completion and drain in-flight work.
    pub async fn validate_permit(&self, permit: &ResourcePermit) -> Result<()> {
        if permit.authority != self.authority {
            return Err(error(403, "CLEANUP_SCOPE_MISMATCH"));
        }
        let scope = self.scope(shard(&permit.workspace_id)?)?;
        let job_key = format!("job/{:020}/{}", permit.expires_at, permit.workspace_id);
        let (stored, _) = self
            .record(&scope, &job_key)
            .await?
            .ok_or_else(|| error(404, "CLEANUP_NOT_FOUND"))?;
        self.stored_policy(&stored).await?;
        if now()? < stored.expires_at
            || stored.status
                != (Status::Claimed {
                    attempt_id: permit.attempt_id.clone(),
                })
        {
            return Err(error(409, "CLEANUP_ATTEMPT_MISMATCH"));
        }
        let effect_key = format!(
            "effect/{:020}/{}/{}",
            permit.expires_at, permit.workspace_id, permit.resource_id
        );
        let result = self
            .metadata
            .execute(MetaRequest::Get {
                scope,
                guard: None,
                keys: vec![effect_key.clone()],
            })
            .await?;
        let effect = &result["records"][&effect_key]["value"];
        if effect
            != &json!({"workspaceId":permit.workspace_id,"resourceId":permit.resource_id,"provider":permit.provider,
            "targetDigest":permit.target_digest,"jobAttemptId":permit.attempt_id,"state":"requested"})
        {
            return Err(error(409, "CLEANUP_EFFECT_MISMATCH"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{regional::OwnerIdentity, tests::MemoryMeta};
    use std::sync::atomic::Ordering;

    fn guest_policy(workspace: String, expires_at: i64) -> Policy {
        Policy {
            workspace_id: workspace,
            organization_id: Uuid::new_v4().to_string(),
            user_id: Uuid::new_v4().to_string(),
            region_id: "region:a".into(),
            generation: 1,
            denied: false,
            identity: OwnerIdentity::Guest {
                guest_id: Uuid::new_v4().to_string(),
                verifier: hex::encode([9u8; 32]),
                created_at: expires_at - 86_400,
                expires_at,
            },
        }
    }
    fn metadata() -> Arc<MemoryMeta> {
        Arc::new(MemoryMeta {
            authority: Some("region:a".into()),
            ..Default::default()
        })
    }

    #[tokio::test]
    async fn cleanup_is_due_only_after_expiry_and_cannot_be_claimed_twice() {
        let metadata = metadata();
        let queue = Queue::open(metadata.clone(), "region:a").await.unwrap();
        let policy = guest_policy(Uuid::new_v4().to_string(), 86_500);
        queue
            .policies
            .install(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        queue
            .enqueue(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        queue
            .enqueue(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        let bucket = shard(&policy.workspace_id).unwrap();
        assert!(
            queue
                .due_at(bucket, None, 10, 86_499)
                .await
                .unwrap()
                .jobs
                .is_empty()
        );
        let due = queue.due_at(bucket, None, 10, 86_500).await.unwrap().jobs;
        assert_eq!(due.len(), 1);
        let attempt = Uuid::new_v4().to_string();
        assert_eq!(
            queue
                .claim_at(&due[0], &attempt, 86_499)
                .await
                .err()
                .unwrap()
                .code,
            "GUEST_NOT_EXPIRED"
        );
        let claimed = queue.claim_at(&due[0], &attempt, 86_500).await.unwrap();
        let restarted = Queue::open(metadata, "region:a").await.unwrap();
        assert_eq!(
            restarted
                .claim_at(&due[0], &attempt, 86_501)
                .await
                .err()
                .unwrap()
                .code,
            "CLEANUP_REQUIRES_RECONCILIATION"
        );
        assert_eq!(
            restarted
                .complete_verified(
                    &claimed,
                    &Uuid::new_v4().to_string(),
                    &Uuid::new_v4().to_string()
                )
                .await
                .err()
                .unwrap()
                .code,
            "CLEANUP_ATTEMPT_MISMATCH"
        );
        restarted
            .complete_verified(&claimed, &attempt, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        assert!(matches!(
            restarted
                .due_at(bucket, None, 10, 86_501)
                .await
                .unwrap()
                .jobs[0]
                .status,
            Status::Complete
        ));
    }

    #[tokio::test]
    async fn unknown_claim_is_never_automatically_replayed() {
        let metadata = metadata();
        let queue = Queue::open(metadata.clone(), "region:a").await.unwrap();
        let policy = guest_policy(Uuid::new_v4().to_string(), 86_500);
        queue
            .policies
            .install(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        queue
            .enqueue(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        let job = queue
            .due_at(shard(&policy.workspace_id).unwrap(), None, 10, 86_500)
            .await
            .unwrap()
            .jobs
            .remove(0);
        metadata.lose_reply.store(true, Ordering::SeqCst);
        let attempt = Uuid::new_v4().to_string();
        assert_eq!(
            queue
                .claim_at(&job, &attempt, 86_500)
                .await
                .err()
                .unwrap()
                .code,
            "META_COMMIT_UNKNOWN"
        );
        assert_eq!(
            queue
                .claim_at(&job, &Uuid::new_v4().to_string(), 86_501)
                .await
                .err()
                .unwrap()
                .code,
            "CLEANUP_REQUIRES_RECONCILIATION"
        );
    }

    #[tokio::test]
    async fn unsupported_deletion_remains_pending_and_cannot_be_completed_or_reissued() {
        let metadata = metadata();
        let queue = Queue::open(metadata.clone(), "region:a").await.unwrap();
        let expires_at = now().unwrap() - 1;
        let policy = guest_policy(Uuid::new_v4().to_string(), expires_at);
        queue
            .policies
            .install(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        queue
            .enqueue(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        let partition = shard(&policy.workspace_id).unwrap();
        let job = queue.due(partition, None, 10).await.unwrap().jobs.remove(0);
        let attempt = Uuid::new_v4().to_string();
        let claimed = queue.claim(&job, &attempt).await.unwrap();
        assert_eq!(
            queue
                .defer(
                    &claimed,
                    &Uuid::new_v4().to_string(),
                    DeferredReason::ProviderDeletionUnsupported,
                    &Uuid::new_v4().to_string()
                )
                .await
                .err()
                .unwrap()
                .code,
            "CLEANUP_ATTEMPT_MISMATCH"
        );
        queue
            .defer(
                &claimed,
                &attempt,
                DeferredReason::ProviderDeletionUnsupported,
                &Uuid::new_v4().to_string(),
            )
            .await
            .unwrap();
        let restarted = Queue::open(metadata, "region:a").await.unwrap();
        let deferred = restarted
            .due(partition, None, 10)
            .await
            .unwrap()
            .jobs
            .remove(0);
        assert!(matches!(
            deferred.status,
            Status::Deferred {
                reason: DeferredReason::ProviderDeletionUnsupported,
                ..
            }
        ));
        assert_eq!(
            restarted
                .complete_verified(&deferred, &attempt, &Uuid::new_v4().to_string())
                .await
                .err()
                .unwrap()
                .code,
            "CLEANUP_ATTEMPT_MISMATCH"
        );
        assert_eq!(
            restarted
                .claim(&deferred, &Uuid::new_v4().to_string())
                .await
                .err()
                .unwrap()
                .code,
            "CLEANUP_REQUIRES_RECONCILIATION"
        );
        assert_eq!(
            restarted
                .begin_resource(
                    &deferred,
                    &attempt,
                    "resource",
                    "db9-anonymous",
                    "db_123",
                    &Uuid::new_v4().to_string()
                )
                .await
                .err()
                .unwrap()
                .code,
            "CLEANUP_ATTEMPT_MISMATCH"
        );
    }

    #[tokio::test]
    async fn resource_attempt_is_bound_to_expired_owner_and_cannot_be_reissued() {
        let metadata = metadata();
        let queue = Queue::open(metadata, "region:a").await.unwrap();
        let expiry = now().unwrap() - 1;
        let policy = guest_policy(Uuid::new_v4().to_string(), expiry);
        queue
            .policies
            .install(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        queue
            .enqueue(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        let job = queue
            .due_at(shard(&policy.workspace_id).unwrap(), None, 10, expiry)
            .await
            .unwrap()
            .jobs
            .remove(0);
        let attempt = Uuid::new_v4().to_string();
        let claimed = queue.claim_at(&job, &attempt, expiry).await.unwrap();
        assert_eq!(
            queue
                .begin_resource(
                    &claimed,
                    &Uuid::new_v4().to_string(),
                    "resource_one",
                    "db9-anonymous",
                    "db_123",
                    &Uuid::new_v4().to_string()
                )
                .await
                .err()
                .unwrap()
                .code,
            "CLEANUP_ATTEMPT_MISMATCH"
        );
        assert_eq!(
            queue
                .begin_resource(
                    &claimed,
                    &attempt,
                    "../other",
                    "db9-anonymous",
                    "db_123",
                    &Uuid::new_v4().to_string()
                )
                .await
                .err()
                .unwrap()
                .code,
            "INVALID_CLEANUP_TARGET"
        );
        let permit = queue
            .begin_resource(
                &claimed,
                &attempt,
                "resource_one",
                "db9-anonymous",
                "db_123",
                &Uuid::new_v4().to_string(),
            )
            .await
            .unwrap();
        assert_eq!(permit.authority(), "region:a");
        assert_eq!(permit.workspace_id(), policy.workspace_id);
        assert_eq!(permit.resource_id(), "resource_one");
        assert_eq!(
            permit.target_digest(),
            target_digest("db9-anonymous", "db_123").unwrap()
        );
        assert_eq!(
            queue
                .begin_resource(
                    &claimed,
                    &attempt,
                    "resource_one",
                    "db9-anonymous",
                    "db_123",
                    &Uuid::new_v4().to_string()
                )
                .await
                .err()
                .unwrap()
                .code,
            "CLEANUP_EFFECT_REQUIRES_RECONCILIATION"
        );
    }

    #[tokio::test]
    async fn cleanup_refuses_a_different_guest_or_uninstalled_policy() {
        let queue = Queue::open(metadata(), "region:a").await.unwrap();
        let policy = guest_policy(Uuid::new_v4().to_string(), 86_500);
        assert_eq!(
            queue
                .enqueue(&policy, &Uuid::new_v4().to_string())
                .await
                .err()
                .unwrap()
                .code,
            "POLICY_NOT_INSTALLED"
        );
        queue
            .policies
            .install(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        let mut other = policy.clone();
        if let OwnerIdentity::Guest { guest_id, .. } = &mut other.identity {
            *guest_id = Uuid::new_v4().to_string();
        }
        assert_eq!(
            queue
                .enqueue(&other, &Uuid::new_v4().to_string())
                .await
                .err()
                .unwrap()
                .code,
            "CLEANUP_OWNER_MISMATCH"
        );
    }

    #[tokio::test]
    async fn cleanup_scan_is_ordered_bounded_and_stops_at_future_jobs() {
        let queue = Queue::open(metadata(), "region:a").await.unwrap();
        let workspace = Uuid::new_v4().to_string();
        let target_shard = shard(&workspace).unwrap();
        let another = loop {
            let id = Uuid::new_v4().to_string();
            if shard(&id).unwrap() == target_shard {
                break id;
            }
        };
        let due = guest_policy(workspace, 86_500);
        let future = guest_policy(another, 87_500);
        for policy in [&due, &future] {
            queue
                .policies
                .install(policy, &Uuid::new_v4().to_string())
                .await
                .unwrap();
            queue
                .enqueue(policy, &Uuid::new_v4().to_string())
                .await
                .unwrap();
        }
        let first = queue.due_at(target_shard, None, 1, 86_500).await.unwrap();
        assert_eq!(first.jobs.len(), 1);
        assert_eq!(first.jobs[0].workspace_id, due.workspace_id);
        let second = queue
            .due_at(target_shard, first.next_cursor, 1, 86_500)
            .await
            .unwrap();
        assert!(second.jobs.is_empty());
        assert!(second.next_cursor.is_none());
    }
}
