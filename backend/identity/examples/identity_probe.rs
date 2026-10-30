//! Integration-test helper. It is not shipped as an API or used for authentication.
use std::sync::Arc;
use workspace_identity::{
    Directory, Provisioning, Registration, VerifiedIdentity,
    regional::{Policies, Policy, Principal},
};
use workspace_meta_client::{ClientConfig, RemoteMetadata};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(args.len() == 5, "expected config and test arguments");
    let config: ClientConfig = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let metadata = Arc::new(RemoteMetadata::connect(config).await?);
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
