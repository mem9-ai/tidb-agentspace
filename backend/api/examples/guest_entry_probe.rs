//! Isolated integration fixture for the co-located entry service; no public HTTP listener.
use std::{net::IpAddr, str::FromStr, sync::Arc};
use workspace_api::{
    global_login::GlobalGuest, guest_entry::GuestEntry, regional_guest::RegionalGuest,
};
use workspace_identity::{Directory, embedded_region::EmbeddedRegion};
use workspace_meta_client::{ClientConfig, RemoteMetadata};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(
        args.len() == 5,
        "expected global config or dash, regional config, private cookie and action"
    );
    let region: ClientConfig = serde_json::from_slice(&std::fs::read(&args[2])?)?;
    let authority = region.authority_id.clone();
    let metadata = Arc::new(RemoteMetadata::connect(region).await?);
    let regional = Arc::new(RegionalGuest::open(metadata.clone(), &authority, "/studio").await?);
    let signup = if args[1] == "-" {
        None
    } else {
        let global: ClientConfig = serde_json::from_slice(&std::fs::read(&args[1])?)?;
        let global = Arc::new(RemoteMetadata::connect(global).await?);
        Some(Arc::new(GlobalGuest::new(
            Directory::open(global).await?,
            Arc::new(EmbeddedRegion::open(metadata, &authority).await?),
            authority,
        )))
    };
    let entry = GuestEntry::new(
        signup,
        regional,
        vec!["https://studio.example.test".into()],
        false,
    )?;
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::ORIGIN,
        axum::http::HeaderValue::from_static("https://studio.example.test"),
    );
    if args[4] == "resume" {
        let cookie = workspace_meta_client::private_file(std::path::Path::new(&args[3]))?;
        headers.insert(
            axum::http::header::COOKIE,
            axum::http::HeaderValue::from_bytes(&cookie)?,
        );
    } else {
        anyhow::ensure!(args[4] == "create", "invalid fixture action");
    }
    let peer = IpAddr::from_str("127.0.0.1")?;
    let result = entry.enter(&headers, peer).await?;
    if let Some(set_cookie) = result.set_cookie {
        let cookie = set_cookie
            .to_str()?
            .split(';')
            .next()
            .ok_or_else(|| anyhow::anyhow!("invalid cookie"))?;
        std::fs::write(&args[3], cookie)?;
        headers.insert(
            axum::http::header::COOKIE,
            axum::http::HeaderValue::from_str(cookie)?,
        );
        let again = entry.enter(&headers, peer).await?;
        anyhow::ensure!(
            again.workspace_id == result.workspace_id && again.set_cookie.is_none(),
            "Guest was recreated on resume"
        );
    } else {
        anyhow::ensure!(args[4] == "resume", "new Guest missing cookie");
    }
    headers.insert(
        axum::http::header::ORIGIN,
        axum::http::HeaderValue::from_static("https://evil.example.test"),
    );
    anyhow::ensure!(
        entry
            .enter(&headers, peer)
            .await
            .err()
            .is_some_and(|e| e.code == "ORIGIN_DENIED"),
        "hostile origin accepted"
    );
    println!("{}", serde_json::json!({"workspaceId":result.workspace_id}));
    Ok(())
}
