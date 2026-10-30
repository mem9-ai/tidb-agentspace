//! Integration-test helper. It is not shipped as an API or used for authentication.
use std::sync::Arc;
use workspace_identity::{Directory, VerifiedIdentity};
use workspace_meta_client::{ClientConfig, RemoteMetadata};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(args.len() == 5, "expected config and test arguments");
    let config: ClientConfig = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let metadata = Arc::new(RemoteMetadata::connect(config).await?);
    let directory = Directory::open(metadata).await?;
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
