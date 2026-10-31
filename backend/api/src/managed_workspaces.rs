//! Bounded Region-local managed Workspace registry. The native host can opt in explicitly.
//! The caller authenticates a Region credential before selecting a Workspace, keeps its
//! lease through response/stream completion, and fences in-flight work before cleanup.

use std::{collections::BTreeMap, sync::Arc};
use tokio::sync::Mutex;
use workspace_contracts::{Metadata, Result, ServiceError};
use workspace_domain::{Credential, Operation, Repository, Response, Workspace};

pub struct ManagedWorkspace {
    workspace: Arc<Workspace>,
    product: Option<Arc<workspace_product::Product>>,
}

impl ManagedWorkspace {
    pub(crate) fn workspace(&self) -> Arc<Workspace> {
        self.workspace.clone()
    }
    pub(crate) fn product(&self) -> Option<Arc<workspace_product::Product>> {
        self.product.clone()
    }
    pub async fn call(&self, credential: Credential, operation: Operation) -> Result<Response> {
        self.workspace.call(credential, operation).await
    }

    pub async fn handle(
        &self,
        request: workspace_product::Request<'_>,
    ) -> Result<(u16, workspace_product::Reply)> {
        self.product
            .as_ref()
            .ok_or_else(|| ServiceError::new(404, "NOT_FOUND"))?
            .handle(request)
            .await
    }
}

struct Cached {
    entry: Arc<ManagedWorkspace>,
    used: u64,
}

#[derive(Default)]
struct State {
    entries: BTreeMap<String, Cached>,
    sequence: u64,
    shutdown: bool,
    release_uncertain: bool,
}

pub struct ManagedWorkspaces {
    metadata: Arc<dyn Metadata>,
    authority: String,
    product: Option<workspace_product::Config>,
    limit: usize,
    state: Mutex<State>,
}

impl ManagedWorkspaces {
    pub fn new(
        metadata: Arc<dyn Metadata>,
        authority: &str,
        product: Option<workspace_product::Config>,
        limit: usize,
    ) -> Result<Self> {
        if !authority.starts_with("region:") || limit == 0 || limit > 4096 {
            return Err(ServiceError::new(400, "INVALID_WORKSPACE_POOL"));
        }
        Ok(Self {
            metadata,
            authority: authority.into(),
            product,
            limit,
            state: Mutex::new(State::default()),
        })
    }

    /// A URL Workspace ID alone never grants access. Regional sessions and scoped Keys
    /// are authenticated against the managed Workspace before any lease is returned.
    pub async fn acquire(
        &self,
        workspace_id: &str,
        credential: &Credential,
    ) -> Result<Arc<ManagedWorkspace>> {
        if !uuid::Uuid::parse_str(workspace_id).is_ok_and(|id| id.to_string() == workspace_id)
            || !matches!(credential, Credential::SessionOwner { workspace_id: bound, policy_generation: Some(_), .. } if bound == workspace_id)
                && !matches!(credential, Credential::Bearer(_))
        {
            return Err(ServiceError::new(401, "UNAUTHENTICATED"));
        }
        let mut state = self.state.lock().await;
        if state.shutdown || state.release_uncertain {
            return Err(ServiceError::new(503, "WORKSPACE_POOL_UNAVAILABLE"));
        }
        state.sequence = state.sequence.saturating_add(1);
        let sequence = state.sequence;
        if let Some(cached) = state.entries.get_mut(workspace_id) {
            cached.entry.workspace.authenticate(credential).await?;
            cached.used = sequence;
            return Ok(cached.entry.clone());
        }
        if state.entries.len() >= self.limit {
            let victim = state
                .entries
                .iter()
                .filter(|(_, cached)| Arc::strong_count(&cached.entry) == 1)
                .min_by_key(|(_, cached)| cached.used)
                .map(|(id, _)| id.clone())
                .ok_or_else(|| ServiceError::new(429, "WORKSPACE_POOL_BUSY"))?;
            let cached = state.entries.remove(&victim).expect("selected cache entry");
            if cached.entry.workspace.close().await.is_err() {
                state.release_uncertain = true;
                return Err(ServiceError::new(503, "WORKSPACE_RELEASE_UNCERTAIN"));
            }
        }
        // Never initialize, adopt, or automatically take over an existing writer.
        let repository = Repository::open(
            self.metadata.clone(),
            &self.authority,
            workspace_id,
            false,
            None,
        )
        .await?;
        let workspace = Arc::new(Workspace::new_managed(repository));
        if let Err(e) = workspace.authenticate(credential).await {
            if workspace.close().await.is_err() {
                state.release_uncertain = true;
            }
            return Err(e);
        }
        let product = if let Some(config) = self.product.clone() {
            match workspace_product::Product::new(workspace.clone(), config).await {
                Ok(value) => Some(Arc::new(value)),
                Err(e) => {
                    if workspace.close().await.is_err() {
                        state.release_uncertain = true;
                    }
                    return Err(e);
                }
            }
        } else {
            None
        };
        let entry = Arc::new(ManagedWorkspace { workspace, product });
        state.entries.insert(
            workspace_id.into(),
            Cached {
                entry: entry.clone(),
                used: sequence,
            },
        );
        Ok(entry)
    }

    /// Called after request and stream leases have drained. An uncertain writer release
    /// prevents reuse and requires regional recovery rather than an automatic takeover.
    pub async fn close(&self) -> Result<()> {
        let mut state = self.state.lock().await;
        state.shutdown = true;
        if state
            .entries
            .values()
            .any(|cached| Arc::strong_count(&cached.entry) != 1)
        {
            return Err(ServiceError::new(409, "WORKSPACE_POOL_BUSY"));
        }
        let entries = std::mem::take(&mut state.entries);
        let mut failed = false;
        for cached in entries.into_values() {
            if cached.entry.workspace.close().await.is_err() {
                failed = true;
            }
        }
        if failed {
            state.release_uncertain = true;
            Err(ServiceError::new(503, "WORKSPACE_RELEASE_UNCERTAIN"))
        } else {
            Ok(())
        }
    }
}
