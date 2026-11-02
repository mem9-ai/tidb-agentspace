//! Internal history cleanup adapter. No customer request can select a maintenance lease.
use crate::{
    history_queue::HistoryIngestionProcessor, history_request::CompletedHistoryRequest,
    managed_workspaces::ManagedWorkspaces,
};
use std::{future::Future, pin::Pin, sync::Arc};
use workspace_contracts::Result;
use workspace_domain::{
    Workspace,
    observability::{HistoryMaintenanceProcessor, HistoryScheduleOutcome, HistoryScheduler},
};

/// Retry transient maintenance failures without replaying customer operations. Jobs remain
/// durable and cleanup state is not reported as healthy merely because this loop is alive.
pub async fn supervise(
    mut scheduler: HistoryScheduler,
    mut stop: tokio::sync::watch::Receiver<bool>,
) {
    loop {
        if scheduler
            .run(stop.clone(), std::time::Duration::from_secs(1))
            .await
            .is_ok()
        {
            return;
        }
        eprintln!("Workspace history maintenance is delayed; pending records are retained.");
        if *stop.borrow() {
            return;
        }
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {},
            changed = stop.changed() => if changed.is_err() || *stop.borrow() { return; },
        }
    }
}

pub struct HistoryProcessor {
    local: Arc<Workspace>,
    managed: Option<Arc<ManagedWorkspaces>>,
}

impl HistoryProcessor {
    pub fn new(local: Arc<Workspace>, managed: Option<Arc<ManagedWorkspaces>>) -> Self {
        Self { local, managed }
    }

    async fn clean(workspace: Arc<Workspace>) -> Result<HistoryScheduleOutcome> {
        let repository = workspace.repository();
        let mut more = false;
        let mut cursor = None;
        for _ in 0..4 {
            let page = repository
                .recover_stale_audit_batch(cursor.as_deref(), 64)
                .await?;
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        if cursor.is_some() {
            more = true;
        }
        let now = chrono::Utc::now();
        for _ in 0..4 {
            let removed = repository.purge_expired_request_batch(now).await?;
            if removed < 64 {
                break;
            }
            more = true;
        }
        for _ in 0..4 {
            let result = repository.purge_expired_audit_batch(now).await?;
            if result.pending > 0 {
                more = true;
            }
            if result.removed < 64 {
                break;
            }
            more = true;
        }
        Ok(if more {
            HistoryScheduleOutcome::RetrySoon
        } else {
            HistoryScheduleOutcome::Complete
        })
    }
}

impl HistoryMaintenanceProcessor for HistoryProcessor {
    fn process<'a>(
        &'a self,
        id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<HistoryScheduleOutcome>> + Send + 'a>> {
        Box::pin(async move {
            if self.local.repository().workspace_id() == id {
                return Self::clean(self.local.clone()).await;
            }
            let Some(pool) = &self.managed else {
                return Ok(HistoryScheduleOutcome::RetrySoon);
            };
            let lease = match pool.acquire_history_maintenance(id).await {
                Ok(value) => value,
                Err(failure)
                    if matches!(
                        failure.code.as_str(),
                        "WORKSPACE_POOL_BUSY" | "WORKSPACE_POOL_UNAVAILABLE"
                    ) =>
                {
                    return Ok(HistoryScheduleOutcome::RetrySoon);
                }
                Err(failure) => return Err(failure),
            };
            let result = Self::clean(lease.workspace()).await;
            let released = lease.release().await;
            released?;
            result
        })
    }
}

impl HistoryIngestionProcessor for HistoryProcessor {
    fn write<'a>(
        &'a self,
        id: &'a str,
        requests: &'a [CompletedHistoryRequest],
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let entries: Vec<_> = requests
                .iter()
                .map(CompletedHistoryRequest::entry)
                .collect();
            if self.local.repository().workspace_id() == id {
                return self.local.repository().append_request_batch(&entries).await;
            }
            let pool = self.managed.as_ref().ok_or_else(|| {
                workspace_contracts::ServiceError::new(503, "HISTORY_WORKSPACE_UNAVAILABLE")
            })?;
            let lease = pool.acquire_cached_history(id).await?;
            lease
                .workspace()
                .repository()
                .append_request_batch(&entries)
                .await
        })
    }
}
