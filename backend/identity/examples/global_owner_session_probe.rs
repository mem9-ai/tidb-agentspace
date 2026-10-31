//! Isolated S3-recovery fixture. No secret is printed or passed in arguments.
use std::sync::Arc;
use workspace_identity::global_owner_sessions::OwnerSessions;
use workspace_meta_client::{ClientConfig, RemoteMetadata};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(
        args.len() == 5,
        "expected config, mode, workspace and private credential file"
    );
    let config: ClientConfig = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let sessions = OwnerSessions::open(Arc::new(RemoteMetadata::connect(config).await?)).await?;
    let secret = std::fs::read_to_string(&args[4])?;
    match args[2].as_str() {
        "check" => {
            let session = sessions.authenticate(&args[3], &secret).await?;
            anyhow::ensure!(session.workspace_id() == args[3]);
        }
        "revoke" => {
            sessions
                .revoke(&args[3], &secret, &uuid::Uuid::new_v4().to_string())
                .await?
        }
        _ => anyhow::bail!("unknown fixture mode"),
    }
    Ok(())
}
