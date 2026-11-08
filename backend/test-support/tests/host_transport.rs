use anyhow::{Context, Result, ensure};
use reqwest::{Client, Method, RequestBuilder};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};
use uuid::Uuid;
use workspace_test_support::{
    Fixture, Meta, Process, binary, http_client, port, private_json, private_write,
};

fn config(directory: &Path, name: &str, value: &Value) -> Result<PathBuf> {
    let path = directory.join(format!("{name}.json"));
    private_json(&path, value)?;
    Ok(path)
}
fn launch(directory: &Path, roles: &Value) -> Result<Process> {
    let name = Uuid::new_v4().to_string();
    let path = config(directory, &name, &json!({"format":1,"services":roles}))?;
    Process::spawn(
        Command::new(binary("workspace-backend"))
            .args(["serve", "--config"])
            .arg(path),
        &directory.join(format!("{name}.log")),
    )
}
struct Session {
    client: Client,
    origin: String,
    cookie: String,
}
impl Session {
    async fn connect(process: &mut Process, bind: &str) -> Result<Self> {
        let client = http_client()?;
        let origin = format!("http://{bind}");
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            process.ensure_running()?;
            let session = client
                .post(format!("{origin}/api/session"))
                .json(&json!({}))
                .send()
                .await;
            if let Ok(res) = session
                && res.status() == 200
            {
                let cookie = res
                    .headers()
                    .get("set-cookie")
                    .context("session cookie")?
                    .to_str()?;
                ensure!(
                    cookie.contains("HttpOnly; SameSite=Strict"),
                    "cookie missing security attributes"
                );
                return Ok(Self {
                    client,
                    origin,
                    cookie: cookie.split(';').next().unwrap().into(),
                });
            }
            ensure!(Instant::now() < end, "could not acquire session");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    fn owner(&self, method: Method, workspace: &str, path: &str) -> RequestBuilder {
        self.client
            .request(
                method,
                format!("{}/api/portal/v1/workspaces/{workspace}{path}", self.origin),
            )
            .header("Cookie", &self.cookie)
    }
    fn key(&self, workspace: &str, path: &str, token: &str) -> RequestBuilder {
        self.client
            .get(format!(
                "{}/api/v1/workspaces/{workspace}{path}",
                self.origin
            ))
            .bearer_auth(token)
    }
}

#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn rejects_shared_authority_and_storage_before_opening_writer() -> Result<()> {
    let f = Fixture::start().await?;
    let mut meta = f.meta("a").await?;
    meta.process.stop()?;
    let dir = f.directory();
    let first = config(dir, "first", &meta.server)?;
    for duplicate in [true, false] {
        let mut other = meta.server.clone();
        other["authorityId"] = json!("region:other");
        other["installationId"] = json!("other-installation");
        other["bind"] = json!(format!("127.0.0.1:{}", port()?));
        for prop in ["tokenFile", "encryptionKeyFile"] {
            let path = dir.join(Uuid::new_v4().to_string());
            private_write(
                &path,
                format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()).as_bytes(),
            )?;
            other[prop] = json!(path);
        }
        if duplicate {
            other["authorityId"] = meta.server["authorityId"].clone();
        } else {
            other["s3"]["prefix"] = json!("metadata/overlap");
        }
        let second = config(dir, "second", &other)?;
        let mut host = launch(
            dir,
            &json!([{"kind":"metadata","configFile":first},{"kind":"metadata","configFile":second}]),
        )?;
        assert!(!host.wait_for_exit(Duration::from_secs(20)).await?.success());
    }
    let restored = f.start_meta(meta.server.clone(), false, None).await?;
    assert_eq!(
        restored.health().await?["authorityId"],
        meta.server["authorityId"]
    );
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn region_keeps_committing_when_global_root_is_missing() -> Result<()> {
    let f = Fixture::start().await?;
    let mut global = f.meta("global").await?;
    let mut region = f.meta("surviving-region").await?;
    global.process.stop()?;
    region.process.stop()?;
    let mut failed = global.server.clone();
    failed["s3"]["prefix"] = json!("missing-global-root");
    let global_path = config(f.directory(), "missing", &failed)?;
    let region_path = config(f.directory(), "surviving", &region.server)?;
    let mut host = launch(
        f.directory(),
        &json!([{"kind":"metadata","configFile":global_path},{"kind":"metadata","configFile":region_path}]),
    )?;
    let end = Instant::now() + Duration::from_secs(20);
    while region.health().await.is_err() {
        host.ensure_running()?;
        ensure!(Instant::now() < end, "region not ready");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let scope = json!({"authorityId":region.server["authorityId"],"ownerKind":"system","ownerId":"continuity","family":"probe","partitionId":"one"});
    region.call(json!({"op":"commit","scope":scope,"mutationId":Uuid::new_v4().to_string(),"changes":[{"key":"survives","value":true,"expectedVersion":null}]})).await?;
    assert_eq!(
        region
            .call(json!({"op":"get","scope":scope,"keys":["survives"]}))
            .await?["records"]["survives"]["value"],
        true
    );
    let bucket = global.server["s3"]["bucket"].as_str().unwrap();
    assert_eq!(
        f.s3(
            Method::GET,
            &format!("/{bucket}/missing-global-root/control/installation.json")
        )
        .await?
        .status(),
        404
    );
    host.stop()?;
    let restored = f.start_meta(region.server.clone(), false, None).await?;
    assert_eq!(
        restored.health().await?["authorityId"],
        region.server["authorityId"]
    );
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn fresh_workspaces_persist_resources_and_reject_retired_key_endpoints() -> Result<()> {
    let f = Fixture::start().await?;
    let meta = f.meta("fresh").await?;
    let mut workspace_servers = Vec::new();
    for workspace in ["ws_agentlab", "ws_another"] {
        let bind = format!("127.0.0.1:{}", port()?);
        let cfg = json!({"bind":bind,"workspaceId":workspace,"authorityId":meta.server["authorityId"],"initializeWorkspace":true,"insecureLoopback":true,"consoleOrigins":["http://127.0.0.1:5173"],"metadata":{"transport":"remote","client":meta.client},"product":{}});
        let path = config(f.directory(), workspace, &cfg)?;
        let roles = json!([{"kind":"workspace","configFile":path}]);
        let mut api = launch(f.directory(), &roles)?;
        let session = Session::connect(&mut api, &bind).await?;
        workspace_servers.push((bind, cfg, path, roles, api, session));
    }
    let (_, _, _, _, _second, other) = workspace_servers.pop().unwrap();
    let (bind, mut cfg, path, roles, mut api, session) = workspace_servers.pop().unwrap();
    let boot = session
        .owner(Method::GET, "ws_agentlab", "/bootstrap")
        .send()
        .await?;
    assert_eq!(boot.status(), 200);
    let boot = boot.json::<Value>().await?;
    for name in ["resources", "keys", "files", "events"] {
        assert_eq!(boot[name], json!([]));
    }
    let created = session
        .owner(Method::POST, "ws_agentlab", "/resources")
        .json(&json!({"kind":"filesystem","name":"fresh-files","region":"aws-ap-southeast-1"}))
        .send()
        .await?;
    assert_eq!(created.status(), 201);
    let id = created.json::<Value>().await?["data"]["id"].clone();
    assert_eq!(
        session
            .owner(Method::POST, "ws_agentlab", "/keys")
            .json(&json!({}))
            .send()
            .await?
            .status(),
        404
    );
    assert_eq!(
        other
            .key("ws_another", "", "original-key-before-rust-migration")
            .send()
            .await?
            .status(),
        401
    );
    api.stop()?;
    cfg["initializeWorkspace"] = json!(false);
    private_json(&path, &cfg)?;
    let mut restarted = launch(f.directory(), &roles)?;
    let again = Session::connect(&mut restarted, &bind).await?;
    assert_eq!(
        again
            .owner(Method::GET, "ws_agentlab", "/resources")
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?["data"][0]["id"],
        id
    );
    Ok(())
}

const TOKENS: [&str; 4] = [
    "original-key-before-rust-migration",
    "original-file-only-key",
    "original-expired-key",
    "original-revoked-key",
];
const WS: &str = "ws_agentlab";
fn scope(meta: &Meta) -> Value {
    json!({"authorityId":meta.server["authorityId"],"ownerKind":"workspace","ownerId":WS,"family":"workspace","partitionId":"primary"})
}
async fn seed_retired_credentials(meta: &Meta) -> Result<()> {
    use sha2::{Digest, Sha256};
    let record = |pos: usize, row: Value| json!({"position":pos,"record":row});
    let mut values = vec![
        (
            "state/workspace".into(),
            json!({"id":WS,"name":"Fixture workspace","description":"Isolated native integration test","plan":"Free","createdAt":"2026-01-01T00:00:00Z"}),
        ),
        (
            "state/profile".into(),
            json!({"name":"Fixture owner","email":"","role":"Local developer"}),
        ),
        (
            "state/resources/db_memory".into(),
            record(
                0,
                json!({"id":"db_memory","name":"fixture-postgresql","kind":"postgresql","provider":"db9-anonymous","region":"automatic","status":"active","createdAt":"2026-01-01T00:00:00Z"}),
            ),
        ),
        (
            "state/resources/fs_shared".into(),
            record(
                1,
                json!({"id":"fs_shared","name":"fixture-files","kind":"filesystem","region":"aws-ap-southeast-1","status":"active","createdAt":"2026-01-01T00:00:00Z"}),
            ),
        ),
        (
            "state/resources/retired-pg".into(),
            record(
                2,
                json!({"id":"retired-pg","kind":"postgresql","provider":"simulated","region":"automatic"}),
            ),
        ),
        ("state/queryCount".into(), json!(0)),
        (
            "state/opaque".into(),
            json!({"keep":["unknown",{"value":42}]}),
        ),
        (
            "credentials/accounts/db9".into(),
            json!({"refreshToken":"original-private-account"}),
        ),
        (
            "bindings/drive9/orphan".into(),
            json!({"credentialRef":"credentials/drive9/orphan"}),
        ),
        (
            "credentials/drive9/orphan".into(),
            json!({"apiKey":"provider-native-credential-preserved"}),
        ),
    ];
    for (i, (id, target, action)) in [
        ("visible-event", "db_memory", "query.executed"),
        ("retired-event", "retired-pg", "query.executed"),
        ("other-event", "fs_shared", "file.read"),
    ]
    .into_iter()
    .enumerate()
    {
        values.push((
            format!("state/events/{id}"),
            record(3 - i, json!({"id":id,"resourceId":target,"action":action})),
        ));
    }
    for (i, token) in TOKENS.iter().enumerate() {
        let digest = hex::encode(Sha256::digest(token.as_bytes()));
        let id = format!("preserved-key-{i}");
        values.push((format!("state/keys/{id}"),record(i,json!({"id":id,"name":"original key","prefix":"original","digest":digest,
            "scopes":[if i==1{"files:read"}else{"resources:read"}],"resourceIds":["db_memory"],
            "expiresAt":if i==2{"2000-01-01T00:00:00Z"}else{"2099-01-01T00:00:00Z"},"revokedAt":if i==3{Some("2026-01-01T00:00:00Z")}else{None}}))));
        values.push((format!("indexes/key-digest/{digest}"), json!(id)));
    }
    let changes: Vec<_> = values
        .into_iter()
        .map(|(key, value)| json!({"key":key,"value":value,"expectedVersion":null}))
        .collect();
    meta.call(json!({"op":"commit","scope":scope(meta),"changes":changes,"mutationId":Uuid::new_v4().to_string()})).await?;
    Ok(())
}
async fn check_owner_authorization(s: &Session) -> Result<()> {
    for token in TOKENS.into_iter().chain(["not-an-original-key"]) {
        assert_eq!(s.key(WS, "", token).send().await?.status(), 401);
    }
    assert_eq!(
        s.client
            .get(format!("{}/api/portal/v1/workspaces/{WS}", s.origin))
            .send()
            .await?
            .status(),
        401
    );
    assert_eq!(s.key(WS, "/keys", TOKENS[0]).send().await?.status(), 401);
    assert_eq!(s.key("other", "", TOKENS[0]).send().await?.status(), 404);
    for (header, value) in [
        ("Origin", "https://untrusted.example"),
        ("Host", "untrusted.example"),
    ] {
        assert_eq!(
            s.owner(Method::GET, WS, "")
                .header(header, value)
                .send()
                .await?
                .status(),
            403
        );
    }
    let preflight = |h: &str| {
        s.owner(Method::OPTIONS, WS, "")
            .header("Origin", "http://127.0.0.1:5173")
            .header("Access-Control-Request-Method", "GET")
            .header("Access-Control-Request-Headers", h)
    };
    let good = preflight("authorization").send().await?;
    assert_eq!(good.status(), 204);
    assert_eq!(
        good.headers()["access-control-allow-origin"],
        "http://127.0.0.1:5173"
    );
    assert_eq!(
        preflight("private-service-token")
            .send()
            .await?
            .json::<Value>()
            .await?["error"]["code"],
        "PREFLIGHT_DENIED"
    );
    assert_eq!(
        s.owner(Method::PATCH, WS, "/settings")
            .json(&json!([]))
            .send()
            .await?
            .json::<Value>()
            .await?["error"]["code"],
        "INVALID_BODY"
    );
    assert_eq!(
        s.owner(Method::PATCH, WS, "/settings")
            .header("Content-Type", "text/plain")
            .body("{}")
            .send()
            .await?
            .json::<Value>()
            .await?["error"]["code"],
        "JSON_REQUIRED"
    );
    assert_eq!(
        s.owner(Method::PATCH, WS, "/settings")
            .json(
                &json!({"workspaceName":"Rust migration","name":"Owner","description":"Preserved"})
            )
            .send()
            .await?
            .status(),
        200
    );
    assert_eq!(
        s.owner(Method::GET, WS, "")
            .send()
            .await?
            .json::<Value>()
            .await?["data"]["name"],
        "Rust migration"
    );
    assert_eq!(
        s.owner(Method::POST, WS, "/keys")
            .json(&json!({}))
            .send()
            .await?
            .status(),
        404
    );
    let events = s.owner(Method::GET, WS, "/events").send().await?;
    assert_eq!(events.status(), 200);
    assert!(
        !events.json::<Value>().await?["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["id"] == "retired-event")
    );
    Ok(())
}
async fn retained_records(embedded: bool) -> Result<()> {
    use workspace_contracts::Metadata;
    use workspace_meta_client::RemoteMetadata;
    let f = Fixture::start().await?;
    let mut global = f.meta("global").await?;
    let mut region = f.meta("rust-region").await?;
    seed_retired_credentials(&region).await?;
    global.process.stop()?;
    region.process.stop()?;
    let mut server = region.server.clone();
    let mut client = region.client.clone();
    if !embedded {
        let (server_tls, client_tls) = workspace_test_support::tls::certificates(f.directory())?;
        server["insecureLoopback"] = json!(false);
        server["tls"] = server_tls;
        server["s3"]["allowLoopbackHttp"] = json!(true);
        client["insecureLoopback"] = json!(false);
        client["origin"] = json!(format!("https://{}", server["bind"].as_str().unwrap()));
        client["tls"] = client_tls;
    }
    let server_path = config(f.directory(), "regional-host", &server)?;
    let metadata = json!({"kind":"metadata","configFile":server_path});
    let mut separate = None;
    if !embedded {
        let mut host = launch(f.directory(), &json!([metadata]))?;
        let end = Instant::now() + Duration::from_secs(20);
        while RemoteMetadata::connect(serde_json::from_value(client.clone())?)
            .await
            .is_err()
        {
            host.ensure_running()?;
            ensure!(Instant::now() < end, "separate TLS Meta did not start");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        separate = Some(host);
    }
    let bind = format!("127.0.0.1:{}", port()?);
    let transport = if embedded {
        json!({"transport":"inProcess","authorityId":server["authorityId"]})
    } else {
        json!({"transport":"remote","client":client})
    };
    let workspace = config(
        f.directory(),
        "workspace",
        &json!({"bind":bind,"workspaceId":WS,"authorityId":server["authorityId"],"insecureLoopback":true,"consoleOrigins":["http://127.0.0.1:5173"],"metadata":transport}),
    )?;
    let mut roles = Vec::new();
    if embedded {
        roles.push(metadata);
    }
    roles.push(json!({"kind":"workspace","configFile":workspace}));
    let roles = json!(roles);
    let mut host = launch(f.directory(), &roles)?;
    let session = Session::connect(&mut host, &bind).await?;
    check_owner_authorization(&session).await?;
    host.stop()?;
    let mut host = launch(f.directory(), &roles)?;
    let session = Session::connect(&mut host, &bind).await?;
    for path in ["", "/keys"] {
        assert_eq!(session.key(WS, path, TOKENS[0]).send().await?.status(), 401);
    }
    host.stop()?;
    let _reopened = if embedded {
        Some(f.start_meta(server, false, None).await?)
    } else {
        None
    };
    let verify = RemoteMetadata::connect(serde_json::from_value(client)?).await?;
    let scope = scope(&region);
    let records=verify.execute(serde_json::from_value(json!({"op":"get","scope":scope,"keys":["state/workspace","bindings/drive9/orphan","credentials/drive9/orphan"]}))?).await?;
    assert_eq!(
        records["records"]["state/workspace"]["value"]["name"],
        "Rust migration"
    );
    assert_eq!(
        records["records"]["bindings/drive9/orphan"]["value"],
        json!({"credentialRef":"credentials/drive9/orphan"})
    );
    assert_eq!(
        records["records"]["credentials/drive9/orphan"]["value"],
        json!({"apiKey":"provider-native-credential-preserved"})
    );
    let keys = verify
        .execute(serde_json::from_value(
            json!({"op":"list","scope":scope,"prefix":"state/keys/","limit":100}),
        )?)
        .await?;
    assert_eq!(keys["records"], json!([]));
    drop(separate);
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn owner_authorization_and_key_cleanup_survive_embedded_restart() -> Result<()> {
    retained_records(true).await
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn owner_authorization_and_key_cleanup_survive_remote_tls_restart() -> Result<()> {
    retained_records(false).await
}
