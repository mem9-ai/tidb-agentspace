use anyhow::{Context, Result, ensure};
use reqwest::{Method, RequestBuilder, Response};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::Path, process::Command, time::Duration};
use uuid::Uuid;
use workspace_test_support::{
    Fixture, Meta, Process, binary, http_client, port, private_json, provider::Provider,
    session::assert_session_contract,
};

#[path = "cases/guest_csv.rs"]
mod csv;
struct Host {
    root: String,
    client: reqwest::Client,
}
impl Host {
    fn request(&self, m: Method, path: &str, cookie: &str) -> RequestBuilder {
        let req = self
            .client
            .request(m, format!("{}{path}", self.root))
            .header("Host", "studio.example.test")
            .header("Origin", "https://studio.example.test");
        if cookie.is_empty() {
            req
        } else {
            req.header("Cookie", cookie)
        }
    }
    async fn start(&self, dir: &Path, plan: &Path) -> Result<Process> {
        let mut process = Process::spawn(
            Command::new(binary("workspace-backend"))
                .args(["serve", "--config"])
                .arg(plan)
                .env("WORKSPACE_GUEST_ENABLED", "true"),
            &dir.join(format!("host-{}.log", Uuid::new_v4())),
        )?;
        tokio::time::timeout(Duration::from_secs(25), async {
            loop {
                process.ensure_running()?;
                if self
                    .request(Method::GET, "/api/health", "")
                    .send()
                    .await
                    .is_ok_and(|r| r.status() == 200)
                {
                    return Ok::<_, anyhow::Error>(());
                }
                tokio::time::sleep(Duration::from_millis(80)).await;
            }
        })
        .await??;
        Ok(process)
    }
    async fn guest(&self) -> Result<Guest> {
        let res = self
            .request(Method::POST, "/api/auth/guest", "")
            .send()
            .await?;
        assert_eq!(res.status(), 200);
        let cookie = res.headers()["set-cookie"]
            .to_str()?
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        assert_session_contract(&cookie);
        let body = res.json::<Value>().await?;
        assert_eq!(body["initialFileSystemRegion"], "aws-ap-southeast-1");
        Ok(Guest {
            cookie,
            id: body["workspaceId"]
                .as_str()
                .context("workspace")?
                .to_owned(),
        })
    }
}
struct Guest {
    cookie: String,
    id: String,
}
impl Guest {
    fn path(&self, tail: &str) -> String {
        format!("/api/portal/v1/workspaces/{}{tail}", self.id)
    }
    fn req(&self, host: &Host, method: Method, tail: &str) -> RequestBuilder {
        host.request(method, &self.path(tail), &self.cookie)
    }
    async fn provision(&self, host: &Host, kind: &str) -> Result<()> {
        let res=self.req(host,Method::POST,"/resources").header("Idempotency-Key",format!("guest-{kind}")).json(&json!({"kind":kind,"name":format!("guest-{kind}"),"region":if kind=="filesystem"{"aws-ap-southeast-1"}else{"automatic"}})).send().await?;
        assert_eq!(res.status(), 201);
        assert_eq!(res.json::<Value>().await?["data"]["status"], "active");
        Ok(())
    }
}
fn scope(meta: &Meta, shard: u8) -> Value {
    json!({"authorityId":meta.server["authorityId"],"ownerKind":"system","ownerId":"guest-cleanup","family":"guest-cleanup","partitionId":format!("shard-{shard:02}")})
}
async fn cleanup(meta: &Meta, scope: &Value, ws: &str, state: &str) -> Result<Value> {
    tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            let page = meta
                .call(json!({"op":"list","scope":scope,"prefix":"job/","limit":128}))
                .await?;
            if let Some(job) = page["records"]
                .as_array()
                .context("jobs")?
                .iter()
                .map(|r| &r["value"])
                .find(|job| job["workspaceId"] == ws && job["status"]["state"] == state)
            {
                return Ok::<_, anyhow::Error>(job.clone());
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    })
    .await?
}
async fn status(req: RequestBuilder, expected: u16) -> Result<Response> {
    let res = req.send().await?;
    assert_eq!(res.status().as_u16(), expected);
    Ok(res)
}
#[tokio::test]
#[ignore = "requires native hosts, identity probe and RustFS"]
async fn hosted_guests_keep_private_workspaces_and_csv_during_global_outage() -> Result<()> {
    let f = Fixture::start().await?;
    let provider = Provider::start(true).await?;
    let mut global = f.meta("global").await?;
    let mut region = f.meta("guest-host").await?;
    let dir = f.directory();
    let client_path = dir.join("client.json");
    private_json(&client_path, &region.client)?;
    let expired = Command::new(binary("examples").join("identity_probe"))
        .arg(&client_path)
        .args(["--expired-guest-check", "-", "-"])
        .output()?;
    ensure!(expired.status.success(), "expired guest probe");
    let expired: Value = serde_json::from_slice(&expired.stdout)?;
    assert_eq!(expired["expiredGuestRejected"], true);
    region.process.stop()?;
    global.process.stop()?;
    let bind = format!("127.0.0.1:{}", port()?);
    let api_path = dir.join("api.json");
    let global_path = dir.join("global-role.json");
    let regional_path = dir.join("region-role.json");
    let plan = dir.join("host.json");
    let mut api = json!({"bind":bind,"workspaceId":"ws_guest_host_fixture","authorityId":region.server["authorityId"],"initializeWorkspace":true,"metadata":{"transport":"inProcess","authorityId":region.server["authorityId"]},"insecureLoopback":true,"publicOrigins":["https://studio.example.test"],"publicPath":"/studio","consoleOrigins":[],"sso":{"issuer":"https://issuer.example.test","clientId":"fixture","redirectUri":"https://studio.example.test/studio/api/auth/tidbcloud/callback"},"product":{"providers":{"filesProvider":"drive9-anonymous","postgresProvider":"db9-anonymous","testMode":true,"drive9Endpoint":provider.origin,"db9Endpoint":format!("{}/customer",provider.origin),"sqlFixture":format!("{}/sql",provider.origin)}}});
    private_json(&api_path, &api)?;
    private_json(&global_path, &global.server)?;
    private_json(&regional_path, &region.server)?;
    private_json(
        &plan,
        &json!({"format":1,"services":[{"kind":"metadata","configFile":global_path},{"kind":"metadata","configFile":regional_path},{"kind":"workspace","configFile":api_path}]}),
    )?;
    let host = Host {
        root: format!("http://{bind}/studio"),
        client: http_client()?,
    };
    let mut running = host.start(dir, &plan).await?;
    cleanup(
        &region,
        &scope(&region, 0),
        expired["workspaceId"].as_str().unwrap(),
        "complete",
    )
    .await?;
    let first = host.guest().await?;
    let second = host.guest().await?;
    assert_ne!(first.id, second.id);
    for g in [&first, &second] {
        g.provision(&host, "postgresql").await?;
        g.provision(&host, "filesystem").await?;
    }
    let sample_owner = host.guest().await?;
    let sample = status(
        sample_owner
            .req(&host, Method::POST, "/sales-sample-attempts")
            .header("Idempotency-Key", Uuid::new_v4().to_string())
            .json(&json!({"fixture":"us-sales-v1"})),
        201,
    )
    .await?
    .json::<Value>()
    .await?["data"]
        .clone();
    assert_eq!(sample["status"], "ready");
    let sample_route = sample_owner.path(&format!(
        "/sales-sample-attempts/{}",
        sample["id"].as_str().unwrap()
    ));
    status(host.request(Method::GET, &sample_route, &first.cookie), 404).await?;
    let marker = status(first.req(&host, Method::GET, "/resources"), 200)
        .await?
        .headers()["x-request-id"]
        .to_str()?
        .to_owned();
    let history = async |g: &Guest| -> Result<bool> {
        let data = status(g.req(&host, Method::GET, "/request-history"), 200)
            .await?
            .json::<Value>()
            .await?;
        Ok(data["data"]
            .as_array()
            .context("history")?
            .iter()
            .any(|r| r["requestId"] == marker))
    };
    tokio::time::timeout(Duration::from_secs(10), async {
        while !history(&first).await? {
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    assert!(!history(&second).await?);
    let session = status(
        host.request(Method::GET, "/api/auth/config", &first.cookie),
        200,
    )
    .await?
    .json::<Value>()
    .await?;
    assert_eq!(session["sessionKind"], "guest");
    assert_eq!(session["workspaceId"], first.id);
    assert!(
        status(host.request(Method::GET, "/api/auth/config", ""), 200)
            .await?
            .json::<Value>()
            .await?["workspaceId"]
            .is_null()
    );
    status(
        host.request(Method::GET, &second.path(""), &first.cookie),
        404,
    )
    .await?;
    let ws = || host.request(Method::GET, "/api/portal/v1/workspaces", &first.cookie);
    assert_eq!(
        status(ws(), 200).await?.json::<Value>().await?["data"][0]["id"],
        first.id
    );
    status(
        first.req(&host, Method::POST, "/keys").json(&json!({})),
        404,
    )
    .await?;
    let key_request = || {
        host.request(
            Method::GET,
            &format!("/api/v1/workspaces/{}/resources", first.id),
            "",
        )
        .bearer_auth("retired-guest-key")
    };
    status(key_request(), 401).await?;
    let csv = csv::exercise(&host, &first).await?;
    running.terminate()?;
    running.wait_success()?;
    api["initializeWorkspace"] = json!(false);
    private_json(&api_path, &api)?;
    global.server["s3"]["prefix"] = json!("intentionally-offline-root");
    private_json(&global_path, &global.server)?;
    let mut running = host.start(dir, &plan).await?;
    csv.resume(&host).await?;
    let reopened = status(
        host.request(Method::GET, &sample_route, &sample_owner.cookie),
        200,
    )
    .await?
    .json::<Value>()
    .await?;
    assert_eq!(reopened["data"]["fileVersion"], sample["fileVersion"]);
    assert_eq!(
        status(
            host.request(Method::POST, "/api/auth/guest", &first.cookie),
            200
        )
        .await?
        .json::<Value>()
        .await?["workspaceId"],
        first.id
    );
    assert_eq!(
        status(ws(), 200).await?.json::<Value>().await?["data"][0]["id"],
        first.id
    );
    status(host.request(Method::POST, "/api/auth/guest", ""), 503).await?;
    let logout = |cookie: &str| host.request(Method::POST, "/api/auth/guest/logout", cookie);
    status(logout(""), 401).await?;
    status(logout(&first.cookie.replace(&first.id, &second.id)), 401).await?;
    status(
        host.client
            .post(format!("{}/api/auth/guest/logout", host.root))
            .header("Host", "studio.example.test")
            .header("Cookie", &first.cookie)
            .header("Origin", "https://evil.example"),
        403,
    )
    .await?;
    assert!(provider.state.lock().unwrap().deleted.is_empty());
    status(
        host.request(Method::GET, "/api/auth/tidbcloud/logout", &first.cookie),
        405,
    )
    .await?;
    let res = status(logout(&first.cookie), 200).await?;
    assert!(res.headers().get_all("set-cookie").iter().any(|h| {
        h.to_str()
            .is_ok_and(|s| s.starts_with("aw_guest=;") && s.contains("Max-Age=0"))
    }));
    assert_eq!(res.json::<Value>().await?["cleanup"], "scheduled");
    for r in [ws(), key_request()] {
        assert!([401, 403].contains(&r.send().await?.status().as_u16()));
    }
    status(
        host.request(Method::GET, "/api/portal/v1/workspaces", &second.cookie),
        200,
    )
    .await?;
    let shard = Sha256::digest(first.id.as_bytes())[0] % 64;
    let scope = scope(&region, shard);
    // Losing the response to the provider deletion must leave a deferred cleanup job.
    let job = cleanup(&region, &scope, &first.id, "deferred").await?;
    assert_eq!(job["status"]["reason"], "providerOutcomeUncertain");
    let mut deleted = provider.state.lock().unwrap().deleted.clone();
    deleted.sort();
    assert_eq!(
        deleted,
        vec![
            ("db9".into(), "pg0".into()),
            ("drive9".into(), "created-tenant-1".into())
        ]
    );
    let key = format!("logout/{}", first.id);
    assert!(
        region
            .call(json!({"op":"get","scope":scope,"keys":[key]}))
            .await?["records"][&key]
            .is_null()
    );
    let remaining = status(second.req(&host, Method::GET, "/resources"), 200)
        .await?
        .json::<Value>()
        .await?;
    assert_eq!(remaining["data"].as_array().unwrap().len(), 2);
    running.terminate()?;
    running.wait_success()?;
    Ok(())
}
