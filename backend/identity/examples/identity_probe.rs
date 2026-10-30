//! Integration-test helper. It is not shipped as an API or used for authentication.
use std::sync::Arc;
use workspace_identity::{
    Directory, GuestRegistration, Provisioning, Registration, VerifiedIdentity,
    cleanup::{DeferredReason, Job, Queue},
    embedded_region::EmbeddedRegion,
    onboarding::{Command, Onboarding, RegionControl},
    regional::{OwnerIdentity, Policies, Policy, Principal},
    scheduler::{Outcome, Processor, Scheduler},
    sessions::Sessions,
};
use workspace_meta_client::{ClientConfig, RemoteMetadata};

struct UnsupportedFixture;
impl Processor for UnsupportedFixture {
    fn process<'a>(
        &'a self,
        _: &'a Job,
        _: &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = workspace_contracts::Result<Outcome>> + Send + 'a>,
    > {
        Box::pin(async {
            Ok(Outcome::Deferred(
                DeferredReason::ProviderDeletionUnsupported,
            ))
        })
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(args.len() == 5, "expected config and test arguments");
    let config: ClientConfig = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let authority = config.authority_id.clone();
    let metadata = Arc::new(RemoteMetadata::connect(config).await?);
    if args[2] == "--workspace-isolation" {
        use workspace_domain::{Credential, Operation, Repository, Workspace};
        let alice_repo =
            Repository::open(metadata.clone(), &authority, &args[3], false, None).await?;
        let (user, generation) = alice_repo.managed_owner().await?;
        let alice = Workspace::new_managed(alice_repo);
        let bob_repo = Repository::open(metadata, &authority, &args[4], false, None).await?;
        let (bob_user, bob_generation) = bob_repo.managed_owner().await?;
        let bob = Workspace::new_managed(bob_repo);
        let credential = Credential::SessionOwner {
            id: user,
            actor: "test-user".into(),
            workspace_id: args[3].clone(),
            policy_generation: Some(generation),
            expires_at: chrono::Utc::now().timestamp() + 60,
            revoked: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        anyhow::ensure!(
            alice.authenticate(&credential).await.is_ok(),
            "owner denied"
        );
        let wrong_owner = Credential::SessionOwner {
            id: uuid::Uuid::new_v4().to_string(),
            actor: "other".into(),
            workspace_id: args[3].clone(),
            policy_generation: Some(generation),
            expires_at: chrono::Utc::now().timestamp() + 60,
            revoked: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        anyhow::ensure!(
            alice.authenticate(&wrong_owner).await.is_err(),
            "wrong user accepted"
        );
        let stale_policy = Credential::SessionOwner {
            id: match &credential {
                Credential::SessionOwner { id, .. } => id.clone(),
                _ => unreachable!(),
            },
            actor: "test-user".into(),
            workspace_id: args[3].clone(),
            policy_generation: Some(generation + 1),
            expires_at: chrono::Utc::now().timestamp() + 60,
            revoked: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        anyhow::ensure!(
            alice.authenticate(&stale_policy).await.is_err(),
            "wrong policy generation accepted"
        );
        anyhow::ensure!(
            alice
                .authenticate(&Credential::LocalDemoOwner)
                .await
                .is_err(),
            "demo owner accepted in managed Workspace"
        );
        anyhow::ensure!(
            bob.authenticate(&credential).await.is_err(),
            "wrong workspace accepted"
        );
        let guest = Credential::SessionOwner {
            id: bob_user,
            actor: "guest".into(),
            workspace_id: args[4].clone(),
            policy_generation: Some(bob_generation),
            expires_at: chrono::Utc::now().timestamp() + 60,
            revoked: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        anyhow::ensure!(bob.authenticate(&guest).await.is_ok(), "guest denied");
        anyhow::ensure!(
            alice.authenticate(&guest).await.is_err(),
            "guest crossed Workspace"
        );
        anyhow::ensure!(
            alice
                .call(credential.clone(), Operation::GetWorkspace)
                .await
                .is_ok(),
            "owner read denied"
        );
        anyhow::ensure!(
            bob.call(credential, Operation::GetWorkspace).await.is_err(),
            "cross-workspace read accepted"
        );
        alice.close().await?;
        bob.close().await?;
        println!("{{\"isolated\":true}}");
        return Ok(());
    }
    if args[2] == "--expired-guest-check" {
        use workspace_domain::{Credential, Operation, Repository, Workspace};
        let random = || uuid::Uuid::new_v4().to_string();
        let registration = Registration {
            user_id: random(),
            organization_id: random(),
            workspace_id: random(),
            region_id: authority.clone(),
            operation_id: random(),
        };
        let expires_at = chrono::Utc::now().timestamp() - 1;
        let policy = Policy {
            workspace_id: registration.workspace_id.clone(),
            organization_id: registration.organization_id.clone(),
            user_id: registration.user_id.clone(),
            region_id: authority.clone(),
            generation: 1,
            denied: false,
            identity: OwnerIdentity::Guest {
                guest_id: random(),
                verifier: hex::encode([9u8; 32]),
                created_at: expires_at - 86_400,
                expires_at,
            },
        };
        let region = EmbeddedRegion::open(metadata.clone(), &authority).await?;
        region
            .initialize(&Command {
                registration: registration.clone(),
                policy,
            })
            .await?;
        let session = Credential::SessionOwner {
            id: registration.user_id.clone(),
            actor: "guest".into(),
            workspace_id: registration.workspace_id.clone(),
            policy_generation: Some(1),
            expires_at: chrono::Utc::now().timestamp() + 60,
            revoked: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        // Seed an otherwise valid Key in the isolated fixture to prove expiry gates Keys too.
        let fixture_workspace = Workspace::new(
            Repository::open(
                metadata.clone(),
                &authority,
                &registration.workspace_id,
                false,
                None,
            )
            .await?,
        );
        let key = fixture_workspace.call(session.clone(), Operation::CreateKey(serde_json::json!({"name":"fixture", "scopes":["resources:read"], "resourceIds":["*"], "expiresInDays":7}))).await?;
        let key = key.body["secret"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing fixture key"))?
            .to_owned();
        anyhow::ensure!(
            fixture_workspace
                .authenticate(&Credential::Bearer(key.clone()))
                .await
                .is_ok(),
            "fixture key was not valid"
        );
        fixture_workspace.close().await?;
        let workspace = Workspace::new_managed(
            Repository::open(
                metadata.clone(),
                &authority,
                &registration.workspace_id,
                false,
                None,
            )
            .await?,
        );
        anyhow::ensure!(
            workspace
                .authenticate(&session)
                .await
                .err()
                .is_some_and(|e| e.code == "GUEST_EXPIRED"),
            "expired session accepted"
        );
        anyhow::ensure!(
            workspace
                .authenticate(&Credential::Bearer(key))
                .await
                .err()
                .is_some_and(|e| e.code == "GUEST_EXPIRED"),
            "expired Key reached authentication"
        );
        anyhow::ensure!(
            workspace
                .call(session, Operation::GetWorkspace)
                .await
                .err()
                .is_some_and(|e| e.code == "GUEST_EXPIRED"),
            "expired Guest read accepted"
        );
        workspace.close().await?;
        let unowned_id = random();
        let unowned = Workspace::new_managed(
            Repository::open(metadata, &authority, &unowned_id, true, None).await?,
        );
        anyhow::ensure!(
            unowned
                .authenticate(&Credential::LocalDemoOwner)
                .await
                .err()
                .is_some_and(|e| e.code == "MANAGED_POLICY_MISSING"),
            "unowned Workspace was adopted"
        );
        unowned.close().await?;
        println!("{{\"expiredGuestRejected\":true}}");
        return Ok(());
    }
    if args[2] == "--workspace-check" {
        let repository =
            workspace_domain::Repository::open(metadata, &authority, &args[3], false, None).await?;
        let workspace = repository.get("state/workspace").await?;
        anyhow::ensure!(workspace["value"]["id"] == args[3], "workspace mismatch");
        repository.close().await?;
        println!("{{\"workspaceReady\":true}}");
        return Ok(());
    }
    if args[2] == "--onboard-personal" || args[2] == "--onboard-guest" {
        let region_config: ClientConfig = serde_json::from_slice(&std::fs::read(&args[3])?)?;
        let region_id = region_config.authority_id.clone();
        let region_meta = Arc::new(RemoteMetadata::connect(region_config).await?);
        // Test-only composition. Separately deployed Global must call the Region control API.
        let region = Arc::new(EmbeddedRegion::open(region_meta, &region_id).await?);
        let onboarding = Onboarding::new(Directory::open(metadata).await?, region);
        let registration = if args[2] == "--onboard-personal" {
            onboarding
                .personal(
                    VerifiedIdentity {
                        issuer: "https://issuer.example",
                        subject: &args[4],
                    },
                    &region_id,
                )
                .await?
        } else {
            let value: serde_json::Value = serde_json::from_slice(&std::fs::read(&args[4])?)?;
            let guest = GuestRegistration {
                guest_id: value["guestId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("missing guest ID"))?
                    .into(),
                secret: value["secret"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("missing guest secret"))?
                    .into(),
                expires_at: value["expiresAt"]
                    .as_i64()
                    .ok_or_else(|| anyhow::anyhow!("missing expiry"))?,
                registration: serde_json::from_value(value["registration"].clone())?,
            };
            onboarding.guest(&guest).await?
        };
        println!("{}", serde_json::to_string(&registration)?);
        return Ok(());
    }
    if args[2] == "--cleanup-enqueue" {
        let policy: Policy = serde_json::from_slice(&std::fs::read(&args[3])?)?;
        let queue = Queue::open(metadata, &policy.region_id).await?;
        queue.enqueue(&policy, &args[4]).await?;
        println!("{{\"queued\":true}}");
        return Ok(());
    }
    if args[2] == "--cleanup-due" {
        let input: serde_json::Value = serde_json::from_slice(&std::fs::read(&args[3])?)?;
        let authority = input["regionId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing region"))?;
        let partition = u8::try_from(
            input["partition"]
                .as_u64()
                .ok_or_else(|| anyhow::anyhow!("missing partition"))?,
        )?;
        let queue = Queue::open(metadata, authority).await?;
        let page = queue.due(partition, None, 16).await?;
        println!(
            "{}",
            serde_json::json!({"jobs":page.jobs,"nextCursor":page.next_cursor})
        );
        return Ok(());
    }
    if args[2] == "--cleanup-scan" {
        let queue = Arc::new(Queue::open(metadata, &authority).await?);
        let mut scheduler = Scheduler::new(queue, Arc::new(UnsupportedFixture), 32)?;
        for _ in 0..64 {
            scheduler.tick().await?;
        }
        println!("{{\"scanned\":true}}");
        return Ok(());
    }
    if ["--cleanup-claim", "--cleanup-complete", "--cleanup-defer"].contains(&args[2].as_str()) {
        let input: serde_json::Value = serde_json::from_slice(&std::fs::read(&args[3])?)?;
        let authority = input["regionId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing region"))?;
        let job: Job = serde_json::from_value(input["job"].clone())?;
        let queue = Queue::open(metadata, authority).await?;
        if args[2] == "--cleanup-claim" {
            let claimed = queue.claim(&job, &args[4]).await?;
            println!("{}", serde_json::to_string(&claimed)?);
        } else {
            let attempt = input["attemptId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("missing attempt"))?;
            if args[2] == "--cleanup-defer" {
                queue
                    .defer(
                        &job,
                        attempt,
                        DeferredReason::ProviderDeletionUnsupported,
                        &args[4],
                    )
                    .await?;
                println!("{{\"deferred\":true}}");
            } else {
                queue.complete_verified(&job, attempt, &args[4]).await?;
                println!("{{\"complete\":true}}");
            }
        }
        return Ok(());
    }
    if args[2] == "--region-install" {
        let policy: Policy = serde_json::from_slice(&std::fs::read(&args[3])?)?;
        let policies = Policies::open(metadata, &policy.region_id).await?;
        policies.install(&policy, &args[4]).await?;
        println!("{{\"installed\":true}}");
        return Ok(());
    }
    if args[2] == "--region-auth" {
        let input: serde_json::Value = serde_json::from_slice(&std::fs::read(&args[3])?)?;
        let authority = input["regionId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing region"))?;
        let issuer = input["issuer"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing issuer"))?;
        let subject = input["subject"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing subject"))?;
        let policies = Policies::open(metadata, authority).await?;
        policies
            .authorize_owner(&args[4], Principal::Oidc { issuer, subject })
            .await?;
        println!("{{\"authorized\":true}}");
        return Ok(());
    }
    if ["--region-issue", "--guest-region-issue"].contains(&args[2].as_str()) {
        let input: serde_json::Value = serde_json::from_slice(&std::fs::read(&args[3])?)?;
        let authority = input["regionId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing region"))?;
        let sessions = Sessions::open(metadata, authority).await?;
        let principal = if args[2] == "--guest-region-issue" {
            Principal::Guest {
                guest_id: input["guestId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("missing guest ID"))?,
                secret: input["secret"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("missing guest secret"))?,
            }
        } else {
            Principal::Oidc {
                issuer: input["issuer"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("missing issuer"))?,
                subject: input["subject"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("missing subject"))?,
            }
        };
        let credentials = sessions.issue_owner(&args[4], principal).await?;
        println!(
            "{}",
            serde_json::json!({"access":credentials.access,"renewal":credentials.renewal,"accessExpiresAt":credentials.access_expires_at})
        );
        return Ok(());
    }
    if args[2] == "--region-access" || args[2] == "--region-renew" {
        let input: serde_json::Value = serde_json::from_slice(&std::fs::read(&args[3])?)?;
        let authority = input["regionId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing region"))?;
        let token = input["token"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing token"))?;
        let sessions = Sessions::open(metadata, authority).await?;
        if args[2] == "--region-access" {
            sessions.authorize(&args[4], token).await?;
            println!("{{\"authorized\":true}}");
        } else {
            let access = sessions.renew(&args[4], token).await?;
            println!("{}", serde_json::json!({"access":access.token}));
        }
        return Ok(());
    }
    let directory = Directory::open(metadata).await?;
    if args[2] == "--region-ready" {
        let input: serde_json::Value = serde_json::from_slice(&std::fs::read(&args[3])?)?;
        let registration: Registration = serde_json::from_value(input["registration"].clone())?;
        let issuer = input["issuer"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing issuer"))?;
        let subject = input["subject"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing subject"))?;
        directory
            .record_region_ready(
                VerifiedIdentity { issuer, subject },
                &registration,
                &args[4],
            )
            .await?;
        println!("{{\"ready\":true}}");
        return Ok(());
    }
    if args[2] == "--status" {
        let (_, state) = directory
            .status(VerifiedIdentity {
                issuer: &args[3],
                subject: &args[4],
            })
            .await?
            .ok_or_else(|| anyhow::anyhow!("identity missing"))?;
        let state = match state {
            Provisioning::Pending => "pending",
            Provisioning::Ready => "ready",
        };
        println!("{}", serde_json::json!({"state":state}));
        return Ok(());
    }
    if args[2] == "--guest-create" {
        let guest = directory.create_guest(&args[3]).await?;
        println!(
            "{}",
            serde_json::json!({"guestId":guest.guest_id,"secret":guest.secret,"expiresAt":guest.expires_at,"registration":guest.registration})
        );
        return Ok(());
    }
    if args[2] == "--guest-auth" {
        let registration = directory.authenticate_guest(&args[3], &args[4]).await?;
        println!("{}", serde_json::to_string(&registration)?);
        return Ok(());
    }
    let registration = directory
        .reserve(
            VerifiedIdentity {
                issuer: &args[2],
                subject: &args[3],
            },
            &args[4],
        )
        .await?;
    println!("{}", serde_json::to_string(&registration)?);
    Ok(())
}
