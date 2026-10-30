//! Integration-test helper. It is not shipped as an API or used for authentication.
use std::sync::Arc;
use workspace_identity::{
    Directory, GuestRegistration, Provisioning, Registration, VerifiedIdentity,
    cleanup::{Job, Queue},
    embedded_region::EmbeddedRegion,
    onboarding::Onboarding,
    regional::{Policies, Policy, Principal},
    sessions::Sessions,
};
use workspace_meta_client::{ClientConfig, RemoteMetadata};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(args.len() == 5, "expected config and test arguments");
    let config: ClientConfig = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let authority = config.authority_id.clone();
    let metadata = Arc::new(RemoteMetadata::connect(config).await?);
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
    if args[2] == "--cleanup-claim" || args[2] == "--cleanup-complete" {
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
            queue.complete_verified(&job, attempt, &args[4]).await?;
            println!("{{\"complete\":true}}");
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
    if args[2] == "--region-issue" {
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
        let sessions = Sessions::open(metadata, authority).await?;
        let credentials = sessions
            .issue_owner(&args[4], Principal::Oidc { issuer, subject })
            .await?;
        println!(
            "{}",
            serde_json::json!({"access":credentials.access,"renewal":credentials.renewal})
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
