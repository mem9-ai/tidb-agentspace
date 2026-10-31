//! Isolated Region cookie integration fixture; it never connects to Global metadata.
use std::sync::Arc;
use workspace_api::regional_guest::RegionalGuest;
use workspace_meta_client::{ClientConfig, RemoteMetadata};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(
        args.len() == 4,
        "expected regional config, private cookie file and action"
    );
    let config: ClientConfig = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let authority = config.authority_id.clone();
    let metadata = Arc::new(RemoteMetadata::connect(config).await?);
    let guest = RegionalGuest::open(metadata.clone(), &authority, "/studio").await?;
    let cookie = workspace_meta_client::private_file(std::path::Path::new(&args[2]))?;
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::COOKIE,
        axum::http::HeaderValue::from_bytes(&cookie)?,
    );
    if args[3] == "logout" {
        guest.revoke(&headers).await?;
        println!("{{\"revoked\":true}}");
        return Ok(());
    }
    anyhow::ensure!(args[3] == "access", "invalid fixture action");
    let authorized = guest.authenticate(&headers).await?;
    let repository = workspace_domain::Repository::open(
        metadata,
        &authority,
        &authorized.workspace_id,
        false,
        None,
    )
    .await?;
    let workspace = workspace_domain::Workspace::new_managed(repository);
    workspace.authenticate(&authorized.credential).await?;
    workspace.close().await?;
    println!(
        "{}",
        serde_json::json!({"workspaceId":authorized.workspace_id})
    );
    Ok(())
}
