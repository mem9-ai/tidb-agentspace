//! Isolated integration fixture. This is not a public Guest endpoint or deployment role.
use std::sync::Arc;
use workspace_api::global_login::GlobalGuest;
use workspace_identity::{
    Directory, embedded_region::EmbeddedRegion, regional::Principal, sessions::Sessions,
};
use workspace_meta_client::{ClientConfig, RemoteMetadata};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(args.len() == 3, "expected isolated metadata configurations");
    let global: ClientConfig = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let region: ClientConfig = serde_json::from_slice(&std::fs::read(&args[2])?)?;
    let authority = region.authority_id.clone();
    let global_meta = Arc::new(RemoteMetadata::connect(global).await?);
    let region_meta = Arc::new(RemoteMetadata::connect(region).await?);
    let signup = GlobalGuest::new(
        Directory::open(global_meta).await?,
        Arc::new(EmbeddedRegion::open(region_meta.clone(), &authority).await?),
        authority.clone(),
    );
    let before = chrono::Utc::now().timestamp();
    let guest = signup.begin().await?;
    anyhow::ensure!(
        guest.expires_at >= before + 86_400
            && guest.expires_at <= chrono::Utc::now().timestamp() + 86_400,
        "invalid Guest expiry"
    );
    let registration = signup.finish(&guest).await?;
    anyhow::ensure!(
        signup.finish(&guest).await? == registration,
        "Guest retry was not idempotent"
    );
    let sessions = Sessions::open(region_meta, &authority).await?;
    let credentials = sessions
        .issue_owner(
            &registration.workspace_id,
            Principal::Guest {
                guest_id: &guest.guest_id,
                secret: &guest.secret,
            },
        )
        .await?;
    anyhow::ensure!(
        credentials.access_expires_at <= guest.expires_at,
        "session exceeds Guest expiry"
    );
    sessions
        .authorize(&registration.workspace_id, &credentials.access)
        .await?;
    println!(
        "{}",
        serde_json::json!({"registration":registration,"expiresAt":guest.expires_at,"accessExpiresAt":credentials.access_expires_at})
    );
    Ok(())
}
