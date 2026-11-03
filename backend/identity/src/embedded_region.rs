//! In-process Region control implementation for a co-located Global/Region deployment.
//! It must run inside the Region trust boundary. A separately deployed Global must use an
//! authenticated Region control service, not connect to the Region's Meta store directly.

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{future::Future, pin::Pin, sync::Arc};
use uuid::Uuid;
use workspace_contracts::{MetaRequest, Metadata, Result, Scope};

use crate::{
    cleanup::Queue,
    error,
    onboarding::{Acknowledgement, Command, RegionControl},
    regional::{OwnerIdentity, Policies},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    registration: crate::Registration,
    policy_hash: String,
    created_at: String,
    ready: bool,
}

pub struct EmbeddedRegion {
    metadata: Arc<dyn Metadata>,
    authority: String,
    policies: Policies,
    cleanup: Queue,
}

fn mutation(operation_id: &str, stage: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"workspace-region-init\0v1\0");
    hash.update(stage.as_bytes());
    hash.update(b"\0");
    hash.update(operation_id.as_bytes());
    let digest = hash.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    Uuid::from_bytes(bytes).to_string()
}

fn policy_hash(command: &Command) -> Result<String> {
    let bytes =
        serde_json::to_vec(&command.policy).map_err(|_| error(503, "REGION_INIT_CORRUPT"))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

impl EmbeddedRegion {
    pub async fn open(metadata: Arc<dyn Metadata>, authority: &str) -> Result<Self> {
        let policies = Policies::open(metadata.clone(), authority).await?;
        let cleanup = Queue::open(metadata.clone(), authority).await?;
        Ok(Self {
            metadata,
            authority: authority.into(),
            policies,
            cleanup,
        })
    }

    fn scope(&self, command: &Command, family: &str) -> Scope {
        Scope {
            authority_id: self.authority.clone(),
            owner_kind: "workspace".into(),
            owner_id: command.registration.workspace_id.clone(),
            family: family.into(),
            partition_id: "primary".into(),
        }
    }

    fn validate(&self, command: &Command) -> Result<()> {
        let r = &command.registration;
        let p = &command.policy;
        if r.region_id != self.authority
            || p.region_id != self.authority
            || p.workspace_id != r.workspace_id
            || p.organization_id != r.organization_id
            || p.user_id != r.user_id
            || p.generation != 1
            || p.denied
            || [
                &r.workspace_id,
                &r.organization_id,
                &r.user_id,
                &r.operation_id,
            ]
            .iter()
            .any(|id| Uuid::parse_str(id).is_err())
        {
            return Err(error(400, "REGION_COMMAND_INVALID"));
        }
        crate::regional::validate(p, &self.authority)?;
        Ok(())
    }

    async fn get(&self, scope: &Scope, keys: &[&str]) -> Result<Value> {
        let result = self
            .metadata
            .execute(MetaRequest::Get {
                scope: scope.clone(),
                guard: None,
                keys: keys.iter().map(|s| (*s).into()).collect(),
            })
            .await?;
        let records = result
            .get("records")
            .filter(|v| v.is_object())
            .ok_or_else(|| error(503, "REGION_INIT_CORRUPT"))?;
        if !keys.iter().all(|key| records.get(*key).is_some()) {
            return Err(error(503, "REGION_INIT_CORRUPT"));
        }
        Ok(records.clone())
    }

    async fn commit(&self, scope: &Scope, mutation_id: &str, changes: Vec<Value>) -> Result<()> {
        let result = self
            .metadata
            .execute(MetaRequest::Commit {
                scope: scope.clone(),
                guard: None,
                mutation_id: mutation_id.into(),
                changes,
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

    async fn intent(&self, command: &Command) -> Result<(Intent, String)> {
        let scope = self.scope(command, "regional-init");
        let expected_hash = policy_hash(command)?;
        for _ in 0..8 {
            let records = self.get(&scope, &["intent"]).await?;
            let record = &records["intent"];
            if !record.is_null() {
                let intent: Intent = serde_json::from_value(record["value"].clone())
                    .map_err(|_| error(503, "REGION_INIT_CORRUPT"))?;
                if intent.registration != command.registration
                    || intent.policy_hash != expected_hash
                {
                    return Err(error(409, "REGION_INIT_OWNER_MISMATCH"));
                }
                let version = record["version"]
                    .as_str()
                    .ok_or_else(|| error(503, "REGION_INIT_CORRUPT"))?;
                return Ok((intent, version.into()));
            }
            let value = Intent {
                registration: command.registration.clone(),
                policy_hash: expected_hash.clone(),
                created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
                ready: false,
            };
            let result = self
                .commit(
                    &scope,
                    &mutation(&command.registration.operation_id, "intent"),
                    vec![json!({"key":"intent","expectedVersion":null,"value":value})],
                )
                .await;
            match result {
                Ok(()) => continue,
                Err(e) if e.code == "META_CONFLICT" || e.code == "META_MUTATION_MISMATCH" => {
                    continue;
                }
                Err(e) => return Err(e),
            }
        }
        Err(error(503, "REGION_INIT_CONFLICT"))
    }

    async fn ensure_workspace(&self, command: &Command, intent: &Intent) -> Result<()> {
        let scope = self.scope(command, "workspace");
        let keys = [
            "state/workspace",
            "state/profile",
            "state/queryCount",
            "ownership/onboarding",
        ];
        let owner = json!({"workspaceId":command.registration.workspace_id,"organizationId":command.registration.organization_id,
            "userId":command.registration.user_id,"operationId":command.registration.operation_id});
        for _ in 0..8 {
            let records = self.get(&scope, &keys).await?;
            let empty = keys.iter().filter(|key| records[**key].is_null()).count();
            if empty == 0 {
                if records["ownership/onboarding"]["value"] != owner
                    || records["state/workspace"]["value"]["id"]
                        != command.registration.workspace_id
                    || !records["state/profile"]["value"].is_object()
                    || !records["state/queryCount"]["value"].is_number()
                {
                    return Err(error(409, "REGION_WORKSPACE_OWNER_MISMATCH"));
                }
                return Ok(());
            }
            if empty != keys.len() {
                return Err(error(409, "REGION_WORKSPACE_OWNER_MISMATCH"));
            }
            let workspace = json!({"id":command.registration.workspace_id,"name":"My Workspace","description":"","plan":"Free","createdAt":intent.created_at});
            let changes = vec![
                json!({"key":"state/workspace","expectedVersion":null,"value":workspace}),
                json!({"key":"state/profile","expectedVersion":null,"value":{"name":"Developer","email":"","role":"Owner"}}),
                json!({"key":"state/queryCount","expectedVersion":null,"value":0}),
                json!({"key":"ownership/onboarding","expectedVersion":null,"value":owner}),
                workspace_contracts::initial_resource_index(),
            ];
            match self
                .commit(
                    &scope,
                    &mutation(&command.registration.operation_id, "workspace"),
                    changes,
                )
                .await
            {
                // A successful conditional commit proves this exact owner initialized the
                // empty Workspace. A conflict still reloads and verifies the stored owner.
                Ok(()) => return Ok(()),
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) => return Err(e),
            }
        }
        Err(error(503, "REGION_INIT_CONFLICT"))
    }

    async fn initialize_inner(&self, command: &Command) -> Result<Acknowledgement> {
        self.validate(command)?;
        let (intent, _) = self.intent(command).await?;
        if !intent.ready {
            self.ensure_workspace(command, &intent).await?;
        }
        self.policies
            .install(&command.policy, &command.registration.operation_id)
            .await?;
        let guest = matches!(&command.policy.identity, OwnerIdentity::Guest { .. });
        if guest {
            self.cleanup
                .enqueue(&command.policy, &command.registration.operation_id)
                .await?;
        }
        let mut ready = false;
        for _ in 0..8 {
            let (mut current, version) = self.intent(command).await?;
            if current.ready {
                ready = true;
                break;
            }
            current.ready = true;
            let scope = self.scope(command, "regional-init");
            let result = self
                .commit(
                    &scope,
                    &mutation(&command.registration.operation_id, "ready"),
                    vec![json!({"key":"intent","expectedVersion":version,"value":current})],
                )
                .await;
            match result {
                // The acknowledgement is returned only after this conditional write or its
                // committed receipt is confirmed; no second read is needed on success.
                Ok(()) => {
                    ready = true;
                    break;
                }
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) => return Err(e),
            }
        }
        // A final read is still needed if every attempt conflicted: another initializer may
        // have committed readiness on the last attempt.
        if !ready && !self.intent(command).await?.0.ready {
            return Err(error(503, "REGION_INIT_CONFLICT"));
        }
        Ok(Acknowledgement {
            registration: command.registration.clone(),
            policy_generation: 1,
            guest_cleanup_scheduled: guest,
        })
    }
}

impl RegionControl for EmbeddedRegion {
    fn initialize<'a>(
        &'a self,
        command: &'a Command,
    ) -> Pin<Box<dyn Future<Output = Result<Acknowledgement>> + Send + 'a>> {
        Box::pin(async move { self.initialize_inner(command).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Directory, VerifiedIdentity, onboarding::Onboarding, tests::MemoryMeta};
    use std::sync::atomic::{AtomicBool, Ordering};
    use workspace_contracts::Call;

    struct StopRedundantReads {
        inner: Arc<MemoryMeta>,
        workspace_committed: AtomicBool,
        readiness_committed: AtomicBool,
    }

    impl Metadata for StopRedundantReads {
        fn health(&self) -> Call<'_> {
            self.inner.health()
        }

        fn execute(&self, request: MetaRequest) -> Call<'_> {
            Box::pin(async move {
                if let MetaRequest::Get { scope, .. } = &request
                    && ((scope.family == "workspace"
                        && self.workspace_committed.load(Ordering::SeqCst))
                        || (scope.family == "regional-init"
                            && self.readiness_committed.load(Ordering::SeqCst)))
                {
                    return Err(error(503, "TEST_READ_UNAVAILABLE"));
                }
                let (workspace, ready) = match &request {
                    MetaRequest::Commit { scope, changes, .. } => (
                        scope.family == "workspace"
                            && changes
                                .iter()
                                .any(|change| change["key"] == "ownership/onboarding"),
                        scope.family == "regional-init"
                            && changes.iter().any(|change| {
                                change["key"] == "intent" && change["value"]["ready"] == true
                            }),
                    ),
                    _ => (false, false),
                };
                let result = self.inner.execute(request).await?;
                if workspace {
                    self.workspace_committed.store(true, Ordering::SeqCst);
                }
                if ready {
                    self.readiness_committed.store(true, Ordering::SeqCst);
                }
                Ok(result)
            })
        }
    }

    fn global() -> Arc<MemoryMeta> {
        Arc::new(MemoryMeta::default())
    }
    fn region() -> Arc<MemoryMeta> {
        Arc::new(MemoryMeta {
            authority: Some("region:a".into()),
            ..Default::default()
        })
    }
    fn identity() -> VerifiedIdentity<'static> {
        VerifiedIdentity {
            issuer: "https://issuer.example",
            subject: "alice",
        }
    }

    #[tokio::test]
    async fn confirmed_initialization_does_not_depend_on_redundant_reads() {
        let underlying = region();
        let regional = Arc::new(StopRedundantReads {
            inner: underlying.clone(),
            workspace_committed: AtomicBool::new(false),
            readiness_committed: AtomicBool::new(false),
        });
        let embedded = Arc::new(EmbeddedRegion::open(regional, "region:a").await.unwrap());
        let onboarding = Onboarding::new(Directory::open(global()).await.unwrap(), embedded);
        let result = onboarding.personal(identity(), "region:a").await.unwrap();
        let scope = Scope {
            authority_id: "region:a".into(),
            owner_kind: "workspace".into(),
            owner_id: result.workspace_id.clone(),
            family: "workspace".into(),
            partition_id: "primary".into(),
        };
        let stored = underlying
            .execute(MetaRequest::Get {
                scope,
                guard: None,
                keys: vec!["state/workspace".into(), "ownership/onboarding".into()],
            })
            .await
            .unwrap();
        assert_eq!(
            stored["records"]["state/workspace"]["value"]["id"],
            result.workspace_id
        );
        assert_eq!(
            stored["records"]["ownership/onboarding"]["value"]["userId"],
            result.user_id
        );
    }

    #[tokio::test]
    async fn personal_and_guest_create_owned_empty_workspaces_and_remain_idempotent() {
        let region_meta = region();
        let global_meta = global();
        let embedded = Arc::new(
            EmbeddedRegion::open(region_meta.clone(), "region:a")
                .await
                .unwrap(),
        );
        let onboarding = Arc::new(Onboarding::new(
            Directory::open(global_meta.clone()).await.unwrap(),
            embedded,
        ));
        let mut tasks = Vec::new();
        for _ in 0..12 {
            let onboarding = onboarding.clone();
            tasks.push(tokio::spawn(async move {
                onboarding.personal(identity(), "region:a").await.unwrap()
            }));
        }
        let first = tasks.remove(0).await.unwrap();
        for task in tasks {
            assert!(task.await.unwrap() == first);
        }
        let scope = Scope {
            authority_id: "region:a".into(),
            owner_kind: "workspace".into(),
            owner_id: first.workspace_id.clone(),
            family: "workspace".into(),
            partition_id: "primary".into(),
        };
        let records = region_meta
            .execute(MetaRequest::Get {
                scope,
                guard: None,
                keys: vec!["state/workspace".into(), "ownership/onboarding".into()],
            })
            .await
            .unwrap();
        assert_eq!(
            records["records"]["state/workspace"]["value"]["id"],
            first.workspace_id
        );
        assert_eq!(
            records["records"]["ownership/onboarding"]["value"]["userId"],
            first.user_id
        );

        let guest = Directory::open(global_meta)
            .await
            .unwrap()
            .create_guest("region:a")
            .await
            .unwrap();
        let registered = onboarding.guest(&guest).await.unwrap();
        assert_ne!(registered.workspace_id, first.workspace_id);
        assert!(onboarding.guest(&guest).await.unwrap() == registered);
        let groups = region_meta.groups.lock().unwrap();
        assert!(groups.values().any(|group| {
            group
                .keys()
                .any(|key| key.contains(&registered.workspace_id) && key.starts_with("job/"))
        }));
    }

    #[tokio::test]
    async fn existing_unowned_workspace_is_not_adopted() {
        let region_meta = region();
        let embedded = EmbeddedRegion::open(region_meta.clone(), "region:a")
            .await
            .unwrap();
        let registration = crate::Registration {
            workspace_id: Uuid::new_v4().to_string(),
            organization_id: Uuid::new_v4().to_string(),
            user_id: Uuid::new_v4().to_string(),
            region_id: "region:a".into(),
            operation_id: Uuid::new_v4().to_string(),
        };
        let policy = crate::regional::Policy {
            workspace_id: registration.workspace_id.clone(),
            organization_id: registration.organization_id.clone(),
            user_id: registration.user_id.clone(),
            region_id: registration.region_id.clone(),
            generation: 1,
            denied: false,
            identity: OwnerIdentity::Oidc {
                issuer: "https://issuer.example".into(),
                subject: "alice".into(),
            },
        };
        let command = Command {
            registration: registration.clone(),
            policy,
        };
        let scope = embedded.scope(&command, "workspace");
        region_meta.execute(MetaRequest::Commit { scope, guard:None, mutation_id:Uuid::new_v4().to_string(),
            changes:vec![json!({"key":"state/workspace","expectedVersion":null,"value":{"id":registration.workspace_id}})] }).await.unwrap();
        assert_eq!(
            embedded
                .initialize_inner(&command)
                .await
                .err()
                .unwrap()
                .code,
            "REGION_WORKSPACE_OWNER_MISMATCH"
        );
    }
}
