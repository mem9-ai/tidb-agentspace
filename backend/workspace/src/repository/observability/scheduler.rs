//! Bounded round-robin delivery of persistent history-maintenance jobs.
use super::*;
use std::{future::Future, pin::Pin};

pub enum HistoryScheduleOutcome {
    /// A bounded pass finished; check again periodically for writes racing the scan.
    Complete,
    /// More cleanup or reconciliation is needed, or the Workspace is temporarily busy.
    RetrySoon,
}

pub trait HistoryMaintenanceProcessor: Send + Sync {
    fn process<'a>(
        &'a self,
        workspace: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<HistoryScheduleOutcome>> + Send + 'a>>;
}

pub struct HistoryScheduler {
    queue: HistoryMaintenance,
    processor: Arc<dyn HistoryMaintenanceProcessor>,
    shard: u8,
    cursors: Vec<Option<String>>,
}

impl HistoryScheduler {
    pub fn new(queue: HistoryMaintenance, processor: Arc<dyn HistoryMaintenanceProcessor>) -> Self {
        Self {
            queue,
            processor,
            shard: 0,
            cursors: vec![None; HistoryMaintenance::shard_count() as usize],
        }
    }

    /// Process at most sixteen Workspaces from one shard, leaving every job durable.
    pub async fn tick_at(&mut self, now: u64) -> Result<()> {
        let shard = self.shard;
        self.shard = (self.shard + 1) % HistoryMaintenance::shard_count();
        let page = self
            .queue
            .due(shard, now, self.cursors[shard as usize].as_deref(), 16)
            .await?;
        for job in &page.jobs {
            let delay = match self.processor.process(&job.workspace_id).await? {
                HistoryScheduleOutcome::Complete => 900,
                HistoryScheduleOutcome::RetrySoon => 5,
            };
            let next = now
                .checked_add(delay)
                .and_then(|value| job.due_at.checked_add(1).map(|minimum| value.max(minimum)))
                .ok_or_else(|| error("HISTORY_MAINTENANCE_CLOCK"))?;
            self.queue.reschedule(job, next).await?;
        }
        self.cursors[shard as usize] = page.next_cursor;
        Ok(())
    }

    pub async fn run(
        &mut self,
        mut stop: tokio::sync::watch::Receiver<bool>,
        interval: std::time::Duration,
    ) -> Result<()> {
        if interval.is_zero() {
            return Err(ServiceError::new(400, "HISTORY_MAINTENANCE_INTERVAL"));
        }
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            if *stop.borrow() {
                return Ok(());
            }
            tokio::select! {
                changed=stop.changed()=>if changed.is_err() || *stop.borrow() {return Ok(());},
                _=ticker.tick()=>{
                    let now=u64::try_from(chrono::Utc::now().timestamp()).map_err(|_|error("HISTORY_MAINTENANCE_CLOCK"))?;
                    self.tick_at(now).await?;
                }
            }
        }
    }
}
