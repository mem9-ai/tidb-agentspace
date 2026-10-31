//! Isolated integration fixture. No public route or real provider is accessed.
use std::sync::Arc;
use workspace_api::{
    global_login::GlobalGuest,
    managed_workspaces::ManagedWorkspaces,
    regional_guest::{AuthorizedGuest, RegionalGuest},
};
use workspace_domain::Operation;
use workspace_identity::{Directory, embedded_region::EmbeddedRegion};
use workspace_meta_client::{ClientConfig, RemoteMetadata};

async fn make_guest(
    signup: &GlobalGuest,
    region: &RegionalGuest,
) -> anyhow::Result<AuthorizedGuest> {
    let guest = signup.begin().await?;
    let registration = signup.finish(&guest).await?;
    let established = region
        .establish(&registration.workspace_id, &guest.guest_id, &guest.secret)
        .await?;
    let cookie = established
        .set_cookie
        .to_str()?
        .split(';')
        .next()
        .ok_or_else(|| anyhow::anyhow!("invalid cookie"))?;
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::COOKIE,
        axum::http::HeaderValue::from_str(cookie)?,
    );
    Ok(region.authenticate(&headers).await?)
}

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
    let sessions = RegionalGuest::open(region_meta.clone(), &authority, "/studio").await?;
    let alice = make_guest(&signup, &sessions).await?;
    let bob = make_guest(&signup, &sessions).await?;
    anyhow::ensure!(
        alice.workspace_id != bob.workspace_id,
        "guests share a Workspace"
    );
    let pool = ManagedWorkspaces::new(region_meta, &authority, None, 1)?;
    let first = pool.acquire(&alice.workspace_id, &alice.credential).await?;
    let reply = first
        .call(alice.credential.clone(), Operation::GetWorkspace)
        .await?;
    anyhow::ensure!(
        reply.body["data"]["id"] == alice.workspace_id,
        "wrong Workspace returned"
    );
    anyhow::ensure!(
        pool.acquire(&bob.workspace_id, &alice.credential)
            .await
            .err()
            .is_some_and(|e| e.code == "UNAUTHENTICATED"),
        "cross-workspace credential accepted"
    );
    anyhow::ensure!(
        pool.acquire(&bob.workspace_id, &bob.credential)
            .await
            .err()
            .is_some_and(|e| e.code == "WORKSPACE_POOL_BUSY"),
        "in-use Workspace evicted"
    );
    drop(first);
    let second = pool.acquire(&bob.workspace_id, &bob.credential).await?;
    let reply = second
        .call(bob.credential.clone(), Operation::GetWorkspace)
        .await?;
    anyhow::ensure!(
        reply.body["data"]["id"] == bob.workspace_id,
        "wrong second Workspace returned"
    );
    anyhow::ensure!(
        pool.close()
            .await
            .err()
            .is_some_and(|e| e.code == "WORKSPACE_POOL_BUSY"),
        "active lease not drained"
    );
    drop(second);
    pool.close().await?;
    println!("{{\"isolated\":true}}");
    Ok(())
}
