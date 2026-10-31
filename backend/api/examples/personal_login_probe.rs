//! Isolated integration fixture. This is not a public login endpoint or deployment role.
use std::{collections::BTreeMap, sync::Arc};
use workspace_api::global_login::{GlobalLogin, SsoConfig};
use workspace_identity::{
    Directory, embedded_region::EmbeddedRegion, global_owner_sessions::OwnerSessions,
};
use workspace_meta_client::{ClientConfig, RemoteMetadata};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(
        args.len() == 4 || args.len() == 5,
        "expected isolated fixture configurations"
    );
    let config: SsoConfig = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let global: ClientConfig = serde_json::from_slice(&std::fs::read(&args[2])?)?;
    let region: ClientConfig = serde_json::from_slice(&std::fs::read(&args[3])?)?;
    let authority = region.authority_id.clone();
    let other_connection = Arc::new(RemoteMetadata::connect(global.clone()).await?);
    let global_meta = Arc::new(RemoteMetadata::connect(global).await?);
    let region_meta = Arc::new(RemoteMetadata::connect(region).await?);
    let login = GlobalLogin::new(
        config,
        "/studio",
        true,
        Directory::open(global_meta.clone()).await?,
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
    let sessions = OwnerSessions::open(global_meta).await?;
    let (authorization_url, session_flow) = login.begin("127.0.0.1").await?;
    let url = reqwest::Url::parse(&authorization_url)?;
    let state = url
        .query_pairs()
        .find_map(|(key, value)| (key == "state").then_some(value.into_owned()))
        .ok_or_else(|| anyhow::anyhow!("Missing state"))?;
    let response: serde_json::Value = reqwest::get(url).await?.error_for_status()?.json().await?;
    let code = response["code"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing fixture code"))?;
    let session_query = BTreeMap::from([("state".into(), state), ("code".into(), code.into())]);
    let unbound = OwnerSessions::open(other_connection).await?;
    anyhow::ensure!(
        login
            .finish_owner_session(
                &unbound,
                &session_flow,
                &session_query,
                &registration.workspace_id
            )
            .await
            .is_err()
    );
    let session = login
        .finish_owner_session(
            &sessions,
            &session_flow,
            &session_query,
            &registration.workspace_id,
        )
        .await?;
    let authenticated = sessions
        .authenticate(&registration.workspace_id, &session.secret)
        .await?;
    anyhow::ensure!(authenticated.assignment().region_id == registration.region_id);
    anyhow::ensure!(
        sessions
            .authenticate(&uuid::Uuid::new_v4().to_string(), &session.secret)
            .await
            .is_err()
    );
    anyhow::ensure!(
        login
            .finish_owner_session(
                &sessions,
                &session_flow,
                &session_query,
                &registration.workspace_id
            )
            .await
            .is_err()
    );
    if let Some(path) = args.get(4) {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(session.secret.as_bytes())?;
    } else {
        sessions
            .revoke(
                &registration.workspace_id,
                &session.secret,
                &uuid::Uuid::new_v4().to_string(),
            )
            .await?;
        anyhow::ensure!(
            sessions
                .authenticate(&registration.workspace_id, &session.secret)
                .await
                .is_err()
        );
    }
    for workspace in [&registration.workspace_id, "foreign-workspace"] {
        let (authorization_url, flow) = login.begin("127.0.0.1").await?;
        let url = reqwest::Url::parse(&authorization_url)?;
        let state = url
            .query_pairs()
            .find_map(|(key, value)| (key == "state").then_some(value.into_owned()))
            .ok_or_else(|| anyhow::anyhow!("Missing state"))?;
        let response: serde_json::Value =
            reqwest::get(url).await?.error_for_status()?.json().await?;
        let code = response["code"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Fixture did not return a code"))?;
        let query = BTreeMap::from([("state".into(), state), ("code".into(), code.into())]);
        let found = login.finish_discovery(&flow, &query, workspace).await;
        if workspace == registration.workspace_id {
            let found = found?;
            anyhow::ensure!(found.workspace_id == registration.workspace_id);
            anyhow::ensure!(found.region_id == registration.region_id);
        } else {
            anyhow::ensure!(found.is_err_and(|e| e.status == 404));
        }
        anyhow::ensure!(
            login
                .finish_discovery(&flow, &query, workspace)
                .await
                .is_err()
        );
    }
    println!("{}", serde_json::to_string(&registration)?);
    Ok(())
}
