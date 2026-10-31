//! Region-only Guest cleanup. Provider effects are journaled before I/O and never blindly retried.

use crate::managed_workspaces::{ManagedWorkspace, ManagedWorkspaces};
use std::{future::Future, pin::Pin, sync::Arc};
use workspace_contracts::Result;
use workspace_identity::{
    cleanup::{DeferredReason, Job, Queue},
    scheduler::{Outcome, Processor},
};

pub struct GuestCleanup {
    queue: Arc<Queue>,
    workspaces: Arc<ManagedWorkspaces>,
}

impl GuestCleanup {
    pub fn new(queue: Arc<Queue>, workspaces: Arc<ManagedWorkspaces>) -> Self {
        Self { queue, workspaces }
    }

    async fn cleanup(&self, job: &Job, attempt: &str, entry: &ManagedWorkspace) -> Result<Outcome> {
        let Some(product) = entry.product() else {
            return Ok(Outcome::Deferred(DeferredReason::ProviderCleanupDeferred));
        };
        let repository = entry.workspace().repository();
        let mut after = None;
        let mut uncertain = false;
        let mut unsupported = false;
        loop {
            let (resources, next) = repository.cleanup_resources_page(after, 100).await?;
            for resource in resources {
                let Some(id) = resource["id"].as_str() else {
                    uncertain = true;
                    continue;
                };
                let provider = resource["provider"].as_str().unwrap_or("local");
                let (cleanup_provider, storage_id, target) = match provider {
                    "local" => continue,
                    "db9-anonymous" => {
                        let binding = product.providers.binding("db9", id).await?;
                        let Some(target) = binding["instanceId"].as_str() else {
                            uncertain = true;
                            continue;
                        };
                        ("db9-anonymous", None, target.to_owned())
                    }
                    "drive9-anonymous" | "duckdb-drive9" => {
                        let storage_id = if provider == "duckdb-drive9" {
                            let binding = product.providers.binding("duckdb", id).await?;
                            let Some(storage) = binding["storageId"].as_str() else {
                                uncertain = true;
                                continue;
                            };
                            storage.to_owned()
                        } else {
                            id.to_owned()
                        };
                        let binding = product.providers.binding("drive9", &storage_id).await?;
                        let Some(target) = binding["tenantId"].as_str() else {
                            uncertain = true;
                            continue;
                        };
                        ("drive9-anonymous", Some(storage_id), target.to_owned())
                    }
                    // Zero has no deletion API. Retain its metadata for later reconciliation.
                    _ => {
                        unsupported = true;
                        continue;
                    }
                };
                let permit = match self
                    .queue
                    .begin_resource(
                        job,
                        attempt,
                        id,
                        cleanup_provider,
                        &target,
                        &uuid::Uuid::new_v4().to_string(),
                    )
                    .await
                {
                    Ok(permit) => permit,
                    Err(_) => {
                        uncertain = true;
                        continue;
                    }
                };
                let result = if storage_id.is_some() {
                    product
                        .providers
                        .delete_guest_drive9(&self.queue, permit)
                        .await
                } else {
                    product
                        .providers
                        .delete_expired_guest_db9(&self.queue, permit)
                        .await
                };
                // An accepted request alone is not verified deletion. Preserve the job and
                // credentials for provider-specific reconciliation, even after acceptance.
                let _ = result;
                uncertain = true;
            }
            after = next;
            if after.is_none() {
                break;
            }
        }
        Ok(if uncertain {
            Outcome::Deferred(DeferredReason::ProviderOutcomeUncertain)
        } else if unsupported {
            Outcome::Deferred(DeferredReason::ProviderDeletionUnsupported)
        } else {
            Outcome::VerifiedComplete
        })
    }
}

impl Processor for GuestCleanup {
    fn process<'a>(
        &'a self,
        job: &'a Job,
        attempt_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Outcome>> + Send + 'a>> {
        Box::pin(async move {
            let entry = match self.workspaces.acquire_cleanup(&job.workspace_id).await {
                Ok(entry) => entry,
                Err(error) if error.code == "WORKSPACE_POOL_BUSY" => {
                    return Ok(Outcome::RetryWithoutEffects);
                }
                Err(error) => return Err(error),
            };
            let outcome = self.cleanup(job, attempt_id, &entry).await;
            self.workspaces
                .release_cleanup(&job.workspace_id, entry)
                .await?;
            outcome
        })
    }
}
