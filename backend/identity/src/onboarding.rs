//! Inactive Global-initiated onboarding orchestration. A production RegionControl must
//! authenticate both peers, establish TLS 1.3/mTLS and bind every acknowledgement to the
//! requested Region and operation. No transport or live Workspace initialization is supplied.

use crate::{
    Directory, GuestRegistration, Provisioning, Registration, VerifiedIdentity, error,
    regional::{OwnerIdentity, Policy},
};
use sha2::{Digest, Sha256};
use std::{future::Future, pin::Pin, sync::Arc};
use uuid::Uuid;
use workspace_contracts::Result;

#[derive(Clone)]
pub struct Command {
    pub registration: Registration,
    pub policy: Policy,
}

/// This result is trusted only after the control implementation has authenticated the Region.
pub struct Acknowledgement {
    pub registration: Registration,
    pub policy_generation: u64,
    pub guest_cleanup_scheduled: bool,
}

/// Implementations must make initialization and policy installation durable and idempotent
/// for `registration.operation_id` before returning. Region must never call back into Global.
/// For Guest onboarding a separate command must also durably enqueue expiration before ready.
pub trait RegionControl: Send + Sync {
    fn initialize<'a>(
        &'a self,
        command: &'a Command,
    ) -> Pin<Box<dyn Future<Output = Result<Acknowledgement>> + Send + 'a>>;
}

pub struct Onboarding {
    directory: Directory,
    region: Arc<dyn RegionControl>,
}

fn ready_mutation(operation_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"workspace-onboarding\0ready\0v1\0");
    digest.update(operation_id.as_bytes());
    let hash = digest.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash[..16]);
    Uuid::from_bytes(bytes).to_string()
}

impl Onboarding {
    pub fn new(directory: Directory, region: Arc<dyn RegionControl>) -> Self {
        Self { directory, region }
    }

    /// `identity` must come from successful OIDC verification. Returning a Workspace does not
    /// grant a session or imply that the hosted service has been configured or deployed.
    pub async fn personal(
        &self,
        identity: VerifiedIdentity<'_>,
        selected_region: &str,
    ) -> Result<Registration> {
        let registration = self
            .directory
            .reserve(
                VerifiedIdentity {
                    issuer: identity.issuer,
                    subject: identity.subject,
                },
                selected_region,
            )
            .await?;
        let (_, state) = self
            .directory
            .status(VerifiedIdentity {
                issuer: identity.issuer,
                subject: identity.subject,
            })
            .await?
            .ok_or_else(|| error(503, "IDENTITY_RECORD_CORRUPT"))?;
        if state == Provisioning::Ready {
            return Ok(registration);
        }
        let policy = Policy {
            workspace_id: registration.workspace_id.clone(),
            organization_id: registration.organization_id.clone(),
            principal_id: registration.principal_id.clone(),
            region_id: registration.region_id.clone(),
            generation: 1,
            denied: false,
            identity: OwnerIdentity::Oidc {
                issuer: identity.issuer.into(),
                subject: identity.subject.into(),
            },
        };
        let acknowledgement = self
            .region
            .initialize(&Command {
                registration: registration.clone(),
                policy,
            })
            .await?;
        if acknowledgement.registration != registration || acknowledgement.policy_generation != 1 {
            return Err(error(503, "REGION_ACK_MISMATCH"));
        }
        self.directory
            .record_region_ready(
                identity,
                &registration,
                &ready_mutation(&registration.operation_id),
            )
            .await?;
        Ok(registration)
    }

    /// The caller retains the private Guest secret across a retry. The Region must persist
    /// its expiration job before acknowledging readiness; actual deletion is separate work.
    pub async fn guest(&self, guest: &GuestRegistration) -> Result<Registration> {
        let (registration, state, expires_at) = self
            .directory
            .guest_status(&guest.guest_id, &guest.secret)
            .await?;
        if registration != guest.registration || expires_at != guest.expires_at {
            return Err(error(409, "GUEST_IDENTITY_MISMATCH"));
        }
        if state == Provisioning::Ready {
            return Ok(registration);
        }
        let secret = hex::decode(&guest.secret).map_err(|_| error(401, "GUEST_UNAUTHORIZED"))?;
        if secret.len() != 32 {
            return Err(error(401, "GUEST_UNAUTHORIZED"));
        }
        let policy = Policy {
            workspace_id: registration.workspace_id.clone(),
            organization_id: registration.organization_id.clone(),
            principal_id: registration.principal_id.clone(),
            region_id: registration.region_id.clone(),
            generation: 1,
            denied: false,
            identity: OwnerIdentity::Guest {
                guest_id: guest.guest_id.clone(),
                verifier: hex::encode(Sha256::digest(secret)),
                created_at: expires_at - 86_400,
                expires_at,
            },
        };
        let acknowledgement = self
            .region
            .initialize(&Command {
                registration: registration.clone(),
                policy,
            })
            .await?;
        if acknowledgement.registration != registration || acknowledgement.policy_generation != 1 {
            return Err(error(503, "REGION_ACK_MISMATCH"));
        }
        if !acknowledgement.guest_cleanup_scheduled {
            return Err(error(503, "GUEST_CLEANUP_NOT_READY"));
        }
        self.directory
            .record_guest_ready(
                &guest.guest_id,
                &guest.secret,
                &registration,
                &ready_mutation(&registration.operation_id),
            )
            .await?;
        Ok(registration)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{cleanup::Queue, regional::Policies, tests::MemoryMeta};
    use std::sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    };

    struct FakeRegion {
        policies: Policies,
        queue: Queue,
        calls: Mutex<Vec<String>>,
        fail_reply: AtomicBool,
        wrong_ack: AtomicBool,
        cleanup_ack: AtomicBool,
    }
    impl RegionControl for FakeRegion {
        fn initialize<'a>(
            &'a self,
            command: &'a Command,
        ) -> Pin<Box<dyn Future<Output = Result<Acknowledgement>> + Send + 'a>> {
            Box::pin(async move {
                self.calls
                    .lock()
                    .unwrap()
                    .push(command.registration.operation_id.clone());
                // Fixture models durable local policy installation; production must additionally
                // initialize the actual Workspace and authenticate its control channel.
                self.policies
                    .install(&command.policy, &command.registration.operation_id)
                    .await?;
                let guest = matches!(&command.policy.identity, OwnerIdentity::Guest { .. });
                if guest {
                    self.queue
                        .enqueue(&command.policy, &command.registration.operation_id)
                        .await?;
                }
                if self.fail_reply.swap(false, Ordering::SeqCst) {
                    return Err(error(503, "REGION_UNAVAILABLE"));
                }
                let mut registration = command.registration.clone();
                if self.wrong_ack.load(Ordering::SeqCst) {
                    registration.workspace_id = Uuid::new_v4().to_string();
                }
                Ok(Acknowledgement {
                    registration,
                    policy_generation: 1,
                    guest_cleanup_scheduled: guest && self.cleanup_ack.load(Ordering::SeqCst),
                })
            })
        }
    }
    fn identity() -> VerifiedIdentity<'static> {
        VerifiedIdentity {
            issuer: "https://issuer.example",
            subject: "alice",
        }
    }

    #[tokio::test]
    async fn region_lost_reply_leaves_pending_and_retry_uses_same_operation() {
        let global = Arc::new(MemoryMeta::default());
        let regional = Arc::new(MemoryMeta {
            authority: Some("region:a".into()),
            ..Default::default()
        });
        let fake = Arc::new(FakeRegion {
            policies: Policies::open(regional.clone(), "region:a").await.unwrap(),
            queue: Queue::open(regional, "region:a").await.unwrap(),
            calls: Mutex::new(vec![]),
            fail_reply: AtomicBool::new(true),
            wrong_ack: AtomicBool::new(false),
            cleanup_ack: AtomicBool::new(true),
        });
        let onboarding =
            Onboarding::new(Directory::open(global.clone()).await.unwrap(), fake.clone());
        assert_eq!(
            onboarding
                .personal(identity(), "region:a")
                .await
                .err()
                .unwrap()
                .code,
            "REGION_UNAVAILABLE"
        );
        let (pending, state) = onboarding
            .directory
            .status(identity())
            .await
            .unwrap()
            .unwrap();
        assert!(state == Provisioning::Pending);
        let result = onboarding.personal(identity(), "region:a").await.unwrap();
        assert!(result == pending);
        assert!(
            onboarding
                .directory
                .status(identity())
                .await
                .unwrap()
                .unwrap()
                .1
                == Provisioning::Ready
        );
        assert_eq!(
            fake.calls.lock().unwrap().as_slice(),
            [result.operation_id.clone(), result.operation_id.clone()]
        );
        onboarding.personal(identity(), "region:b").await.unwrap();
        assert_eq!(fake.calls.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn wrong_region_ack_never_marks_workspace_ready() {
        let global = Arc::new(MemoryMeta::default());
        let regional = Arc::new(MemoryMeta {
            authority: Some("region:a".into()),
            ..Default::default()
        });
        let fake = Arc::new(FakeRegion {
            policies: Policies::open(regional.clone(), "region:a").await.unwrap(),
            queue: Queue::open(regional, "region:a").await.unwrap(),
            calls: Mutex::new(vec![]),
            fail_reply: AtomicBool::new(false),
            wrong_ack: AtomicBool::new(true),
            cleanup_ack: AtomicBool::new(true),
        });
        let onboarding = Onboarding::new(Directory::open(global).await.unwrap(), fake);
        assert_eq!(
            onboarding
                .personal(identity(), "region:a")
                .await
                .err()
                .unwrap()
                .code,
            "REGION_ACK_MISMATCH"
        );
        assert!(
            onboarding
                .directory
                .status(identity())
                .await
                .unwrap()
                .unwrap()
                .1
                == Provisioning::Pending
        );
    }

    #[tokio::test]
    async fn guest_cannot_be_ready_without_region_cleanup_confirmation() {
        let global = Arc::new(MemoryMeta::default());
        let regional = Arc::new(MemoryMeta {
            authority: Some("region:a".into()),
            ..Default::default()
        });
        let fake = Arc::new(FakeRegion {
            policies: Policies::open(regional.clone(), "region:a").await.unwrap(),
            queue: Queue::open(regional, "region:a").await.unwrap(),
            calls: Mutex::new(vec![]),
            fail_reply: AtomicBool::new(false),
            wrong_ack: AtomicBool::new(false),
            cleanup_ack: AtomicBool::new(false),
        });
        let onboarding = Onboarding::new(Directory::open(global).await.unwrap(), fake.clone());
        let guest = onboarding.directory.create_guest("region:a").await.unwrap();
        assert_eq!(
            onboarding.guest(&guest).await.err().unwrap().code,
            "GUEST_CLEANUP_NOT_READY"
        );
        assert!(
            onboarding
                .directory
                .guest_status(&guest.guest_id, &guest.secret)
                .await
                .unwrap()
                .1
                == Provisioning::Pending
        );
        fake.cleanup_ack.store(true, Ordering::SeqCst);
        assert!(onboarding.guest(&guest).await.unwrap() == guest.registration);
        assert!(
            onboarding
                .directory
                .guest_status(&guest.guest_id, &guest.secret)
                .await
                .unwrap()
                .1
                == Provisioning::Ready
        );
        onboarding.guest(&guest).await.unwrap();
        assert_eq!(fake.calls.lock().unwrap().len(), 2);
    }
}
