use super::site::{GLOBAL, Profile, Site, expect};
use anyhow::{Context, Result, ensure};
use reqwest::{Certificate, Client, Identity, Method, tls::Version};
use serde_json::{Value, json};
use std::{
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};
use uuid::Uuid;
use workspace_test_support::{
    Process, binary, port, private_json, private_write, tls::certificates,
};

struct Analytics {
    process: Option<Process>,
    config: Value,
    client: Value,
    plan: PathBuf,
    config_file: PathBuf,
    tls: Value,
    bind: SocketAddr,
}

fn bytes(cfg: &Value, name: &str) -> Result<Vec<u8>> {
    Ok(fs::read(cfg[name].as_str().context("missing TLS path")?)?)
}

fn tls_client(
    tls: &Value,
    id: Option<&Value>,
    server: SocketAddr,
    version: Version,
) -> Result<Client> {
    let mut builder = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .tls_version_min(version)
        .tls_version_max(version)
        .resolve("wrong.example", server)
        .tls_certs_only(Certificate::from_pem_bundle(&bytes(tls, "caFile")?)?)
        .timeout(Duration::from_secs(3));
    if let Some(id) = id {
        let pem = [
            bytes(id, "certificateFile")?,
            b"\n".to_vec(),
            bytes(id, "privateKeyFile")?,
        ]
        .concat();
        builder = builder.identity(Identity::from_pem(&pem)?);
    }
    Ok(builder.build()?)
}

impl Analytics {
    async fn new(
        dir: &Path,
        server: &Value,
        name: &str,
        tls_server: &Value,
        tls_client: &Value,
        local: bool,
    ) -> Result<Self> {
        let bind = SocketAddr::from(([127, 0, 0, 1], port()?));
        let endpoint = format!("https://{bind}");
        let secret = |file: &str, encoded: bool| -> Result<PathBuf> {
            let path = dir.join(format!("analytics-{name}-{file}"));
            let mut random = [0; 32];
            getrandom::fill(&mut random).map_err(|_| anyhow::anyhow!("random key generation"))?;
            if encoded {
                private_write(&path, hex::encode(random).as_bytes())?;
            } else {
                private_write(&path, &random)?;
            }
            Ok(path)
        };
        let token = secret("token", true)?;
        let mut config = json!({"authorityId":server["authorityId"],"installationId":format!("analytics-{name}"),"bind":bind,"tokenFile":token,
            "encryptionKeyFile":secret("encryption",true)?,"pseudonymKeyFile":secret("pseudonym",false)?,"campaigns":["launch"],"insecureLoopback":false,"tls":tls_server});
        let prefix = format!("analytics/{name}");
        if local {
            let root = dir.join(format!("analytics-{name}"));
            fs::create_dir(&root)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
            }
            config["local"] = json!({"directory":root,"prefix":prefix});
        } else {
            config["s3"] = server["s3"].clone();
            config["s3"]["prefix"] = json!(prefix);
            config["s3"]["allowLoopbackHttp"] = json!(true);
        }
        let config_file = dir.join(format!("analytics-{name}.json"));
        private_json(&config_file, &config)?;
        let client = json!({"endpoint":endpoint,"tokenFile":token,"insecureLoopback":false,"tls":tls_client});
        let mut result = Self {
            config,
            client,
            bind,
            config_file,
            tls: tls_client.clone(),
            plan: dir.join(format!("analytics-{name}-plan.json")),
            process: None,
        };
        result.start(true).await?;
        Ok(result)
    }
    fn stop(&mut self) -> Result<()> {
        if let Some(mut p) = self.process.take() {
            p.stop()?;
        }
        Ok(())
    }
    async fn start(&mut self, initialize: bool) -> Result<()> {
        private_json(
            &self.plan,
            &json!({"format":1,"services":[{"kind":"analytics","configFile":self.config_file,"initialize":initialize}]}),
        )?;
        let log = self.plan.with_extension(format!("{}.log", Uuid::new_v4()));
        let mut proc = Process::spawn(
            Command::new(binary("workspace-backend"))
                .args(["serve", "--config"])
                .arg(&self.plan),
            &log,
        )?;
        let http = tls_client(&self.tls, Some(&self.tls), self.bind, Version::TLS_1_3)?;
        let deadline = Instant::now() + Duration::from_secs(20);
        while !http
            .get(format!("https://{}/health", self.bind))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            proc.ensure_running()
                .context("Isolated analytics did not start")?;
            ensure!(Instant::now() < deadline, "Analytics health timeout");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        self.process = Some(proc);
        Ok(())
    }
}

async fn footprint(site: &Site) -> Result<()> {
    for meta in [&site.region, site.global.as_ref().unwrap()] {
        let page=meta.call(json!({"op":"list","scope":{"authorityId":meta.server["authorityId"],"ownerKind":"system","ownerId":"product-analytics","family":"analytics-v1","partitionId":"daily"},"prefix":"","limit":100})).await?;
        assert_eq!(page["records"], json!([]));
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated RustFS, mTLS and native binaries"]
async fn operator_authentication_capture_and_independent_analytics_recovery() -> Result<()> {
    let mut site = Site::prepare(Profile::Global, false, json!({})).await?;
    let dir = site.fixture.directory();
    let tls_dir = dir.join("analytics-tls");
    fs::create_dir(&tls_dir)?;
    let (server, tls) = certificates(&tls_dir)?;
    let mut regional =
        Analytics::new(dir, &site.region.server, "regional", &server, &tls, false).await?;
    let mut global = Analytics::new(
        dir,
        &site.global.as_ref().unwrap().server,
        "global",
        &server,
        &tls,
        true,
    )
    .await?;
    let policy_file = dir.join("analytics-operators.json");
    let allowed = json!({"subjects":[],"verifiedEmailDomains":["pingcap.com"]});
    private_json(&policy_file, &allowed)?;
    site.config["analytics"] = json!({"enabled":true,"service":regional.client});
    site.global_config.as_mut().unwrap()["analytics"] = json!({"service":global.client,"operatorsFile":policy_file,"returnUrl":"https://studio.example.test/studio/admin","browserEnabled":true,"campaigns":["launch"]});
    site.start().await?;
    let token = fs::read_to_string(regional.config["tokenFile"].as_str().unwrap())?;
    let endpoint = format!("https://{}/analytics/v1/summary", regional.bind);
    let tls_http = tls_client(&tls, Some(&tls), regional.bind, Version::TLS_1_3)?;
    let authority = regional.config["authorityId"].as_str().unwrap();
    expect(tls_http.post(&endpoint).json(&json!({})), 403).await?;
    let summary_call = |http: &Client, host: &str| {
        http.post(host)
            .bearer_auth(&token)
            .header("x-analytics-authority", authority)
            .json(&json!({}))
    };
    expect(
        tls_http
            .post(&endpoint)
            .bearer_auth(&token)
            .header("x-analytics-authority", "global")
            .json(&json!({})),
        403,
    )
    .await?;
    expect(
        summary_call(&tls_http, &endpoint).header("Origin", "https://studio.example.test"),
        403,
    )
    .await?;
    for id in [None, Some(&server)] {
        assert!(
            summary_call(
                &tls_client(&tls, id, regional.bind, Version::TLS_1_3)?,
                &endpoint
            )
            .send()
            .await
            .is_err()
        );
    }
    let wrong = format!(
        "https://wrong.example:{}/analytics/v1/summary",
        regional.bind.port()
    );
    assert!(summary_call(&tls_http, &wrong).send().await.is_err());
    assert!(
        summary_call(
            &tls_client(&tls, Some(&tls), regional.bind, Version::TLS_1_2)?,
            &endpoint
        )
        .send()
        .await
        .is_err()
    );
    let b = site.browser.clone();
    let summary = format!("{GLOBAL}/operator/analytics/summary");
    let session = format!("{GLOBAL}/operator/session");
    let events = format!("{GLOBAL}/analytics/events");
    b.get(&summary, "", 401).await?;
    expect(
        b.request(Method::GET, &summary, "")
            .bearer_auth("customer-key"),
        403,
    )
    .await?;
    let batch = json!({"version":1,"sessionId":Uuid::new_v4().to_string(),"events":[{"id":Uuid::new_v4().to_string(),
        "event":{"name":"public_page_view","page":"home","source":"social","device":"desktop","campaign":"launch"}}]});
    let ingest = b.post(&events, "", batch.clone(), 202).await?;
    assert_eq!(ingest.body["durability"], "queued");
    b.post(&events, "", batch.clone(), 202).await?;
    let mut forged = batch.clone();
    forged["workspaceId"] = json!("forged");
    b.post(&events, "", forged, 422).await?;
    expect(
        b.request(Method::POST, &events, "")
            .headers(super::site::override_header("Origin", "https://evil.test"))
            .json(&batch),
        403,
    )
    .await?;
    expect(
        b.request(Method::POST, &events, "")
            .header("Sec-GPC", "1")
            .json(&batch),
        204,
    )
    .await?;
    let off = expect(
        b.request(Method::DELETE, &format!("{GLOBAL}/analytics/session"), ""),
        204,
    )
    .await?;
    assert_eq!(off.cookie("aw_analytics_off")?, "aw_analytics_off=1");
    b.post(&events, "aw_analytics_off=1", batch.clone(), 204)
        .await?;
    for (email, verified) in [
        ("alice@pingcap.com", false),
        ("alice@pingcap.com.evil.test", true),
        ("alice@sub.pingcap.com", true),
        ("alice@example.org", true),
    ] {
        site.oidc
            .claims(json!({"email":email,"email_verified":verified}));
        b.login(true, 403).await?;
    }
    site.oidc
        .claims(json!({"email":"alice@pingcap.com","email_verified":true}));
    let login = b.flow(true).await?;
    let accepted = b.callback(&login, 303).await?;
    assert_eq!(
        accepted.location(),
        "https://studio.example.test/studio/admin"
    );
    let admin = accepted.cookie("aw_operator")?;
    assert!(
        accepted
            .cookies()
            .iter()
            .any(|c| c.contains("HttpOnly; SameSite=Strict; Secure; Path=/studio/"))
    );
    b.callback(&login, 400).await?;
    let mut normal = b.flow(false).await?;
    normal.cookie.push_str("; ");
    normal
        .cookie
        .push_str(ingest.cookies()[0].split(';').next().unwrap());
    let account = b.callback(&normal, 302).await?;
    let owner = account
        .cookies()
        .into_iter()
        .map(|c| c.split(';').next().unwrap())
        .collect::<Vec<_>>()
        .join("; ");
    b.get(&session, &owner, 401).await?;
    let ws = super::workspace(&b, &owner).await?;
    let base = format!("/studio/api/v1/workspaces/{ws}");
    let resource = b
        .post(
            &format!("{base}/resources"),
            &owner,
            json!({"kind":"filesystem","name":"report-files","region":"aws-ap-southeast-1"}),
            201,
        )
        .await?;
    let id = &resource.body["data"]["id"];
    let files = format!("{base}/files");
    let write = |cookie: &str, path: &str, purpose: bool| {
        let mut file = json!({"resourceId":id,"path":path,"type":"file","content":"# Findings\nVerified report save"});
        if purpose {
            file["purpose"] = json!("report");
        }
        b.request(Method::PUT, &files, cookie)
            .header("If-None-Match", "*")
            .json(&file)
    };
    expect(write(&owner, "/findings.md", true), 200).await?;
    expect(write(&owner, "/findings.md", true), 412).await?;
    let today = chrono::Utc::now().date_naive();
    let date_query = format!("{summary}?from={today}&to={}", today.succ_opt().unwrap());
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let r = b.get(&date_query, &admin, 200).await?;
        assert_eq!(r.body["missingRegions"], json!([]));
        let g = &r.body["authorities"][0];
        let region = &r.body["authorities"][1];
        if g["sessions"] == 1
            && g["trials"] == 1
            && g["counts"]["events"]["sign_in_completed"] == 1
            && g["counts"]["pageViews"] == 1
            && region["counts"]["events"]["report_saved:success"] == 1
            && region["firstUseCampaigns"]["launch"] == 1
            && region["counts"]["events"]["report_saved:failure"] == 1
        {
            assert!(!r.body.to_string().contains("Verified report save"));
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "Missing analytics counters in isolated service"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let log = fs::read_to_string(&site.log)?;
    let security: Vec<Value> = log
        .lines()
        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
        .filter(|v| v["stream"] == "operator_security")
        .collect();
    for event in [
        "sign_in_allowed",
        "sign_in_denied",
        "request_denied",
        "read_authorized",
    ] {
        assert!(security.iter().any(|v| v["event"] == event));
    }
    for record in &security {
        let mut fields: Vec<_> = record
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        fields.sort_unstable();
        assert_eq!(fields, ["at", "event", "stream"]);
    }
    let redacted = serde_json::to_string(&security)?;
    assert!(
        !redacted.contains("alice@pingcap.com")
            && !redacted.contains(admin.split_once('=').unwrap().1)
    );
    private_json(
        &policy_file,
        &json!({"subjects":[],"verifiedEmailDomains":[]}),
    )?;
    b.get(&session, &admin, 403).await?;
    private_json(&policy_file, &allowed)?;
    b.post(
        &format!("{GLOBAL}/operator/auth/logout"),
        &admin,
        json!({}),
        204,
    )
    .await?;
    b.get(&session, &admin, 401).await?;
    site.stop()?;
    site.steady();
    site.start().await?;
    let admin = b.login(true, 303).await?.cookie("aw_operator")?;
    let persisted = b.get(&date_query, &admin, 200).await?.body;
    assert_eq!(persisted["authorities"][0]["counts"]["pageViews"], 1);
    assert_eq!(
        persisted["authorities"][1]["counts"]["events"]["report_saved:success"],
        1
    );
    footprint(&site).await?;
    regional.stop()?;
    global.stop()?;
    let live = b.login(false, 302).await?.cookie("aw_account")?;
    expect(write(&live, "/while-service-is-down.txt", false), 200).await?;
    b.get(&summary, &admin, 503).await?;
    let mut tokens = vec![];
    for s in [&global, &regional] {
        let path = PathBuf::from(s.config["tokenFile"].as_str().unwrap());
        tokens.push((path.clone(), fs::read(&path)?));
        fs::remove_file(path)?;
    }
    site.stop()?;
    site.start().await?;
    let live = b.login(false, 302).await?.cookie("aw_account")?;
    expect(write(&live, "/during-analytics-outage.txt", false), 200).await?;
    b.get(
        &summary,
        &b.login(true, 303).await?.cookie("aw_operator")?,
        503,
    )
    .await?;
    for (p, t) in tokens {
        private_write(&p, &t)?;
    }
    regional.start(false).await?;
    global.start(false).await?;
    site.stop()?;
    site.start().await?;
    let restored = b
        .get(
            &date_query,
            &b.login(true, 303).await?.cookie("aw_operator")?,
            200,
        )
        .await?;
    assert_eq!(
        restored.body["authorities"][1]["counts"]["events"]["report_saved:success"],
        1
    );
    footprint(&site).await?;
    Ok(())
}
