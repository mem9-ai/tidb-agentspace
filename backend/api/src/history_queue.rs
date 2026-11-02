//! Bounded, best-effort HTTP diagnostics. Jobs contain no raw requests or credentials.
use crate::history_request::CompletedHistoryRequest;
use futures::FutureExt;
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, watch};
use workspace_contracts::Result;

pub trait HistoryIngestionProcessor: Send + Sync {
    fn write<'a>(
        &'a self,
        workspace: &'a str,
        requests: &'a [CompletedHistoryRequest],
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>>;
}

struct Job {
    workspace: String,
    request: CompletedHistoryRequest,
}
#[derive(Default)]
struct WorkspaceHealth {
    pending: usize,
    dropped: u64,
    last_loss: Option<chrono::DateTime<chrono::Utc>>,
}
#[derive(Default)]
struct Health {
    workspaces: BTreeMap<String, WorkspaceHealth>,
    diagnostics: LossDiagnostics,
}

// Process-wide totals only: never include a Workspace identifier or error text in logs.
#[derive(Default)]
struct LossDiagnostics {
    workspace_limit: u64,
    workspace_queue_full: u64,
    queue_full: u64,
    queue_closed: u64,
    writer_busy: u64,
    writer_unavailable: u64,
    write_error: u64,
    write_timeout: u64,
    write_panic: u64,
    shutdown: u64,
}

impl LossDiagnostics {
    fn is_empty(&self) -> bool {
        self.workspace_limit == 0
            && self.workspace_queue_full == 0
            && self.queue_full == 0
            && self.queue_closed == 0
            && self.writer_busy == 0
            && self.writer_unavailable == 0
            && self.write_error == 0
            && self.write_timeout == 0
            && self.write_panic == 0
            && self.shutdown == 0
    }
}

#[derive(Clone)]
pub struct HistoryQueue {
    sender: mpsc::Sender<Job>,
    health: Arc<Mutex<Health>>,
    max_workspaces: usize,
    per_workspace: usize,
}

pub struct HistoryQueueWorker {
    receiver: mpsc::Receiver<Job>,
    health: Arc<Mutex<Health>>,
    processor: Arc<dyn HistoryIngestionProcessor>,
    timeout: std::time::Duration,
}

/// Counts are process-local; a caller must report null when a complete cross-restart count
/// cannot be established. Missing entries are unavailable, not silently healthy.
pub struct HistoryQueueHealth {
    pub degraded: bool,
    /// Includes queue drops and writes whose outcome could not be confirmed.
    pub unconfirmed: u64,
    pub last_loss: Option<chrono::DateTime<chrono::Utc>>,
}

impl HistoryQueue {
    pub fn new(
        capacity: usize,
        max_workspaces: usize,
        per_workspace: usize,
        processor: Arc<dyn HistoryIngestionProcessor>,
        timeout: std::time::Duration,
    ) -> Option<(Self, HistoryQueueWorker)> {
        if !(1..=65_536).contains(&capacity)
            || !(1..=65_536).contains(&max_workspaces)
            || !(1..=capacity).contains(&per_workspace)
            || timeout.is_zero()
            || timeout > std::time::Duration::from_secs(30)
        {
            return None;
        }
        let (sender, receiver) = mpsc::channel(capacity);
        let health = Arc::new(Mutex::new(Health::default()));
        Some((
            Self {
                sender,
                health: health.clone(),
                max_workspaces,
                per_workspace,
            },
            HistoryQueueWorker {
                receiver,
                health,
                processor,
                timeout,
            },
        ))
    }

    /// This operation never waits for metadata or provider I/O. `workspace` must come from
    /// the authenticated Workspace, not a raw client path.
    pub fn try_record(&self, workspace: &str, request: CompletedHistoryRequest) -> bool {
        if workspace.is_empty()
            || workspace.len() > 128
            || !workspace
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
        {
            return false;
        }
        let Ok(mut health) = self.health.lock() else {
            return false;
        };
        if !health.workspaces.contains_key(workspace)
            && health.workspaces.len() >= self.max_workspaces
        {
            let reusable = health
                .workspaces
                .iter()
                .find(|(_, state)| state.pending == 0 && state.dropped == 0)
                .map(|(id, _)| id.clone());
            if let Some(id) = reusable {
                health.workspaces.remove(&id);
            } else {
                health.diagnostics.workspace_limit =
                    health.diagnostics.workspace_limit.saturating_add(1);
                return false;
            }
        }
        let state = health.workspaces.entry(workspace.to_owned()).or_default();
        if state.pending >= self.per_workspace {
            note_loss(state);
            health.diagnostics.workspace_queue_full =
                health.diagnostics.workspace_queue_full.saturating_add(1);
            return false;
        }
        match self.sender.try_send(Job {
            workspace: workspace.to_owned(),
            request,
        }) {
            Ok(()) => {
                state.pending += 1;
                true
            }
            Err(error) => {
                note_loss(state);
                let counter = match error {
                    mpsc::error::TrySendError::Full(_) => &mut health.diagnostics.queue_full,
                    mpsc::error::TrySendError::Closed(_) => &mut health.diagnostics.queue_closed,
                };
                *counter = counter.saturating_add(1);
                false
            }
        }
    }

    pub fn health(&self, workspace: &str) -> Option<HistoryQueueHealth> {
        let health = self.health.lock().ok()?;
        let state = health.workspaces.get(workspace)?;
        Some(HistoryQueueHealth {
            degraded: state.dropped > 0,
            unconfirmed: state.dropped,
            last_loss: state.last_loss,
        })
    }
}
fn note_loss(state: &mut WorkspaceHealth) {
    state.dropped = state.dropped.saturating_add(1);
    state.last_loss = Some(chrono::Utc::now());
}
impl HistoryQueueWorker {
    pub async fn run(mut self, mut stop: watch::Receiver<bool>) {
        let mut report = tokio::time::interval_at(
            tokio::time::Instant::now() + std::time::Duration::from_secs(60),
            std::time::Duration::from_secs(60),
        );
        report.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            if *stop.borrow() {
                self.receiver.close();
                break;
            }
            tokio::select! {
                changed = stop.changed() => if changed.is_err() || *stop.borrow() { self.receiver.close(); break; },
                _ = report.tick() => self.report_diagnostics(),
                job = self.receiver.recv() => match job {
                    Some(job) => { let jobs = self.collect(job); self.process_jobs(jobs, None).await; },
                    None => { self.report_diagnostics(); return; },
                },
            }
        }
        let deadline = tokio::time::Instant::now() + self.timeout;
        while let Some(job) = self.receiver.recv().await {
            let jobs = self.collect(job);
            if !self.process_jobs(jobs, Some(deadline)).await {
                while let Ok(job) = self.receiver.try_recv() {
                    self.abandon(&job.workspace, 1);
                }
                break;
            }
        }
        self.report_diagnostics();
    }

    fn report_diagnostics(&self) {
        let diagnostics = match self.health.lock() {
            Ok(mut health) => std::mem::take(&mut health.diagnostics),
            Err(_) => return,
        };
        if !diagnostics.is_empty() {
            use std::io::Write;
            // A closed logging stream must not stop the history worker.
            let _ = writeln!(
                std::io::stderr().lock(),
                "HTTP history unconfirmed records: workspace_limit={} workspace_queue_full={} queue_full={} queue_closed={} writer_busy={} writer_unavailable={} write_error={} write_timeout={} write_panic={} shutdown={}",
                diagnostics.workspace_limit,
                diagnostics.workspace_queue_full,
                diagnostics.queue_full,
                diagnostics.queue_closed,
                diagnostics.writer_busy,
                diagnostics.writer_unavailable,
                diagnostics.write_error,
                diagnostics.write_timeout,
                diagnostics.write_panic,
                diagnostics.shutdown
            );
        }
    }
    fn collect(&mut self, first: Job) -> Vec<(String, Vec<CompletedHistoryRequest>)> {
        let mut groups: Vec<(String, Vec<CompletedHistoryRequest>)> = Vec::new();
        for job in std::iter::once(first)
            .chain(std::iter::from_fn(|| self.receiver.try_recv().ok()).take(63))
        {
            if let Some((_, requests)) = groups
                .iter_mut()
                .find(|(workspace, _)| *workspace == job.workspace)
            {
                requests.push(job.request);
            } else {
                groups.push((job.workspace, vec![job.request]));
            }
        }
        groups
    }
    async fn process_jobs(
        &self,
        groups: Vec<(String, Vec<CompletedHistoryRequest>)>,
        deadline: Option<tokio::time::Instant>,
    ) -> bool {
        let mut groups = groups.into_iter();
        while let Some((workspace, requests)) = groups.next() {
            if let Some(deadline) = deadline {
                if tokio::time::timeout_at(deadline, self.process(&workspace, &requests))
                    .await
                    .is_err()
                {
                    self.abandon(&workspace, requests.len());
                    for (workspace, requests) in groups {
                        self.abandon(&workspace, requests.len());
                    }
                    return false;
                }
            } else {
                self.process(&workspace, &requests).await;
            }
        }
        true
    }
    fn abandon(&self, workspace: &str, count: usize) {
        if let Ok(mut health) = self.health.lock()
            && let Some(state) = health.workspaces.get_mut(workspace)
        {
            state.pending = state.pending.saturating_sub(count);
            for _ in 0..count {
                note_loss(state);
            }
            health.diagnostics.shutdown = health.diagnostics.shutdown.saturating_add(count as u64);
        }
    }
    async fn process(&self, workspace: &str, requests: &[CompletedHistoryRequest]) {
        let result = tokio::time::timeout(
            self.timeout,
            std::panic::AssertUnwindSafe(async { self.processor.write(workspace, requests).await })
                .catch_unwind(),
        )
        .await;
        if let Ok(mut health) = self.health.lock()
            && let Some(state) = health.workspaces.get_mut(workspace)
        {
            state.pending = state.pending.saturating_sub(requests.len());
            if !matches!(result, Ok(Ok(Ok(())))) {
                for _ in requests {
                    note_loss(state);
                }
                let counter = match result {
                    Err(_) => &mut health.diagnostics.write_timeout,
                    Ok(Err(_)) => &mut health.diagnostics.write_panic,
                    Ok(Ok(Err(error))) if error.code == "WORKSPACE_POOL_BUSY" => {
                        &mut health.diagnostics.writer_busy
                    }
                    Ok(Ok(Err(error))) if error.code == "WORKSPACE_POOL_UNAVAILABLE" => {
                        &mut health.diagnostics.writer_unavailable
                    }
                    Ok(Ok(Err(_))) => &mut health.diagnostics.write_error,
                    Ok(Ok(Ok(()))) => unreachable!(),
                };
                *counter = counter.saturating_add(requests.len() as u64);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history_request::HistoryRequest;
    use tokio::sync::Semaphore;
    use workspace_domain::{
        HistoryActor,
        observability::{ActorKind, HttpCompletion},
    };

    struct BlockingProcessor {
        entered: Semaphore,
        release: Semaphore,
        seen: Mutex<Vec<String>>,
    }
    struct FailingProcessor {
        calls: Semaphore,
    }
    struct BatchProcessor {
        seen: Mutex<Vec<(String, usize)>>,
    }
    struct DiagnosticProcessor;
    impl HistoryIngestionProcessor for DiagnosticProcessor {
        fn write<'a>(
            &'a self,
            workspace: &'a str,
            _: &'a [CompletedHistoryRequest],
        ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
            Box::pin(async move {
                match workspace {
                    "busy" => Err(workspace_contracts::ServiceError::new(
                        503,
                        "WORKSPACE_POOL_BUSY",
                    )),
                    "unavailable" => Err(workspace_contracts::ServiceError::new(
                        503,
                        "WORKSPACE_POOL_UNAVAILABLE",
                    )),
                    "error" => Err(workspace_contracts::ServiceError::new(
                        503,
                        "PRIVATE_ERROR_DETAILS",
                    )),
                    "timeout" => {
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        Ok(())
                    }
                    _ => Ok(()),
                }
            })
        }
    }
    impl HistoryIngestionProcessor for BatchProcessor {
        fn write<'a>(
            &'a self,
            workspace: &'a str,
            requests: &'a [CompletedHistoryRequest],
        ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
            Box::pin(async move {
                self.seen
                    .lock()
                    .unwrap()
                    .push((workspace.to_owned(), requests.len()));
                if workspace == "workspace-a" {
                    Err(workspace_contracts::ServiceError::new(
                        503,
                        "TEST_STORAGE_UNAVAILABLE",
                    ))
                } else {
                    Ok(())
                }
            })
        }
    }
    impl HistoryIngestionProcessor for FailingProcessor {
        fn write<'a>(
            &'a self,
            _: &'a str,
            _: &'a [CompletedHistoryRequest],
        ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
            Box::pin(async move {
                self.calls.add_permits(1);
                Err(workspace_contracts::ServiceError::new(
                    503,
                    "TEST_STORAGE_UNAVAILABLE",
                ))
            })
        }
    }
    impl HistoryIngestionProcessor for BlockingProcessor {
        fn write<'a>(
            &'a self,
            workspace: &'a str,
            _: &'a [CompletedHistoryRequest],
        ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
            Box::pin(async move {
                self.seen.lock().unwrap().push(workspace.to_owned());
                self.entered.add_permits(1);
                self.release.acquire().await.expect("test release").forget();
                Ok(())
            })
        }
    }
    fn event() -> CompletedHistoryRequest {
        HistoryRequest::start(
            HistoryActor {
                kind: ActorKind::Owner,
                id: "owner".into(),
            },
            uuid::Uuid::new_v4(),
            "GET",
            "/files/private",
        )
        .unwrap()
        .finish(HttpCompletion::Responded(200))
    }

    #[tokio::test]
    async fn diagnostic_totals_distinguish_failures_without_recording_error_details() {
        let (queue, mut worker) = HistoryQueue::new(
            8,
            8,
            1,
            Arc::new(DiagnosticProcessor),
            std::time::Duration::from_millis(20),
        )
        .unwrap();
        for workspace in ["busy", "unavailable", "error", "timeout", "success"] {
            assert!(queue.try_record(workspace, event()));
            let job = worker.receiver.try_recv().unwrap();
            worker.process(&job.workspace, &[job.request]).await;
        }
        for workspace in ["busy", "unavailable", "error", "timeout"] {
            assert_eq!(queue.health(workspace).unwrap().unconfirmed, 1);
        }
        assert!(!queue.health("success").unwrap().degraded);
        let health = queue.health.lock().unwrap();
        assert_eq!(health.diagnostics.writer_busy, 1);
        assert_eq!(health.diagnostics.writer_unavailable, 1);
        assert_eq!(health.diagnostics.write_error, 1);
        assert_eq!(health.diagnostics.write_timeout, 1);
        assert_eq!(health.diagnostics.write_panic, 0);
    }

    #[tokio::test]
    async fn diagnostic_totals_distinguish_full_and_closed_queues() {
        let (queue, worker) = HistoryQueue::new(
            1,
            3,
            1,
            Arc::new(DiagnosticProcessor),
            std::time::Duration::from_secs(1),
        )
        .unwrap();
        assert!(queue.try_record("a", event()));
        assert!(!queue.try_record("a", event()));
        assert!(!queue.try_record("b", event()));
        drop(worker);
        assert!(!queue.try_record("c", event()));
        let health = queue.health.lock().unwrap();
        assert_eq!(health.diagnostics.workspace_queue_full, 1);
        assert_eq!(health.diagnostics.queue_full, 1);
        assert_eq!(health.diagnostics.queue_closed, 1);
    }
    #[tokio::test]
    async fn batches_preserve_workspace_isolation_and_count_each_failed_record() {
        let processor = Arc::new(BatchProcessor {
            seen: Mutex::new(Vec::new()),
        });
        let (queue, worker) = HistoryQueue::new(
            6,
            2,
            4,
            processor.clone(),
            std::time::Duration::from_secs(1),
        )
        .unwrap();
        assert!(queue.try_record("workspace-a", event()));
        assert!(queue.try_record("workspace-b", event()));
        assert!(queue.try_record("workspace-a", event()));
        let (stop, receiver) = watch::channel(true);
        worker.run(receiver).await;
        drop(stop);
        assert_eq!(
            *processor.seen.lock().unwrap(),
            [("workspace-a".into(), 2), ("workspace-b".into(), 1)]
        );
        assert_eq!(queue.health("workspace-a").unwrap().unconfirmed, 2);
        assert!(!queue.health("workspace-b").unwrap().degraded);
    }
    #[tokio::test]
    async fn saturation_is_bounded_isolated_and_drained_on_shutdown() {
        let processor = Arc::new(BlockingProcessor {
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            seen: Mutex::new(Vec::new()),
        });
        let (queue, worker) = HistoryQueue::new(
            1,
            2,
            1,
            processor.clone(),
            std::time::Duration::from_secs(1),
        )
        .unwrap();
        let (stop, receiver) = watch::channel(false);
        let task = tokio::spawn(worker.run(receiver));
        assert!(queue.try_record("workspace-a", event()));
        processor.entered.acquire().await.unwrap().forget();
        assert!(!queue.try_record("workspace-a", event()));
        assert!(queue.try_record("workspace-b", event()));
        assert!(!queue.try_record("workspace-c", event()));
        assert!(queue.health("workspace-c").is_none());
        assert_eq!(queue.health("workspace-a").unwrap().unconfirmed, 1);
        assert!(!queue.health("workspace-b").unwrap().degraded);
        let _ = stop.send(true);
        processor.release.add_permits(2);
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert!(!queue.try_record("workspace-b", event()));
        assert!(queue.health("workspace-b").unwrap().degraded);
        assert!(queue.health("workspace-b").unwrap().last_loss.is_some());
    }

    #[tokio::test]
    async fn an_uncertain_write_is_not_replayed_and_does_not_block_another_workspace() {
        let processor = Arc::new(BlockingProcessor {
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            seen: Mutex::new(Vec::new()),
        });
        let (queue, worker) = HistoryQueue::new(
            1,
            2,
            1,
            processor.clone(),
            std::time::Duration::from_millis(500),
        )
        .unwrap();
        let (stop, receiver) = watch::channel(false);
        let task = tokio::spawn(worker.run(receiver));
        assert!(queue.try_record("workspace-a", event()));
        processor.entered.acquire().await.unwrap().forget();
        assert!(queue.try_record("workspace-b", event()));
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            processor.entered.acquire(),
        )
        .await
        .unwrap()
        .unwrap()
        .forget();
        assert!(queue.health("workspace-a").unwrap().degraded);
        assert_eq!(queue.health("workspace-a").unwrap().unconfirmed, 1);
        processor.release.add_permits(1);
        let _ = stop.send(true);
        tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert!(!queue.health("workspace-b").unwrap().degraded);
        assert_eq!(
            *processor.seen.lock().unwrap(),
            ["workspace-a", "workspace-b"]
        );
    }

    #[tokio::test]
    async fn a_failed_write_marks_only_its_workspace_degraded() {
        let processor = Arc::new(FailingProcessor {
            calls: Semaphore::new(0),
        });
        let (queue, worker) = HistoryQueue::new(
            2,
            2,
            1,
            processor.clone(),
            std::time::Duration::from_secs(1),
        )
        .unwrap();
        let (stop, receiver) = watch::channel(false);
        let task = tokio::spawn(worker.run(receiver));
        assert!(queue.try_record("workspace-a", event()));
        processor.calls.acquire().await.unwrap().forget();
        let _ = stop.send(true);
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(processor.calls.available_permits(), 0);
        assert_eq!(queue.health("workspace-a").unwrap().unconfirmed, 1);
        assert!(queue.health("workspace-b").is_none());
    }
}
