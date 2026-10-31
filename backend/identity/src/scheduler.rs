//! Bounded Region-local Guest logout and expiry scheduling. Processors must fence effects and
//! preserve unconfirmed outcomes for provider-specific reconciliation.

use std::{future::Future, pin::Pin, sync::Arc, time::Duration};
use tokio::sync::watch;
use uuid::Uuid;
use workspace_contracts::Result;

use crate::cleanup::{DeferredReason, Job, Queue, SHARDS, Status};

pub enum Outcome {
    /// The processor has confirmed that every owned cloud resource was deleted or expired,
    /// and has fenced all in-flight work. Acceptance of a deletion request is not sufficient.
    VerifiedComplete,
    Deferred(DeferredReason),
    /// No provider effects were started; release this claim for a later retry.
    RetryWithoutEffects,
}

/// A trusted Region-only processor. It must drain/fence work before effects and before
/// returning; it must never blindly repeat an unknown provider effect. The scheduler does
/// not itself inspect inventories, delete resources, or verify a provider's response.
pub trait Processor: Send + Sync {
    fn process<'a>(
        &'a self,
        job: &'a Job,
        attempt_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Outcome>> + Send + 'a>>;
}

/// Retains expired Guest resources and credentials without contacting a provider.
/// Expiry authorization is enforced independently by the regional owner policy.
pub struct DeferProviderCleanup;
impl Processor for DeferProviderCleanup {
    fn process<'a>(
        &'a self,
        _job: &'a Job,
        _attempt_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Outcome>> + Send + 'a>> {
        Box::pin(async { Ok(Outcome::Deferred(DeferredReason::ProviderCleanupDeferred)) })
    }
}

pub struct Scheduler {
    queue: Arc<Queue>,
    processor: Arc<dyn Processor>,
    cursors: Vec<Option<String>>,
    logout_cursors: Vec<Option<String>>,
    partition: u8,
    page_size: usize,
}

/// Claim and process a single eligible job. Competing periodic and immediate scans share
/// the same durable claim, so at most one can issue provider effects.
pub async fn process_one(queue: &Queue, processor: &dyn Processor, job: &Job) -> Result<()> {
    if job.status != Status::Scheduled {
        return Ok(());
    }
    let attempt = Uuid::new_v4().to_string();
    let claimed = match queue.claim(job, &attempt).await {
        Ok(job) => job,
        Err(e) if e.code == "CLEANUP_REQUIRES_RECONCILIATION" || e.code == "META_CONFLICT" => {
            return Ok(());
        }
        Err(e) => return Err(e),
    };
    let outcome = processor
        .process(&claimed, &attempt)
        .await
        .unwrap_or(Outcome::Deferred(DeferredReason::ProviderOutcomeUncertain));
    match outcome {
        Outcome::VerifiedComplete => {
            queue
                .complete_verified(&claimed, &attempt, &Uuid::new_v4().to_string())
                .await?;
            queue.clear_requested(&claimed).await?
        }
        Outcome::Deferred(reason) => {
            queue
                .defer(&claimed, &attempt, reason, &Uuid::new_v4().to_string())
                .await?;
            queue.clear_requested(&claimed).await?
        }
        Outcome::RetryWithoutEffects => {
            queue
                .retry_without_effects(&claimed, &attempt, &Uuid::new_v4().to_string())
                .await?
        }
    }
    Ok(())
}

impl Scheduler {
    pub fn new(queue: Arc<Queue>, processor: Arc<dyn Processor>, page_size: usize) -> Result<Self> {
        if page_size == 0 || page_size > 512 {
            return Err(crate::error(400, "INVALID_CLEANUP_LIMIT"));
        }
        Ok(Self {
            queue,
            processor,
            cursors: vec![None; usize::from(SHARDS)],
            logout_cursors: vec![None; usize::from(SHARDS)],
            partition: 0,
            page_size,
        })
    }

    /// Scan at most one bounded page, then rotate partitions. Claimed and deferred jobs
    /// remain visible for fenced reconciliation and are never automatically reissued.
    pub async fn tick(&mut self) -> Result<()> {
        let partition = self.partition;
        self.partition = (self.partition + 1) % SHARDS;
        let index = usize::from(partition);
        let page = self
            .queue
            .due(partition, self.cursors[index].clone(), self.page_size)
            .await?;
        self.cursors[index] = page.next_cursor;
        let logout = self
            .queue
            .requested(
                partition,
                self.logout_cursors[index].clone(),
                self.page_size,
            )
            .await?;
        self.logout_cursors[index] = logout.next_cursor;
        for job in page.jobs.into_iter().chain(logout.jobs) {
            process_one(&self.queue, self.processor.as_ref(), &job).await?;
        }
        Ok(())
    }

    /// Run in the Region process, with a bounded interval and cooperative shutdown. A
    /// failed scan does not trigger a provider retry; the next tick continues scanning.
    pub async fn run(mut self, mut stop: watch::Receiver<bool>, interval: Duration) -> Result<()> {
        if interval < Duration::from_millis(100) || interval > Duration::from_secs(3600) {
            return Err(crate::error(400, "INVALID_CLEANUP_INTERVAL"));
        }
        loop {
            if *stop.borrow() {
                return Ok(());
            }
            tokio::select! {
                changed = stop.changed() => {
                    if changed.is_err() || *stop.borrow() { return Ok(()); }
                }
                _ = tokio::time::sleep(interval) => {
                    if self.tick().await.is_err() {
                        eprintln!("Guest cleanup scan failed; a later scan will retry.");
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        cleanup::shard,
        regional::{OwnerIdentity, Policy},
        tests::MemoryMeta,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TestProcessor {
        calls: AtomicUsize,
        fail: bool,
    }
    impl Processor for TestProcessor {
        fn process<'a>(
            &'a self,
            _: &'a Job,
            _: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<Outcome>> + Send + 'a>> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                if self.fail {
                    Err(crate::error(503, "FIXTURE_UNCERTAIN"))
                } else {
                    Ok(Outcome::Deferred(
                        DeferredReason::ProviderDeletionUnsupported,
                    ))
                }
            })
        }
    }

    async fn setup() -> (Arc<Queue>, Policy, u8) {
        let metadata = Arc::new(MemoryMeta {
            authority: Some("region:a".into()),
            ..Default::default()
        });
        let queue = Arc::new(Queue::open(metadata.clone(), "region:a").await.unwrap());
        let expiry = crate::now().unwrap() - 1;
        let policy = Policy {
            workspace_id: Uuid::new_v4().to_string(),
            organization_id: Uuid::new_v4().to_string(),
            user_id: Uuid::new_v4().to_string(),
            region_id: "region:a".into(),
            generation: 1,
            denied: false,
            identity: OwnerIdentity::Guest {
                guest_id: Uuid::new_v4().to_string(),
                verifier: hex::encode([9u8; 32]),
                created_at: expiry - 86_400,
                expires_at: expiry,
            },
        };
        let policies = crate::regional::Policies::open(metadata, "region:a")
            .await
            .unwrap();
        policies
            .install(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        queue
            .enqueue(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        let partition = shard(&policy.workspace_id).unwrap();
        (queue, policy, partition)
    }

    #[tokio::test]
    async fn concurrent_scans_claim_once_and_keep_unsupported_cleanup_pending() {
        let (queue, policy, partition) = setup().await;
        let processor = Arc::new(TestProcessor {
            calls: AtomicUsize::new(0),
            fail: false,
        });
        let mut first = Scheduler::new(queue.clone(), processor.clone(), 32).unwrap();
        let mut second = Scheduler::new(queue.clone(), processor.clone(), 32).unwrap();
        first.partition = partition;
        second.partition = partition;
        let (a, b) = tokio::join!(first.tick(), second.tick());
        a.unwrap();
        b.unwrap();
        assert_eq!(processor.calls.load(Ordering::SeqCst), 1);
        let jobs = queue.due(partition, None, 32).await.unwrap().jobs;
        assert!(
            jobs.iter()
                .any(|job| job.workspace_id == policy.workspace_id
                    && matches!(
                        job.status,
                        Status::Deferred {
                            reason: DeferredReason::ProviderDeletionUnsupported,
                            ..
                        }
                    ))
        );
        first.partition = partition;
        first.tick().await.unwrap();
        assert_eq!(processor.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn logout_request_is_recovered_after_scheduler_restart_before_expiry() {
        let metadata = Arc::new(MemoryMeta {
            authority: Some("region:a".into()),
            ..Default::default()
        });
        let queue = Arc::new(Queue::open(metadata.clone(), "region:a").await.unwrap());
        let current = crate::now().unwrap();
        let mut policy = Policy {
            workspace_id: Uuid::new_v4().to_string(),
            organization_id: Uuid::new_v4().to_string(),
            user_id: Uuid::new_v4().to_string(),
            region_id: "region:a".into(),
            generation: 1,
            denied: false,
            identity: OwnerIdentity::Guest {
                guest_id: Uuid::new_v4().to_string(),
                verifier: hex::encode([9u8; 32]),
                created_at: current,
                expires_at: current + 86_400,
            },
        };
        let policies = crate::regional::Policies::open(metadata, "region:a")
            .await
            .unwrap();
        policies
            .install(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        queue
            .enqueue(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        queue
            .request_logout(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        policy.denied = true;
        policy.generation += 1;
        policies
            .install(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        let processor = Arc::new(TestProcessor {
            calls: AtomicUsize::new(0),
            fail: false,
        });
        let mut restarted = Scheduler::new(queue.clone(), processor.clone(), 32).unwrap();
        restarted.partition = shard(&policy.workspace_id).unwrap();
        restarted.tick().await.unwrap();
        assert_eq!(processor.calls.load(Ordering::SeqCst), 1);
        assert!(
            queue
                .requested_workspace(&policy.workspace_id)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn postponed_provider_cleanup_stays_durable_and_is_not_reported_deleted() {
        let (queue, policy, partition) = setup().await;
        let mut scheduler =
            Scheduler::new(queue.clone(), Arc::new(DeferProviderCleanup), 32).unwrap();
        scheduler.partition = partition;
        scheduler.tick().await.unwrap();
        let page = queue.due(partition, None, 32).await.unwrap();
        assert!(
            page.jobs
                .iter()
                .any(|job| job.workspace_id == policy.workspace_id
                    && matches!(
                        job.status,
                        Status::Deferred {
                            reason: DeferredReason::ProviderCleanupDeferred,
                            ..
                        }
                    ))
        );
    }

    #[tokio::test]
    async fn failed_processor_defers_without_reissuing_an_uncertain_effect() {
        let (queue, _, partition) = setup().await;
        let processor = Arc::new(TestProcessor {
            calls: AtomicUsize::new(0),
            fail: true,
        });
        let mut scheduler = Scheduler::new(queue.clone(), processor.clone(), 32).unwrap();
        scheduler.partition = partition;
        scheduler.tick().await.unwrap();
        assert!(matches!(
            queue.due(partition, None, 32).await.unwrap().jobs[0].status,
            Status::Deferred {
                reason: DeferredReason::ProviderOutcomeUncertain,
                ..
            }
        ));
        scheduler.partition = partition;
        scheduler.tick().await.unwrap();
        assert_eq!(processor.calls.load(Ordering::SeqCst), 1);
    }
}
