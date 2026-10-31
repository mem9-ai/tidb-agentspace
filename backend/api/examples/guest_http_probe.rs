//! Real HTTP integration against isolated Global and Region metadata. Never used by the host.
use serde_json::{Value, json};
use std::sync::Arc;
use workspace_api::{
    Config, GuestRuntime, WorkspaceServer, global_login::GlobalGuest, guest_entry::GuestEntry,
    managed_workspaces::ManagedWorkspaces, regional_guest::RegionalGuest,
};
use workspace_identity::{Directory, embedded_region::EmbeddedRegion};
use workspace_meta_client::{ClientConfig, RemoteMetadata};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(args.len() == 3, "expected isolated metadata configurations");
    let global: ClientConfig = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let region_json: Value = serde_json::from_slice(&std::fs::read(&args[2])?)?;
    let region: ClientConfig = serde_json::from_value(region_json.clone())?;
    let authority = region.authority_id.clone();
    let global_meta = Arc::new(RemoteMetadata::connect(global).await?);
    let regional_meta = Arc::new(RemoteMetadata::connect(region).await?);
    let signup = Arc::new(GlobalGuest::new(
        Directory::open(global_meta).await?,
        Arc::new(EmbeddedRegion::open(regional_meta.clone(), &authority).await?),
        authority.clone(),
    ));
    let regional =
        Arc::new(RegionalGuest::open(regional_meta.clone(), &authority, "/studio").await?);
    let entry = Arc::new(GuestEntry::new(
        Some(signup),
        regional.clone(),
        vec!["https://studio.example.test".into()],
    )?);
    let pool = Arc::new(ManagedWorkspaces::new(
        regional_meta.clone(),
        &authority,
        Some(Default::default()),
        4,
    )?);
    let runtime = Arc::new(GuestRuntime {
        entry,
        region: regional,
        workspaces: pool.clone(),
    });
    let socket = std::net::TcpListener::bind("127.0.0.1:0")?;
    let address = socket.local_addr()?;
    drop(socket);
    let config: Config = serde_json::from_value(json!({
        "bind": address.to_string(), "workspaceId": format!("fixture-{}", uuid::Uuid::new_v4()),
        "authorityId": authority, "initializeWorkspace": true,
        "metadata": {"transport":"remote", "client":region_json}, "insecureLoopback":true,
        "publicOrigins":["https://studio.example.test"], "publicPath":"/studio", "consoleOrigins":[],
        "sso":{"issuer":"https://issuer.example.test", "clientId":"fixture", "redirectUri":"https://studio.example.test/studio/api/auth/tidbcloud/callback"},
        "product":{}
    }))?;
    let server = WorkspaceServer::open_with_guest(config, regional_meta, Some(runtime)).await?;
    let legacy = server.workspace.clone();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(server.serve(async {
        let _ = stopped.await;
    }));
    let client = reqwest::Client::new();
    let base = format!("http://{address}/studio");
    let call = |method: reqwest::Method, path: String, cookie: Option<String>| {
        let mut request = client
            .request(method, format!("{base}{path}"))
            .header("Host", "studio.example.test")
            .header("Origin", "https://studio.example.test");
        if let Some(cookie) = cookie {
            request = request.header("Cookie", cookie);
        }
        request
    };
    let config: Value = call(reqwest::Method::GET, "/api/auth/config".into(), None)
        .send()
        .await?
        .json()
        .await?;
    anyhow::ensure!(
        config["guestEnabled"] == true,
        "Guest not enabled in fixture"
    );
    let mut guests = Vec::new();
    for _ in 0..2 {
        let response = call(reqwest::Method::POST, "/api/auth/guest".into(), None)
            .send()
            .await?;
        anyhow::ensure!(
            response.status().is_success(),
            "Guest entry failed: {}",
            response.status()
        );
        let set_cookie = response
            .headers()
            .get("set-cookie")
            .ok_or_else(|| anyhow::anyhow!("missing cookie"))?
            .to_str()?
            .to_owned();
        anyhow::ensure!(
            set_cookie.contains("HttpOnly")
                && set_cookie.contains("Secure")
                && set_cookie.contains("SameSite=Strict")
                && set_cookie.contains("Expires=")
                && set_cookie.contains("Path=/studio/"),
            "incorrect cookie policy"
        );
        let cookie = set_cookie.split(';').next().unwrap().to_string();
        let body: Value = response.json().await?;
        let id = body["workspaceId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing Workspace"))?
            .to_owned();
        anyhow::ensure!(
            !body.to_string().contains(&cookie),
            "credential leaked into JSON"
        );
        guests.push((id, cookie));
    }
    anyhow::ensure!(guests[0].0 != guests[1].0, "Guests share Workspace");
    for (id, cookie) in &guests {
        let response = call(
            reqwest::Method::POST,
            "/api/auth/guest".into(),
            Some(cookie.clone()),
        )
        .send()
        .await?;
        anyhow::ensure!(
            response.headers().get("set-cookie").is_none(),
            "Guest cookie unexpectedly replaced"
        );
        let body: Value = response.json().await?;
        anyhow::ensure!(body["workspaceId"] == *id, "Guest was recreated");
        let body: Value = call(
            reqwest::Method::GET,
            "/api/v1/workspaces".into(),
            Some(cookie.clone()),
        )
        .send()
        .await?
        .json()
        .await?;
        anyhow::ensure!(
            body["data"][0]["id"] == *id && body["data"].as_array().is_some_and(|a| a.len() == 1),
            "wrong Workspace listing: {body}"
        );
    }
    let created = call(
        reqwest::Method::POST,
        format!("/api/v1/workspaces/{}/resources", guests[0].0),
        Some(guests[0].1.clone()),
    )
    .json(&json!({"kind":"mysql","name":"guest-database","region":"aws-us-east-1"}))
    .send()
    .await?;
    anyhow::ensure!(
        created.status() == 201,
        "Guest resource creation failed: {}",
        created.status()
    );
    let second_resources: Value = call(
        reqwest::Method::GET,
        format!("/api/v1/workspaces/{}/resources", guests[1].0),
        Some(guests[1].1.clone()),
    )
    .send()
    .await?
    .json()
    .await?;
    anyhow::ensure!(
        second_resources["data"]
            .as_array()
            .is_some_and(|items| items.is_empty()),
        "Guest resource leaked"
    );
    let forged = guests[0].1.replace(&guests[0].0, &guests[1].0);
    let denied = call(
        reqwest::Method::GET,
        "/api/v1/workspaces".into(),
        Some(forged),
    )
    .send()
    .await?;
    anyhow::ensure!(
        denied.status() == 401,
        "modified Workspace cookie accepted: {}",
        denied.status()
    );
    let cross = call(
        reqwest::Method::GET,
        format!("/api/v1/workspaces/{}", guests[1].0),
        Some(guests[0].1.clone()),
    )
    .send()
    .await?;
    anyhow::ensure!(cross.status() == 404, "cross-Workspace request allowed");
    let modified = call(
        reqwest::Method::PATCH,
        format!("/api/v1/workspaces/{}/settings", guests[0].0),
        Some(guests[0].1.clone()),
    )
    .json(&json!({"workspaceName":"First Guest","name":"First"}))
    .send()
    .await?;
    anyhow::ensure!(
        modified.status().is_success(),
        "settings failed: {}",
        modified.status()
    );
    let second: Value = call(
        reqwest::Method::GET,
        format!("/api/v1/workspaces/{}", guests[1].0),
        Some(guests[1].1.clone()),
    )
    .send()
    .await?
    .json()
    .await?;
    anyhow::ensure!(
        second["data"]["name"] != "First Guest",
        "Guest settings leaked"
    );
    stop.send(())
        .map_err(|_| anyhow::anyhow!("server stopped"))?;
    handle.await??;
    pool.close().await?;
    legacy.close().await?;
    println!("{{\"isolated\":true,\"cookie\":true}}");
    Ok(())
}
