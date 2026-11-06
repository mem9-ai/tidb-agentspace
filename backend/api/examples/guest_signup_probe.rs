//! Isolated integration fixture. This is not a public Guest endpoint or deployment role.
use std::sync::Arc;
use workspace_api::{global_login::GlobalGuest, regional_guest::RegionalGuest};
use workspace_identity::{
    Directory, embedded_region::EmbeddedRegion, regional::Principal, sessions::Sessions,
};
use workspace_meta_client::{ClientConfig, RemoteMetadata};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(
        args.len() == 4,
        "expected isolated metadata configurations and private cookie file"
    );
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
        guest.expires_at >= before + 172_800
            && guest.expires_at <= chrono::Utc::now().timestamp() + 172_800,
        "invalid Guest expiry"
    );
    let registration = signup.finish(&guest).await?;
    anyhow::ensure!(
        signup.finish(&guest).await? == registration,
        "Guest retry was not idempotent"
    );
    let guest_region = RegionalGuest::open(region_meta.clone(), &authority, "/studio").await?;
    let established = guest_region
        .establish(&registration.workspace_id, &guest.guest_id, &guest.secret)
        .await?;
    anyhow::ensure!(
        established.set_cookie.is_sensitive(),
        "cookie header was not marked sensitive"
    );
    let set_cookie = established.set_cookie.to_str()?;
    anyhow::ensure!(
        set_cookie.contains("HttpOnly; Secure; SameSite=Strict; Path=/studio/; Expires="),
        "invalid cookie attributes"
    );
    let expires = set_cookie
        .rsplit_once("Expires=")
        .ok_or_else(|| anyhow::anyhow!("missing cookie expiry"))?
        .1;
    let cookie_expiry = chrono::DateTime::parse_from_rfc2822(expires)?.timestamp();
    anyhow::ensure!(
        cookie_expiry == guest.expires_at && cookie_expiry > before,
        "cookie exceeds Guest expiry"
    );
    anyhow::ensure!(
        !set_cookie.contains(&guest.secret) && !set_cookie.contains("Domain="),
        "unsafe cookie scope or reused Global secret"
    );
    let cookie = set_cookie
        .split(';')
        .next()
        .ok_or_else(|| anyhow::anyhow!("invalid cookie"))?;
    // The test creates this owner-only file first; real callers send Set-Cookie to the browser.
    std::fs::write(&args[3], cookie)?;
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::COOKIE,
        axum::http::HeaderValue::from_str(cookie)?,
    );
    let reopened = RegionalGuest::open(region_meta.clone(), &authority, "/studio").await?;
    let authorized = reopened.authenticate(&headers).await?;
    anyhow::ensure!(
        authorized.workspace_id == registration.workspace_id,
        "wrong cookie Workspace"
    );
    let repository = workspace_domain::Repository::open(
        region_meta.clone(),
        &authority,
        &authorized.workspace_id,
        false,
        None,
    )
    .await?;
    let workspace = workspace_domain::Workspace::new_managed(repository);
    workspace.authenticate(&authorized.credential).await?;
    workspace.close().await?;
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
