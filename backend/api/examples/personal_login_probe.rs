//! Isolated integration fixture. This is not a public login endpoint or deployment role.
use std::{collections::BTreeMap, sync::Arc};
use workspace_api::global_login::{GlobalLogin, SsoConfig};
use workspace_identity::{Directory, embedded_region::EmbeddedRegion};
use workspace_meta_client::{ClientConfig, RemoteMetadata};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(args.len() == 4, "expected isolated fixture configurations");
    let config: SsoConfig = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let global: ClientConfig = serde_json::from_slice(&std::fs::read(&args[2])?)?;
    let region: ClientConfig = serde_json::from_slice(&std::fs::read(&args[3])?)?;
    let authority = region.authority_id.clone();
    let global_meta = Arc::new(RemoteMetadata::connect(global).await?);
    let region_meta = Arc::new(RemoteMetadata::connect(region).await?);
    let login = GlobalLogin::new(
        config,
        "/studio",
        true,
        Directory::open(global_meta).await?,
        Arc::new(EmbeddedRegion::open(region_meta, &authority).await?),
        authority,
    )?;
    let (authorization_url, flow) = login.begin("127.0.0.1").await?;
    let url = reqwest::Url::parse(&authorization_url)?;
    let state = url
        .query_pairs()
        .find_map(|(key, value)| (key == "state").then_some(value.into_owned()))
        .ok_or_else(|| anyhow::anyhow!("Missing state"))?;
    let response: serde_json::Value = reqwest::get(url).await?.error_for_status()?.json().await?;
    let code = response["code"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Fixture did not return a code"))?;
    let query = BTreeMap::from([("state".into(), state), ("code".into(), code.into())]);
    let registration = login.finish(&flow, &query).await?;
    anyhow::ensure!(
        login.finish(&flow, &query).await.is_err(),
        "Flow replay accepted"
    );
    println!("{}", serde_json::to_string(&registration)?);
    Ok(())
}
