//! Bounded Region-local managed Workspace registry. The native host can opt in explicitly.
//! The caller authenticates a Region credential before selecting a Workspace, keeps its
//! lease through response/stream completion, and fences in-flight work before cleanup.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore, watch};
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

#[derive(Clone)]
enum FlightOutcome {
    Opened(Arc<ManagedWorkspace>),
    Released,
}

#[derive(Default)]
struct State {
    entries: BTreeMap<String, Cached>,
    sequence: u64,
    shutdown: bool,
    release_uncertain: bool,
    cleanup: BTreeSet<String>,
    flights: BTreeMap<String, watch::Sender<Option<Result<FlightOutcome>>>>,
    openings: usize,
}

pub struct ManagedWorkspaces {
    metadata: Arc<dyn Metadata>,
    authority: String,
    product: Option<workspace_product::Config>,
    limit: usize,
    state: Arc<Mutex<State>>,
    history_slot: Arc<Semaphore>,
}

/// A Region-internal maintenance lease. Cold Workspaces use one extra bounded slot and
/// never run Guest deletion or legacy-Key retirement as a side effect of history cleanup.
pub(crate) struct HistoryLease {
    entry: Option<Arc<ManagedWorkspace>>,
    pool: Arc<ManagedWorkspaces>,
    workspace_id: String,
    temporary: bool,
    permit: Option<OwnedSemaphorePermit>,
}

impl HistoryLease {
    pub(crate) fn workspace(&self) -> Arc<Workspace> {
        self.entry.as_ref().expect("live history lease").workspace()
    }

    pub(crate) async fn release(mut self) -> Result<()> {
        let entry = self.entry.take().expect("live history lease");
        if self.temporary {
            let result = self
                .pool
                .release_history_maintenance(&self.workspace_id, entry)
                .await;
            self.permit.take();
            result
        } else {
            drop(entry);
            Ok(())
        }
    }
}

impl Drop for HistoryLease {
    fn drop(&mut self) {
        let Some(entry) = self.entry.take() else {
            return;
        };
        if !self.temporary {
            return;
        }
        let pool = self.pool.clone();
        let workspace = self.workspace_id.clone();
        let permit = self.permit.take();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = pool.release_history_maintenance(&workspace, entry).await;
                drop(permit);
            });
        }
    }
}

struct HistoryOpenGuard {
    pool: Arc<ManagedWorkspaces>,
    workspace_id: String,
    armed: bool,
}
impl Drop for HistoryOpenGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let pool = self.pool.clone();
        let workspace = self.workspace_id.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let mut state = pool.state.lock().await;
                state.release_uncertain = true;
                complete_flight(
                    &mut state,
                    &workspace,
                    Err(ServiceError::new(503, "WORKSPACE_RELEASE_UNCERTAIN")),
                );
            });
        }
    }
}

struct OpenJob {
    state: Arc<Mutex<State>>,
    metadata: Arc<dyn Metadata>,
    authority: String,
    product: Option<workspace_product::Config>,
    workspace_id: String,
    credential: Credential,
    sequence: u64,
    victim: Option<(String, Arc<ManagedWorkspace>)>,
}

fn complete_flight(state: &mut State, id: &str, result: Result<FlightOutcome>) {
    if let Some(signal) = state.flights.remove(id) {
        signal.send_replace(Some(result));
    }
}

async fn wait_for_flight(
    mut receiver: watch::Receiver<Option<Result<FlightOutcome>>>,
) -> Result<FlightOutcome> {
    loop {
        let result = receiver.borrow().clone();
        if let Some(result) = result {
            return result;
        }
        receiver
            .changed()
            .await
            .map_err(|_| ServiceError::new(503, "WORKSPACE_OPEN_UNCERTAIN"))?;
    }
}

fn is_credential_error(error: &ServiceError) -> bool {
    matches!(
        error.code.as_str(),
        "UNAUTHENTICATED" | "INVALID_KEY" | "POLICY_DENIED" | "GUEST_EXPIRED"
    )
}

// A panic in the detached job must not leave a reservation silently reusable. The
// owner of a possibly acquired writer is unknown, so preserve the existing fail-closed
// Region recovery policy and wake every waiter.
struct FlightGuard {
    state: Arc<Mutex<State>>,
    target: String,
    victim: Option<String>,
    armed: bool,
}
impl Drop for FlightGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let state = self.state.clone();
        let target = self.target.clone();
        let victim = self.victim.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let mut state = state.lock().await;
                state.release_uncertain = true;
                state.openings = state.openings.saturating_sub(1);
                let failure = ServiceError::new(503, "WORKSPACE_RELEASE_UNCERTAIN");
                if let Some(victim) = victim {
                    complete_flight(&mut state, &victim, Err(failure.clone()));
                }
                complete_flight(&mut state, &target, Err(failure));
            });
        }
    }
}

async fn run_open(mut job: OpenJob) {
    let mut guard = FlightGuard {
        state: job.state.clone(),
        target: job.workspace_id.clone(),
        victim: job.victim.as_ref().map(|(id, _)| id.clone()),
        armed: true,
    };
    if let Some((victim, entry)) = job.victim.take() {
        let closed = entry.workspace.close().await;
        let mut state = job.state.lock().await;
        if closed.is_err() {
            state.release_uncertain = true;
        }
        let result = closed
            .map(|()| FlightOutcome::Released)
            .map_err(|_| ServiceError::new(503, "WORKSPACE_RELEASE_UNCERTAIN"));
        complete_flight(&mut state, &victim, result.clone());
        guard.victim = None;
        if let Err(error) = result {
            state.openings -= 1;
            complete_flight(&mut state, &job.workspace_id, Err(error));
            guard.armed = false;
            return;
        }
    }
    {
        let mut state = job.state.lock().await;
        if state.shutdown || state.release_uncertain {
            state.openings -= 1;
            complete_flight(
                &mut state,
                &job.workspace_id,
                Err(ServiceError::new(503, "WORKSPACE_POOL_UNAVAILABLE")),
            );
            guard.armed = false;
            return;
        }
    }
    // Never initialize, adopt, or automatically take over an existing writer.
    let repository = match Repository::open(
        job.metadata,
        &job.authority,
        &job.workspace_id,
        false,
        None,
    )
    .await
    {
        Ok(repository) => repository,
        Err(error) => {
            let mut state = job.state.lock().await;
            if matches!(
                error.code.as_str(),
                "META_COMMIT_UNKNOWN" | "META_WRITER_RELEASE_UNCERTAIN"
            ) {
                state.release_uncertain = true;
            }
            state.openings -= 1;
            complete_flight(&mut state, &job.workspace_id, Err(error));
            guard.armed = false;
            return;
        }
    };
    let workspace = Arc::new(Workspace::new_managed(repository));
    let authorization = match workspace.repository().discard_regional_keys().await {
        Ok(()) => workspace.authenticate(&job.credential).await.map(|_| ()),
        Err(error) => Err(error),
    };
    let result = match authorization {
        Err(error) => Err(error),
        Ok(_) => match job.product {
            Some(config) => workspace_product::Product::new(workspace.clone(), config)
                .await
                .map(|product| Some(Arc::new(product))),
            None => Ok(None),
        },
    };
    let product = match result {
        Ok(product) => product,
        Err(error) => {
            let release_failed = workspace.close().await.is_err();
            let mut state = job.state.lock().await;
            if release_failed {
                state.release_uncertain = true;
            }
            state.openings -= 1;
            complete_flight(&mut state, &job.workspace_id, Err(error));
            guard.armed = false;
            return;
        }
    };
    let entry = Arc::new(ManagedWorkspace { workspace, product });
    let mut state = job.state.lock().await;
    if state.shutdown || state.release_uncertain || state.cleanup.contains(&job.workspace_id) {
        drop(state);
        let release_failed = entry.workspace.close().await.is_err();
        let mut state = job.state.lock().await;
        if release_failed {
            state.release_uncertain = true;
        }
        state.openings -= 1;
        complete_flight(
            &mut state,
            &job.workspace_id,
            Err(ServiceError::new(503, "WORKSPACE_POOL_UNAVAILABLE")),
        );
        guard.armed = false;
        return;
    }
    state.entries.insert(
        job.workspace_id.clone(),
        Cached {
            entry: entry.clone(),
            used: job.sequence,
        },
    );
    state.openings -= 1;
    complete_flight(
        &mut state,
        &job.workspace_id,
        Ok(FlightOutcome::Opened(entry)),
    );
    guard.armed = false;
}

impl ManagedWorkspaces {
    /// Diagnostics must not open an inactive Workspace or delay a user request behind
    /// an internal writer acquisition. Missing or busy entries are reported as loss.
    pub(crate) async fn acquire_cached_history(
        &self,
        workspace_id: &str,
    ) -> Result<Arc<ManagedWorkspace>> {
        let state = self.state.lock().await;
        if state.shutdown
            || state.release_uncertain
            || state.cleanup.contains(workspace_id)
            || state.flights.contains_key(workspace_id)
        {
            return Err(ServiceError::new(503, "WORKSPACE_POOL_BUSY"));
        }
        state
            .entries
            .get(workspace_id)
            .map(|cached| cached.entry.clone())
            .ok_or_else(|| ServiceError::new(503, "WORKSPACE_POOL_UNAVAILABLE"))
    }
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
            state: Arc::new(Mutex::new(State::default())),
            history_slot: Arc::new(Semaphore::new(1)),
        })
    }

    /// Only the trusted Region history scheduler may select this Workspace. Customer
    /// requests still use `acquire`, which authenticates every lease.
    pub(crate) async fn acquire_history_maintenance(
        self: &Arc<Self>,
        workspace_id: &str,
    ) -> Result<HistoryLease> {
        if !uuid::Uuid::parse_str(workspace_id).is_ok_and(|id| id.to_string() == workspace_id) {
            return Err(ServiceError::new(404, "WORKSPACE_NOT_FOUND"));
        }
        let mut state = self.state.lock().await;
        if state.shutdown
            || state.release_uncertain
            || state.cleanup.contains(workspace_id)
            || state.flights.contains_key(workspace_id)
        {
            return Err(ServiceError::new(409, "WORKSPACE_POOL_BUSY"));
        }
        if let Some(entry) = state
            .entries
            .get(workspace_id)
            .map(|cached| cached.entry.clone())
        {
            return Ok(HistoryLease {
                entry: Some(entry),
                pool: self.clone(),
                workspace_id: workspace_id.into(),
                temporary: false,
                permit: None,
            });
        }
        let permit = self
            .history_slot
            .clone()
            .try_acquire_owned()
            .map_err(|_| ServiceError::new(429, "WORKSPACE_POOL_BUSY"))?;
        let (signal, _) = watch::channel(None);
        state.flights.insert(workspace_id.to_owned(), signal);
        drop(state);
        let pool = self.clone();
        let id = workspace_id.to_owned();
        // The detached job owns the reservation if its caller is cancelled. If nobody
        // receives its lease, Drop releases the writer and reservation after the open.
        tokio::spawn(async move {
            let mut guard = HistoryOpenGuard {
                pool: pool.clone(),
                workspace_id: id.clone(),
                armed: true,
            };
            let opened =
                Repository::open(pool.metadata.clone(), &pool.authority, &id, false, None).await;
            match opened {
                Ok(repository) => {
                    let workspace = Arc::new(Workspace::new_managed(repository));
                    let blocked = {
                        let state = pool.state.lock().await;
                        state.shutdown || state.release_uncertain
                    };
                    if blocked {
                        let release_failed = workspace.close().await.is_err();
                        let mut state = pool.state.lock().await;
                        if release_failed {
                            state.release_uncertain = true;
                        }
                        complete_flight(
                            &mut state,
                            &id,
                            Err(ServiceError::new(503, "WORKSPACE_POOL_UNAVAILABLE")),
                        );
                        guard.armed = false;
                        return Err(ServiceError::new(503, "WORKSPACE_POOL_UNAVAILABLE"));
                    }
                    guard.armed = false;
                    Ok(HistoryLease {
                        entry: Some(Arc::new(ManagedWorkspace {
                            workspace,
                            product: None,
                        })),
                        pool,
                        workspace_id: id,
                        temporary: true,
                        permit: Some(permit),
                    })
                }
                Err(failure) => {
                    let mut state = pool.state.lock().await;
                    if matches!(
                        failure.code.as_str(),
                        "META_COMMIT_UNKNOWN" | "META_WRITER_RELEASE_UNCERTAIN"
                    ) {
                        state.release_uncertain = true;
                    }
                    complete_flight(&mut state, &id, Err(failure.clone()));
                    guard.armed = false;
                    Err(failure)
                }
            }
        })
        .await
        .map_err(|_| ServiceError::new(503, "WORKSPACE_POOL_UNAVAILABLE"))?
    }

    async fn release_history_maintenance(
        &self,
        workspace_id: &str,
        entry: Arc<ManagedWorkspace>,
    ) -> Result<()> {
        if Arc::strong_count(&entry) != 1 {
            let failure = ServiceError::new(503, "WORKSPACE_RELEASE_UNCERTAIN");
            let mut state = self.state.lock().await;
            state.release_uncertain = true;
            complete_flight(&mut state, workspace_id, Err(failure.clone()));
            return Err(failure);
        }
        let result = entry
            .workspace
            .close()
            .await
            .map_err(|_| ServiceError::new(503, "WORKSPACE_RELEASE_UNCERTAIN"));
        let mut state = self.state.lock().await;
        if result.is_err() {
            state.release_uncertain = true;
        }
        complete_flight(
            &mut state,
            workspace_id,
            result.clone().map(|_| FlightOutcome::Released),
        );
        result
    }

    async fn authorize_lease(
        &self,
        workspace_id: &str,
        entry: Arc<ManagedWorkspace>,
        credential: &Credential,
    ) -> Result<Arc<ManagedWorkspace>> {
        entry.workspace.authenticate(credential).await?;
        let mut state = self.state.lock().await;
        if state.shutdown || state.release_uncertain {
            return Err(ServiceError::new(503, "WORKSPACE_POOL_UNAVAILABLE"));
        }
        if state.cleanup.contains(workspace_id) {
            return Err(ServiceError::new(401, "UNAUTHENTICATED"));
        }
        state.sequence = state.sequence.saturating_add(1);
        let sequence = state.sequence;
        let cached = state
            .entries
            .get_mut(workspace_id)
            .ok_or_else(|| ServiceError::new(503, "WORKSPACE_POOL_UNAVAILABLE"))?;
        if !Arc::ptr_eq(&cached.entry, &entry) {
            return Err(ServiceError::new(503, "WORKSPACE_POOL_UNAVAILABLE"));
        }
        cached.used = cached.used.max(sequence);
        Ok(entry)
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
                && !matches!(credential,Credential::Scoped(value) if value.workspace_id()==workspace_id)
        {
            return Err(ServiceError::new(401, "UNAUTHENTICATED"));
        }
        loop {
            let mut state = self.state.lock().await;
            if state.shutdown || state.release_uncertain {
                return Err(ServiceError::new(503, "WORKSPACE_POOL_UNAVAILABLE"));
            }
            if state.cleanup.contains(workspace_id) {
                return Err(ServiceError::new(401, "UNAUTHENTICATED"));
            }
            if let Some(flight) = state.flights.get(workspace_id) {
                let receiver = flight.subscribe();
                drop(state);
                match wait_for_flight(receiver).await {
                    Ok(FlightOutcome::Released) => continue,
                    Ok(FlightOutcome::Opened(entry)) => {
                        return self.authorize_lease(workspace_id, entry, credential).await;
                    }
                    Err(error) if is_credential_error(&error) => continue,
                    Err(error) => return Err(error),
                }
            }
            state.sequence = state.sequence.saturating_add(1);
            let sequence = state.sequence;
            if let Some(entry) = state
                .entries
                .get(workspace_id)
                .map(|cached| cached.entry.clone())
            {
                drop(state);
                return self.authorize_lease(workspace_id, entry, credential).await;
            }
            let victim = if state.entries.len() + state.openings >= self.limit {
                let victim = state
                    .entries
                    .iter()
                    .filter(|(_, cached)| Arc::strong_count(&cached.entry) == 1)
                    .min_by_key(|(_, cached)| cached.used)
                    .map(|(id, _)| id.clone())
                    .ok_or_else(|| ServiceError::new(429, "WORKSPACE_POOL_BUSY"))?;
                let cached = state.entries.remove(&victim).expect("selected cache entry");
                let (signal, _) = watch::channel(None);
                state.flights.insert(victim.clone(), signal);
                Some((victim, cached.entry))
            } else {
                None
            };
            let (signal, receiver) = watch::channel(None);
            state.flights.insert(workspace_id.into(), signal);
            state.openings += 1;
            let job = OpenJob {
                state: self.state.clone(),
                metadata: self.metadata.clone(),
                authority: self.authority.clone(),
                product: self.product.clone(),
                workspace_id: workspace_id.into(),
                credential: credential.clone(),
                sequence,
                victim,
            };
            // The job owns the reservation even if the HTTP request is cancelled. A cancelled
            // caller cannot strand an acquired writer or allow another open to race it.
            tokio::spawn(run_open(job));
            drop(state);
            match wait_for_flight(receiver).await? {
                FlightOutcome::Opened(entry) => {
                    return self.authorize_lease(workspace_id, entry, credential).await;
                }
                FlightOutcome::Released => continue,
            }
        }
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
        if state.flights.contains_key(workspace_id) {
            return Err(ServiceError::new(409, "WORKSPACE_POOL_BUSY"));
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
        drop(state);
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
                self.state.lock().await.cleanup.remove(workspace_id);
                return Err(error);
            }
        };
        if let Err(error) = repository.discard_regional_keys().await {
            let _ = repository.close().await;
            self.state.lock().await.cleanup.remove(workspace_id);
            return Err(error);
        }
        let workspace = Arc::new(Workspace::new_managed(repository));
        let product = if let Some(config) = self.product.clone() {
            match workspace_product::Product::new(workspace.clone(), config).await {
                Ok(value) => Some(Arc::new(value)),
                Err(error) => {
                    let failed = workspace.close().await.is_err();
                    let mut state = self.state.lock().await;
                    if failed {
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
        let state = self.state.lock().await;
        if !state.cleanup.contains(workspace_id) || Arc::strong_count(&entry) != 1 {
            return Err(ServiceError::new(409, "WORKSPACE_POOL_BUSY"));
        }
        drop(state);
        let result = entry.workspace.close().await;
        let mut state = self.state.lock().await;
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
        if !state.cleanup.is_empty()
            || !state.flights.is_empty()
            || state
                .entries
                .values()
                .any(|cached| Arc::strong_count(&cached.entry) != 1)
        {
            return Err(ServiceError::new(409, "WORKSPACE_POOL_BUSY"));
        }
        let entries = std::mem::take(&mut state.entries);
        drop(state);
        let mut failed = false;
        for cached in entries.into_values() {
            if cached.entry.workspace.close().await.is_err() {
                failed = true;
            }
        }
        if failed {
            self.state.lock().await.release_uncertain = true;
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
        pause_release: AtomicBool,
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
                            && keys == ["system/writer"]
                            && self.pause_release.swap(false, Ordering::AcqRel)
                        {
                            self.paused.notify_one();
                            self.resume.notified().await;
                        }
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
            pause_release: AtomicBool::new(false),
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
        drop(other);
        let cleanup = pool.acquire_cleanup(A).await.unwrap();
        metadata.pause_release.store(true, Ordering::Release);
        let closing = tokio::spawn({
            let pool = pool.clone();
            async move { pool.release_cleanup(A, cleanup).await }
        });
        metadata.paused.notified().await;
        let other = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            pool.acquire(B, &credential(B)),
        )
        .await
        .expect("unrelated Workspace waited for cleanup I/O")
        .unwrap();
        assert_eq!(other.workspace().repository().workspace_id(), B);
        metadata.resume.notify_one();
        closing.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn history_maintenance_shares_live_lease_and_never_retires_cold_workspace_keys() {
        let metadata = Arc::new(MetadataGate {
            pause: AtomicBool::new(false),
            pause_release: AtomicBool::new(false),
            paused: Notify::new(),
            resume: Notify::new(),
        });
        let pool = Arc::new(ManagedWorkspaces::new(metadata.clone(), REGION, None, 1).unwrap());
        let repository = Repository::open(metadata, REGION, A, false, None)
            .await
            .unwrap();
        let entry = Arc::new(ManagedWorkspace {
            workspace: Arc::new(Workspace::new_managed(repository)),
            product: None,
        });
        pool.state.lock().await.entries.insert(
            A.into(),
            Cached {
                entry: entry.clone(),
                used: 0,
            },
        );
        let cached = pool.acquire_cached_history(A).await.unwrap();
        assert!(Arc::ptr_eq(&cached, &entry));
        drop(cached);
        assert_eq!(
            pool.acquire_cached_history(B).await.err().unwrap().code,
            "WORKSPACE_POOL_UNAVAILABLE"
        );
        assert!(!pool.state.lock().await.flights.contains_key(B));
        let live = pool.acquire_history_maintenance(A).await.unwrap();
        assert!(Arc::ptr_eq(live.entry.as_ref().unwrap(), &entry));
        let cold = pool.acquire_history_maintenance(B).await.unwrap();
        assert_eq!(
            pool.acquire_cached_history(B).await.err().unwrap().code,
            "WORKSPACE_POOL_BUSY"
        );
        assert_eq!(cold.workspace().repository().workspace_id(), B);
        assert_eq!(
            pool.acquire_history_maintenance("not-a-workspace")
                .await
                .err()
                .unwrap()
                .code,
            "WORKSPACE_NOT_FOUND"
        );
        assert_eq!(
            pool.acquire(B, &credential(A)).await.err().unwrap().code,
            "UNAUTHENTICATED"
        );
        let receiver = pool.state.lock().await.flights.get(B).unwrap().subscribe();
        let mut waiter = tokio::spawn(wait_for_flight(receiver));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut waiter)
                .await
                .is_err()
        );
        cold.release().await.unwrap();
        assert!(matches!(
            waiter.await.unwrap().unwrap(),
            FlightOutcome::Released
        ));
        assert!(!pool.state.lock().await.flights.contains_key(B));
        live.release().await.unwrap();
        drop(entry);
        pool.close().await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_cold_history_open_releases_its_writer_and_slot() {
        let metadata = Arc::new(MetadataGate {
            pause: AtomicBool::new(false),
            pause_release: AtomicBool::new(true),
            paused: Notify::new(),
            resume: Notify::new(),
        });
        let pool = Arc::new(ManagedWorkspaces::new(metadata.clone(), REGION, None, 1).unwrap());
        let opening = tokio::spawn({
            let pool = pool.clone();
            async move { pool.acquire_history_maintenance(A).await }
        });
        metadata.paused.notified().await;
        opening.abort();
        metadata.resume.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let state = pool.state.lock().await;
                if !state.flights.contains_key(A) && pool.history_slot.available_permits() == 1 {
                    assert!(!state.release_uncertain);
                    break;
                }
                drop(state);
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled maintenance stranded a writer");
        pool.close().await.unwrap();
    }

    #[tokio::test]
    async fn history_open_during_shutdown_releases_its_writer() {
        let metadata = Arc::new(MetadataGate {
            pause: AtomicBool::new(false),
            pause_release: AtomicBool::new(true),
            paused: Notify::new(),
            resume: Notify::new(),
        });
        let pool = Arc::new(ManagedWorkspaces::new(metadata.clone(), REGION, None, 1).unwrap());
        let opening = tokio::spawn({
            let pool = pool.clone();
            async move { pool.acquire_history_maintenance(A).await }
        });
        metadata.paused.notified().await;
        assert_eq!(pool.close().await.unwrap_err().code, "WORKSPACE_POOL_BUSY");
        metadata.resume.notify_one();
        assert_eq!(
            opening.await.unwrap().err().unwrap().code,
            "WORKSPACE_POOL_UNAVAILABLE"
        );
        let state = pool.state.lock().await;
        assert!(!state.flights.contains_key(A));
        assert!(!state.release_uncertain);
        assert_eq!(pool.history_slot.available_permits(), 1);
    }
}

#[cfg(test)]
mod pool_concurrency_tests {
    use super::*;
    use serde_json::{Value, json};
    use std::{
        collections::{BTreeMap, BTreeSet},
        sync::{
            Mutex as StdMutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
    };
    use tokio::sync::Notify;
    use workspace_contracts::{Call, MetaRequest};

    const REGION: &str = "region:test";
    const USER: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ORG: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    fn id(n: u128) -> String {
        uuid::Uuid::from_u128(n + 1).to_string()
    }
    fn credential(workspace: &str) -> Credential {
        Credential::SessionOwner {
            id: USER.into(),
            actor: "Test".into(),
            workspace_id: workspace.into(),
            policy_generation: Some(1),
            expires_at: chrono::Utc::now().timestamp() + 3600,
            revoked: Arc::new(AtomicBool::new(false)),
        }
    }
    struct WriterGate {
        seeded: BTreeSet<String>,
        writers: StdMutex<BTreeMap<String, Value>>,
        claims: StdMutex<BTreeMap<String, usize>>,
        slow_id: String,
        pause_claim: AtomicBool,
        pause_release: AtomicBool,
        unknown_release: AtomicBool,
        unknown_claim: AtomicBool,
        entered: Notify,
        resume: Notify,
        opened: AtomicUsize,
    }
    impl WriterGate {
        fn new(count: usize, slow_id: String) -> Self {
            Self {
                seeded: (0..count).map(|n| id(n as u128)).collect(),
                writers: StdMutex::new(BTreeMap::new()),
                claims: StdMutex::new(BTreeMap::new()),
                slow_id,
                pause_claim: AtomicBool::new(false),
                pause_release: AtomicBool::new(false),
                unknown_release: AtomicBool::new(false),
                unknown_claim: AtomicBool::new(false),
                entered: Notify::new(),
                resume: Notify::new(),
                opened: AtomicUsize::new(0),
            }
        }
        fn claim_count(&self, id: &str) -> usize {
            *self.claims.lock().unwrap().get(id).unwrap_or(&0)
        }
    }
    impl Metadata for WriterGate {
        fn health(&self) -> Call<'_> {
            Box::pin(async { Ok(json!({"authorityId":REGION,"capabilities":["recordsV1"]})) })
        }
        fn execute(&self, request: MetaRequest) -> Call<'_> {
            Box::pin(async move {
                match request {
                    MetaRequest::Get { scope, keys, .. } => {
                        let values = keys.into_iter().map(|key| {
                            let value = match key.as_str() {
                                "system/writer" => self.writers.lock().unwrap().get(&scope.owner_id).cloned().unwrap_or(Value::Null),
                                "state/workspace" if self.seeded.contains(&scope.owner_id) => json!({"version":"core","value":{"id":scope.owner_id,"defaultRegionId":REGION}}),
                                "ownership/onboarding" if self.seeded.contains(&scope.owner_id) => json!({"version":"onboarding","value":{"workspaceId":scope.owner_id,"userId":USER,"organizationId":ORG}}),
                                "owner-policy" if self.seeded.contains(&scope.owner_id) => json!({"version":"policy","value":{"workspaceId":scope.owner_id,"regionId":REGION,"userId":USER,"organizationId":ORG,"generation":1,"denied":false,"identity":{"kind":"oidc","issuer":"issuer","subject":"subject"}}}),
                                _ => Value::Null,
                            };
                            (key,value)
                        }).collect::<serde_json::Map<_,_>>();
                        Ok(json!({"records":values}))
                    }
                    MetaRequest::Commit {
                        scope,
                        guard,
                        changes,
                        ..
                    } => {
                        let change = changes.first().expect("writer change");
                        assert_eq!(change["key"], "system/writer");
                        let deleting = change["delete"] == true;
                        if scope.owner_id == self.slow_id
                            && (if deleting {
                                self.pause_release.swap(false, Ordering::AcqRel)
                            } else {
                                self.pause_claim.swap(false, Ordering::AcqRel)
                            })
                        {
                            self.entered.notify_one();
                            self.resume.notified().await;
                        }
                        let mut writers = self.writers.lock().unwrap();
                        let prior = writers.get(&scope.owner_id).cloned().unwrap_or(Value::Null);
                        let version = prior.get("version").cloned().unwrap_or(Value::Null);
                        if version != change["expectedVersion"] {
                            return Err(ServiceError::new(409, "META_CONFLICT"));
                        }
                        if let Some(guard) = guard
                            && prior["value"]["ownerId"] != guard.owner_id
                        {
                            return Err(ServiceError::new(409, "META_WRITER_FENCED"));
                        }
                        if deleting {
                            writers.remove(&scope.owner_id);
                            if self.unknown_release.swap(false, Ordering::AcqRel) {
                                return Err(ServiceError::new(503, "META_COMMIT_UNKNOWN"));
                            }
                        } else {
                            assert!(
                                prior.is_null() || !change["expectedVersion"].is_null(),
                                "unfenced writer replacement"
                            );
                            writers.insert(scope.owner_id.clone(),json!({"version":uuid::Uuid::new_v4().to_string(),"value":change["value"]}));
                            *self
                                .claims
                                .lock()
                                .unwrap()
                                .entry(scope.owner_id)
                                .or_default() += 1;
                            self.opened.fetch_add(1, Ordering::AcqRel);
                            if self.unknown_claim.swap(false, Ordering::AcqRel) {
                                return Err(ServiceError::new(503, "META_COMMIT_UNKNOWN"));
                            }
                        }
                        Ok(json!({}))
                    }
                    MetaRequest::List {
                        scope,
                        guard,
                        prefix,
                        ..
                    } => {
                        assert!(prefix == "state/keys/" || prefix == "indexes/key-digest/");
                        let writers = self.writers.lock().unwrap();
                        assert_eq!(
                            writers[&scope.owner_id]["value"]["ownerId"],
                            guard.expect("fenced key cleanup").owner_id
                        );
                        Ok(json!({"records":[],"nextCursor":null}))
                    }
                    _ => panic!("unexpected metadata request"),
                }
            })
        }
    }
    fn pool(gate: Arc<WriterGate>, limit: usize) -> Arc<ManagedWorkspaces> {
        Arc::new(ManagedWorkspaces::new(gate, REGION, None, limit).unwrap())
    }

    #[tokio::test]
    async fn cold_open_does_not_block_an_unrelated_workspace() {
        let a = id(0);
        let b = id(1);
        let gate = Arc::new(WriterGate::new(2, a.clone()));
        gate.pause_claim.store(true, Ordering::Release);
        let pool = pool(gate.clone(), 2);
        let pending = tokio::spawn({
            let pool = pool.clone();
            let a = a.clone();
            async move { pool.acquire(&a, &credential(&a)).await }
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), gate.entered.notified())
            .await
            .expect("victim release did not start");
        let other = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            pool.acquire(&b, &credential(&b)),
        )
        .await
        .expect("unrelated open blocked")
        .unwrap();
        assert_eq!(other.workspace().repository().workspace_id(), b);
        gate.resume.notify_one();
        let first = pending.await.unwrap().unwrap();
        assert_eq!(first.workspace().repository().workspace_id(), a);
        assert_eq!(gate.claim_count(&a), 1);
        assert_eq!(gate.claim_count(&b), 1);
    }

    #[tokio::test]
    async fn same_workspace_is_single_flight_and_caller_cancellation_does_not_strand_writer() {
        let a = id(0);
        let gate = Arc::new(WriterGate::new(1, a.clone()));
        gate.pause_claim.store(true, Ordering::Release);
        let pool = pool(gate.clone(), 2);
        let first = tokio::spawn({
            let pool = pool.clone();
            let a = a.clone();
            async move { pool.acquire(&a, &credential(&a)).await }
        });
        gate.entered.notified().await;
        let mut callers = Vec::new();
        for _ in 0..8 {
            callers.push(tokio::spawn({
                let pool = pool.clone();
                let a = a.clone();
                async move { pool.acquire(&a, &credential(&a)).await }
            }));
        }
        let revoked = credential(&a);
        revoked.revoke();
        let denied = tokio::spawn({
            let pool = pool.clone();
            let a = a.clone();
            async move { pool.acquire(&a, &revoked).await }
        });
        first.abort();
        gate.resume.notify_one();
        let mut entries = Vec::new();
        for caller in callers {
            entries.push(caller.await.unwrap().unwrap());
        }
        assert!(entries.iter().all(|entry| Arc::ptr_eq(&entries[0], entry)));
        assert_eq!(gate.claim_count(&a), 1);
        assert!(denied.await.unwrap().is_err());
        let revoked = credential(&a);
        revoked.revoke();
        assert!(pool.acquire(&a, &revoked).await.is_err());
    }

    #[tokio::test]
    async fn rejected_opener_does_not_grant_or_block_another_caller() {
        let a = id(0);
        let gate = Arc::new(WriterGate::new(1, a.clone()));
        gate.pause_claim.store(true, Ordering::Release);
        let pool = pool(gate.clone(), 2);
        let revoked = credential(&a);
        revoked.revoke();
        let invalid = tokio::spawn({
            let pool = pool.clone();
            let a = a.clone();
            async move { pool.acquire(&a, &revoked).await }
        });
        gate.entered.notified().await;
        let valid = tokio::spawn({
            let pool = pool.clone();
            let a = a.clone();
            async move { pool.acquire(&a, &credential(&a)).await }
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if pool
                    .state
                    .lock()
                    .await
                    .flights
                    .get(&a)
                    .is_some_and(|flight| flight.receiver_count() >= 2)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("valid caller did not join the pending open");
        gate.resume.notify_one();
        assert!(invalid.await.unwrap().is_err());
        let entry = valid.await.unwrap().unwrap();
        assert_eq!(entry.workspace().repository().workspace_id(), a);
        assert_eq!(gate.claim_count(&a), 2);
    }

    #[tokio::test]
    async fn eviction_waits_for_one_writer_without_blocking_other_cached_workspaces() {
        let a = id(0);
        let b = id(1);
        let c = id(2);
        let gate = Arc::new(WriterGate::new(3, a.clone()));
        let pool = pool(gate.clone(), 2);
        drop(pool.acquire(&a, &credential(&a)).await.unwrap());
        let keep_b = pool.acquire(&b, &credential(&b)).await.unwrap();
        gate.pause_release.store(true, Ordering::Release);
        let opening = tokio::spawn({
            let pool = pool.clone();
            let c = c.clone();
            async move { pool.acquire(&c, &credential(&c)).await }
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), gate.entered.notified())
            .await
            .expect("victim release did not start");
        let other = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            pool.acquire(&b, &credential(&b)),
        )
        .await
        .expect("unrelated cache hit blocked")
        .unwrap();
        let mut reopening = tokio::spawn({
            let pool = pool.clone();
            let a = a.clone();
            async move { pool.acquire(&a, &credential(&a)).await }
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(30), &mut reopening)
                .await
                .is_err()
        );
        assert_eq!(gate.claim_count(&a), 1);
        gate.resume.notify_one();
        let opened = tokio::time::timeout(std::time::Duration::from_secs(2), opening)
            .await
            .expect("new open did not finish")
            .unwrap()
            .unwrap();
        drop(opened);
        drop(other);
        drop(keep_b);
        let resumed = tokio::time::timeout(std::time::Duration::from_secs(2), reopening)
            .await
            .expect("victim reopen did not finish")
            .unwrap();
        let _again = match resumed {
            Ok(entry) => entry,
            Err(error) if error.code == "WORKSPACE_POOL_BUSY" => {
                pool.acquire(&a, &credential(&a)).await.unwrap()
            }
            Err(error) => panic!("unexpected reopen error: {error}"),
        };
        assert_eq!(gate.claim_count(&a), 2);
    }

    #[tokio::test]
    async fn uncertain_writer_release_fails_closed_without_reopening() {
        let a = id(0);
        let b = id(1);
        let gate = Arc::new(WriterGate::new(2, a.clone()));
        let pool = pool(gate.clone(), 1);
        drop(pool.acquire(&a, &credential(&a)).await.unwrap());
        gate.unknown_release.store(true, Ordering::Release);
        assert_eq!(
            pool.acquire(&b, &credential(&b)).await.err().unwrap().code,
            "WORKSPACE_RELEASE_UNCERTAIN"
        );
        assert_eq!(
            pool.acquire(&a, &credential(&a)).await.err().unwrap().code,
            "WORKSPACE_POOL_UNAVAILABLE"
        );
        assert_eq!(gate.claim_count(&a), 1);
        assert_eq!(gate.claim_count(&b), 0);
        drop(pool);
        let restarted = self::pool(gate.clone(), 1);
        let entry = restarted.acquire(&a, &credential(&a)).await.unwrap();
        drop(entry);
        restarted.close().await.unwrap();
    }

    #[tokio::test]
    async fn unknown_writer_claim_requires_explicit_owner_recovery() {
        let a = id(0);
        let b = id(1);
        let gate = Arc::new(WriterGate::new(2, a.clone()));
        gate.unknown_claim.store(true, Ordering::Release);
        let pool = pool(gate.clone(), 2);
        assert_eq!(
            pool.acquire(&a, &credential(&a)).await.err().unwrap().code,
            "META_COMMIT_UNKNOWN"
        );
        assert_eq!(
            pool.acquire(&b, &credential(&b)).await.err().unwrap().code,
            "WORKSPACE_POOL_UNAVAILABLE"
        );
        let owner = gate.writers.lock().unwrap()[&a]["value"]["ownerId"]
            .as_str()
            .unwrap()
            .to_owned();
        drop(pool);
        let recovered = Repository::open(gate.clone(), REGION, &a, false, Some(&owner))
            .await
            .unwrap();
        recovered.close().await.unwrap();
        assert!(!gate.writers.lock().unwrap().contains_key(&a));
    }

    #[tokio::test]
    async fn failed_initialization_with_uncertain_release_fences_the_pool() {
        let existing = id(0);
        let missing = id(10);
        let gate = Arc::new(WriterGate::new(1, missing.clone()));
        gate.unknown_release.store(true, Ordering::Release);
        let pool = pool(gate.clone(), 2);
        assert_eq!(
            pool.acquire(&missing, &credential(&missing))
                .await
                .err()
                .unwrap()
                .code,
            "META_WRITER_RELEASE_UNCERTAIN"
        );
        assert_eq!(
            pool.acquire(&existing, &credential(&existing))
                .await
                .err()
                .unwrap()
                .code,
            "WORKSPACE_POOL_UNAVAILABLE"
        );
    }

    #[tokio::test]
    async fn shutdown_during_open_does_not_leave_a_writer() {
        let a = id(0);
        let gate = Arc::new(WriterGate::new(1, a.clone()));
        gate.pause_claim.store(true, Ordering::Release);
        let pool = pool(gate.clone(), 1);
        let opening = tokio::spawn({
            let pool = pool.clone();
            let a = a.clone();
            async move { pool.acquire(&a, &credential(&a)).await }
        });
        gate.entered.notified().await;
        assert_eq!(pool.close().await.unwrap_err().code, "WORKSPACE_POOL_BUSY");
        gate.resume.notify_one();
        assert_eq!(
            opening.await.unwrap().err().unwrap().code,
            "WORKSPACE_POOL_UNAVAILABLE"
        );
        assert!(!gate.writers.lock().unwrap().contains_key(&a));
        pool.close().await.unwrap();
    }

    #[tokio::test]
    async fn ten_thousand_cold_workspaces_and_sparse_activity() {
        let gate = Arc::new(WriterGate::new(10_000, id(0)));
        let pool = pool(gate.clone(), 8);
        let hot = [id(2), id(500), id(9_999)];
        let mut entries = Vec::new();
        for workspace in &hot {
            entries.push(
                pool.acquire(workspace, &credential(workspace))
                    .await
                    .unwrap(),
            );
        }
        let mut callers = Vec::new();
        for worker in 0..4 {
            let pool = pool.clone();
            let hot = hot.clone();
            callers.push(tokio::spawn(async move {
                for n in 0..25 {
                    let workspace = &hot[(worker + n) % hot.len()];
                    let entry = pool
                        .acquire(workspace, &credential(workspace))
                        .await
                        .unwrap();
                    assert_eq!(entry.workspace().repository().workspace_id(), *workspace);
                }
            }));
        }
        for caller in callers {
            caller.await.unwrap();
        }
        assert_eq!(gate.seeded.len(), 10_000);
        assert_eq!(gate.opened.load(Ordering::Acquire), 3);
        assert_eq!(gate.writers.lock().unwrap().len(), 3);
        drop(entries);
        pool.close().await.unwrap();
        assert!(gate.writers.lock().unwrap().is_empty());
    }
}
