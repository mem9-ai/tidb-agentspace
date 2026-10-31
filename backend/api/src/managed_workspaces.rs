//! Bounded Region-local managed Workspace registry. The native host can opt in explicitly.
//! The caller authenticates a Region credential before selecting a Workspace, keeps its
//! lease through response/stream completion, and fences in-flight work before cleanup.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
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
    cleanup: BTreeSet<String>,
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
        if state.cleanup.contains(workspace_id) {
            return Err(ServiceError::new(401, "UNAUTHENTICATED"));
        }
        state.sequence = state.sequence.saturating_add(1);
        let sequence = state.sequence;
        if let Some(entry) = state
            .entries
            .get(workspace_id)
            .map(|cached| cached.entry.clone())
        {
            // The clone pins the entry: eviction and Guest cleanup cannot close it while
            // authorization awaits metadata, and unrelated Workspaces need not wait.
            drop(state);
            entry.workspace.authenticate(credential).await?;
            let mut state = self.state.lock().await;
            if let Some(cached) = state.entries.get_mut(workspace_id)
                && Arc::ptr_eq(&cached.entry, &entry)
            {
                cached.used = cached.used.max(sequence);
            }
            return Ok(entry);
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

    /// Region-internal cleanup only. The caller must already hold a durable cleanup claim
    /// and have denied or expired the Guest policy before accessing a Workspace this way.
    pub(crate) async fn acquire_cleanup(
        &self,
        workspace_id: &str,
    ) -> Result<Arc<ManagedWorkspace>> {
        if !uuid::Uuid::parse_str(workspace_id).is_ok_and(|id| id.to_string() == workspace_id) {
            return Err(ServiceError::new(404, "WORKSPACE_NOT_FOUND"));
        }
        let mut state = self.state.lock().await;
        if state.shutdown || state.release_uncertain || state.cleanup.contains(workspace_id) {
            return Err(ServiceError::new(503, "WORKSPACE_POOL_UNAVAILABLE"));
        }
        if let Some(cached) = state.entries.get(workspace_id)
            && Arc::strong_count(&cached.entry) != 1
        {
            return Err(ServiceError::new(409, "WORKSPACE_POOL_BUSY"));
        }
        state.cleanup.insert(workspace_id.to_owned());
        if let Some(cached) = state.entries.remove(workspace_id) {
            return Ok(cached.entry);
        }
        let repository = match Repository::open(
            self.metadata.clone(),
            &self.authority,
            workspace_id,
            false,
            None,
        )
        .await
        {
            Ok(value) => value,
            Err(error) => {
                state.cleanup.remove(workspace_id);
                return Err(error);
            }
        };
        let workspace = Arc::new(Workspace::new_managed(repository));
        let product = if let Some(config) = self.product.clone() {
            match workspace_product::Product::new(workspace.clone(), config).await {
                Ok(value) => Some(Arc::new(value)),
                Err(error) => {
                    if workspace.close().await.is_err() {
                        state.release_uncertain = true;
                    }
                    state.cleanup.remove(workspace_id);
                    return Err(error);
                }
            }
        } else {
            None
        };
        Ok(Arc::new(ManagedWorkspace { workspace, product }))
    }

    pub(crate) async fn release_cleanup(
        &self,
        workspace_id: &str,
        entry: Arc<ManagedWorkspace>,
    ) -> Result<()> {
        let mut state = self.state.lock().await;
        if !state.cleanup.contains(workspace_id) || Arc::strong_count(&entry) != 1 {
            return Err(ServiceError::new(409, "WORKSPACE_POOL_BUSY"));
        }
        let result = entry.workspace.close().await;
        state.cleanup.remove(workspace_id);
        if result.is_err() {
            state.release_uncertain = true;
        }
        result
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::Notify;
    use workspace_contracts::{Call, MetaRequest};

    const REGION: &str = "region:test";
    const USER: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ORGANIZATION: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const A: &str = "11111111-1111-4111-8111-111111111111";
    const B: &str = "22222222-2222-4222-8222-222222222222";

    struct MetadataGate {
        pause: AtomicBool,
        paused: Notify,
        resume: Notify,
    }

    impl Metadata for MetadataGate {
        fn health(&self) -> Call<'_> {
            Box::pin(async { Ok(json!({"authorityId":REGION,"capabilities":["recordsV1"]})) })
        }

        fn execute(&self, request: MetaRequest) -> Call<'_> {
            Box::pin(async move {
                match request {
                    MetaRequest::Get { scope, keys, .. } => {
                        if scope.owner_id == A
                            && keys == ["ownership/onboarding"]
                            && self.pause.swap(false, Ordering::AcqRel)
                        {
                            self.paused.notify_one();
                            self.resume.notified().await;
                        }
                        let records = keys.into_iter().map(|key| {
                            let value = match key.as_str() {
                                "system/writer" => Value::Null,
                                "state/workspace" => json!({"id":scope.owner_id}),
                                "ownership/onboarding" => json!({"workspaceId":scope.owner_id,"userId":USER,"organizationId":ORGANIZATION}),
                                "owner-policy" => json!({"workspaceId":scope.owner_id,"regionId":REGION,"userId":USER,"organizationId":ORGANIZATION,"generation":1,"denied":false,"identity":{"kind":"oidc","issuer":"issuer","subject":"subject"}}),
                                _ => panic!("unexpected metadata key"),
                            };
                            let envelope = if value.is_null() { Value::Null } else {json!({"version":"v1","value":value})};
                            (key, envelope)
                        }).collect::<serde_json::Map<_,_>>();
                        Ok(json!({"records":records}))
                    }
                    MetaRequest::Commit { .. } => Ok(json!({})),
                    _ => panic!("unexpected metadata operation"),
                }
            })
        }
    }

    fn credential(workspace_id: &str) -> Credential {
        Credential::SessionOwner {
            id: USER.into(),
            actor: "Owner".into(),
            workspace_id: workspace_id.into(),
            policy_generation: Some(1),
            expires_at: chrono::Utc::now().timestamp() + 3600,
            revoked: Arc::new(AtomicBool::new(false)),
        }
    }

    #[tokio::test]
    async fn cached_authentication_does_not_block_other_workspaces_or_lose_its_lease() {
        let metadata = Arc::new(MetadataGate {
            pause: AtomicBool::new(true),
            paused: Notify::new(),
            resume: Notify::new(),
        });
        let pool = Arc::new(ManagedWorkspaces::new(metadata.clone(), REGION, None, 2).unwrap());
        for id in [A, B] {
            let repository = Repository::open(metadata.clone(), REGION, id, false, None)
                .await
                .unwrap();
            let entry = Arc::new(ManagedWorkspace {
                workspace: Arc::new(Workspace::new_managed(repository)),
                product: None,
            });
            pool.state
                .lock()
                .await
                .entries
                .insert(id.into(), Cached { entry, used: 0 });
        }
        let stalled = tokio::spawn({
            let pool = pool.clone();
            async move { pool.acquire(A, &credential(A)).await }
        });
        metadata.paused.notified().await;
        let other = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            pool.acquire(B, &credential(B)),
        )
        .await
        .expect("unrelated Workspace authentication was serialized")
        .unwrap();
        assert_eq!(other.workspace().repository().workspace_id(), B);
        assert_eq!(
            pool.acquire_cleanup(A).await.err().unwrap().code,
            "WORKSPACE_POOL_BUSY"
        );
        metadata.resume.notify_one();
        assert!(stalled.await.unwrap().is_ok());
    }
}
