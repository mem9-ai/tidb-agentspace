#[path = "lifecycle/api.rs"]
mod api;
#[path = "lifecycle/transfers.rs"]
mod transfers;
use anyhow::{Result, ensure};
use api::Api;
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use uuid::Uuid;
use workspace_test_support::workspaces::{REGION, Workspaces};

async fn database_and_file_reads(api: &Api<'_>, token: &str) -> Result<()> {
    let boot = api.get("/bootstrap").await?;
    assert_eq!(boot["resources"].as_array().unwrap().len(), 5);
    assert_eq!(boot["mode"], "hybrid");
    let resources = api
        .agent(Method::GET, "/resources", token, None, 200)
        .await?;
    let mut ids: Vec<_> = resources["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].clone())
        .collect();
    assert_eq!(ids.len(), 5);
    ids.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    let mut page_ids = vec![];
    let mut cursor = None;
    loop {
        let mut req = api
            .f
            .owner(0, Method::GET, "/resources")
            .query(&[("limit", "2")]);
        if let Some(c) = &cursor {
            req = req.query(&[("cursor", c)]);
        }
        let page = api.json(Method::GET, req, 200).await?;
        let data = page["data"].as_array().unwrap();
        assert!(data.len() <= 2);
        page_ids.extend(data.iter().map(|v| v["id"].clone()));
        cursor = page["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(page_ids, ids);
    api.agent(
        Method::POST,
        "/queries",
        token,
        Some(&json!({"resourceId":"db_memory","sql":"SELECT 1 AS connected"})),
        200,
    )
    .await?;
    for id in ["db_live", "db_pg"] {
        let q = api
            .agent(
                Method::POST,
                "/queries",
                token,
                Some(&json!({"resourceId":id,"sql":"SELECT 1 AS checked"})),
                200,
            )
            .await?;
        assert_eq!(q["rows"], json!([{"checked":1}]));
        assert_eq!(q["mode"], "live");
        let tables = format!("/resources/{id}/tables");
        api.get(&tables).await?;
        let before = api.f.provider.state.lock().unwrap().statements.len();
        let metadata = api.get(&format!("{tables}/demo_table")).await?;
        assert!(api.f.provider.state.lock().unwrap().statements.len() > before);
        assert_eq!(metadata["columns"][0]["key"], "PRI");
        assert_eq!(metadata["indexes"][0]["columns"][0]["name"], "id");
        assert!(metadata.get("recordKind").is_none());
        api.get(&format!("{tables}/demo_table/rows")).await?;
    }
    let text = "name,n\nalice,1\nbob,2\n";
    api.owner(
        Method::PUT,
        "/files",
        Some(&json!({"resourceId":"fs_shared","path":"/orders.csv","type":"file","content":text})),
        200,
    )
    .await?;
    api.get("/files?resourceId=fs_shared").await?;
    let target = "resourceId=fs_shared&path=/orders.csv";
    let preview = api.get(&format!("/files/tabular-preview?{target}")).await?;
    assert_eq!(preview["rowCount"], 2);
    assert!(preview["totalRows"].is_null());
    assert_eq!(preview["columns"], json!(["name", "n"]));
    let cap = api
        .get(&format!("/file-analyses/capabilities?{target}"))
        .await?;
    assert_eq!(cap["available"], true);
    assert_eq!(
        cap["engines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["engine"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["duckdb", "bash"]
    );
    let result=api.post("/file-analyses",&json!({"resourceId":"fs_shared","path":"/orders.csv","engine":"duckdb","sql":"SELECT count(*) AS n FROM file"}),200).await?;
    assert_eq!(result["rows"], json!([{"n":"2"}]));
    for (command, status) in [
        ("cat \"$FILE\"", 200),
        ("grep alice \"$FILE\" | wc -l", 200),
        ("printf changed > \"$FILE\"", 422),
        ("cat /etc/passwd", 200),
    ] {
        let r=api.post("/file-analyses",&json!({"resourceId":"fs_shared","path":"/orders.csv","engine":"bash","command":command}),status).await?;
        match command {
            "cat \"$FILE\"" => assert_eq!(r["stdout"], text),
            "cat /etc/passwd" => assert_ne!(r["exitCode"], 0),
            _ if command.contains("wc -l") => assert_eq!(r["stdout"].as_str().unwrap().trim(), "1"),
            _ => (),
        }
    }
    api.get("/files?resourceId=fs_live").await?;
    let binary = |file: &str| format!("/files/content?resourceId=fs_live&path=/{file}");
    let png=STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/+ioAAAAASUVORK5CYII=")?;
    for (name, data) in [
        ("upload.txt", b"uploaded text\n".to_vec()),
        ("preview.png", png.clone()),
        ("invalid.jpg", b"not a jpeg".to_vec()),
    ] {
        let path = binary(name);
        api.json(
            Method::PUT,
            api.f
                .owner(0, Method::PUT, &path)
                .header("Content-Type", "application/octet-stream")
                .body(data.clone()),
            200,
        )
        .await?;
        let preview = api.get(&format!("{path}&preview=1")).await?;
        match name {
            "upload.txt" => assert_eq!(preview["content"], "uploaded text\n"),
            "preview.png" => {
                assert_eq!(preview["size"], png.len());
                assert_eq!(preview["image"]["mimeType"], "image/png");
                assert_eq!(
                    STANDARD.decode(preview["image"]["base64"].as_str().unwrap())?,
                    png
                );
            }
            _ => assert!(
                preview["unavailableReason"]
                    .as_str()
                    .unwrap()
                    .contains("invalid")
            ),
        }
    }
    assert_eq!(
        api.f
            .owner(0, Method::GET, &binary("binary.bin"))
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?,
        &[0, 255, 13, 10][..]
    );
    Ok(())
}

async fn preserved(f: &Workspaces) -> Result<BTreeMap<String, Value>> {
    let mut records = BTreeMap::new();
    for prefix in [
        "bindings/",
        "credentials/",
        "state/resources/",
        "state/opaque",
    ] {
        let page = f
            .guarded("list", json!({"prefix":prefix,"limit":100}))
            .await?;
        for row in page["records"].as_array().unwrap() {
            records.insert(
                row["key"].as_str().unwrap().to_owned(),
                row["value"].clone(),
            );
        }
    }
    Ok(records)
}

async fn hybrid(embedded: bool) -> Result<()> {
    let f = Workspaces::start(embedded, false).await?;
    f.guarded("commit",json!({"mutationId":Uuid::new_v4().to_string(),"changes":[{"key":"state/opaque","expectedVersion":null,"value":{"preserve":"original data"}}]})).await?;
    // The hybrid scenario begins with an empty local File System. The shared fixture
    // supplies an identity marker for the separate two-Workspace isolation scenario.
    f.owner(
        0,
        Method::DELETE,
        "/files/entry?resourceId=fs_shared&path=/identity.txt",
    )
    .send()
    .await?
    .error_for_status()?;
    let mut before = preserved(&f).await?;
    let api = Api::new(&f)?;
    let scoped = api
        .token(
            "full-contract",
            &[
                "resources:read",
                "resources:write",
                "files:read",
                "files:write",
                "files:analyze",
                "queries:execute",
                "usage:read",
            ],
            &["*"],
        )
        .await?;
    database_and_file_reads(&api, &scoped).await?;
    transfers::verify(&api, &scoped).await?;
    assert_eq!(f.provider.state.lock().unwrap().creates, 0);
    let file_system = api.get("/resources/fs_live").await?;
    assert_eq!(file_system["data"]["uploadLimitBytes"], 1048576);
    let db = api.get("/resources/db_live").await?;
    assert_eq!(db["data"]["provider"], "db9-anonymous");
    let schema = f
        .at(0, Method::GET, "/openapi.json", false)
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    assert_eq!(
        schema,
        serde_json::from_str::<Value>(include_str!("../../../public/openapi.json"))?
    );
    for (k, v) in &mut before {
        if let Some(id) = k.strip_prefix("state/resources/")
            && matches!(
                v["record"]["kind"].as_str(),
                Some("postgresql" | "filesystem")
            )
        {
            v["record"]["regionId"] = json!(REGION);
            if id == "fs_live" {
                v["record"]["uploadLimitBytes"] = json!(1048576);
            }
        }
    }
    let after = preserved(&f).await?;
    assert_eq!(
        before.keys().collect::<Vec<_>>(),
        after.keys().collect::<Vec<_>>()
    );
    for (key, original) in before {
        if key.starts_with("state/") {
            assert_eq!(after[&key], original, "{key}");
        } else {
            assert!(after[&key] == original, "Stored binding changed: {key}");
        }
    }
    assert_eq!(
        f.guarded("list", json!({"prefix":"state/keys/","limit":100}))
            .await?["records"],
        json!([])
    );
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn remote_metadata_hybrid_workflows() -> Result<()> {
    hybrid(false).await
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn embedded_metadata_hybrid_workflows() -> Result<()> {
    hybrid(true).await
}

async fn create(f: &Workspaces, kind: &str, name: &str, id: &str) -> Result<(u16, Value)> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let r=f.owner(0,Method::POST,"/resources").header("Idempotency-Key",id)
            .json(&json!({"kind":kind,"name":name,"region":if kind=="filesystem"{"aws-ap-southeast-1"}else{"automatic"}})).send().await?;
        let status = r.status().as_u16();
        let body = r.json::<Value>().await?;
        if status != 503 || body["error"]["code"] != "RESOURCE_INDEX_MIGRATING" {
            return Ok((status, body));
        }
        ensure!(
            Instant::now() < deadline,
            "Resource index migration did not complete"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn provider_creation_intents_survive_uncertain_outcomes_and_restart() -> Result<()> {
    let mut f = Workspaces::start(false, true).await?;
    let account = "credentials/accounts/db9";
    let retained = f.records(0, &[account]).await?;
    if !retained[account].is_null() {
        f.guarded("commit",json!({"mutationId":Uuid::new_v4().to_string(),"changes":[{"key":account,"delete":true,"expectedVersion":retained[account]["version"]}]})).await?;
    }
    let (status, pg) = create(&f, "postgresql", "tidb_pg-example", "pg").await?;
    assert_eq!(status, 201);
    assert_eq!(pg["data"]["name"], "tidb_pg-example");
    assert_eq!(pg["data"]["status"], "active");
    let (status, r) = create(&f, "postgresql", "_tidb-pg", "invalid-pg").await?;
    assert_eq!(status, 400);
    assert_eq!(r["error"]["code"], "INVALID_NAME");
    let (status, r) = create(&f, "mysql", "tidb_pg-example", "invalid-mysql").await?;
    assert_eq!(status, 400);
    assert_eq!(r["error"]["code"], "INVALID_KIND");
    assert_eq!(
        create(&f, "postgresql", "tidb_pg-example", "pg").await?.1["data"]["id"],
        pg["data"]["id"]
    );
    assert_eq!(create(&f, "postgresql", "changed-name", "pg").await?.0, 409);
    f.provider.state.lock().unwrap().lost = true;
    let (s, unknown_pg) = create(&f, "postgresql", "unknown-postgres", "lost-pg").await?;
    assert_eq!(s, 201);
    assert_ne!(unknown_pg["data"]["status"], "active");
    let (s, unknown_fs) = create(&f, "filesystem", "unknown-files", "lost-fs").await?;
    assert_eq!(s, 201);
    assert_ne!(unknown_fs["data"]["status"], "active");
    f.provider.state.lock().unwrap().lost = false;
    f.restart(false).await?;
    let api = Api::new(&f)?;
    let restored = api
        .json(
            Method::POST,
            f.owner(
                0,
                Method::POST,
                &format!(
                    "/resources/{}/setup-attempts",
                    unknown_pg["data"]["id"].as_str().unwrap()
                ),
            )
            .header("Idempotency-Key", "restore-pg"),
            201,
        )
        .await?;
    assert_eq!(restored["data"]["status"], "succeeded");
    assert_eq!(restored["data"]["resource"]["status"], "active");
    assert_eq!(
        create(&f, "filesystem", "unknown-files", "lost-fs")
            .await?
            .0,
        201
    );
    let retired = api
        .post(
            "/resources",
            &json!({"kind":"duckdb","name":"unavailable-duckdb","region":"aws-ap-southeast-1"}),
            400,
        )
        .await?;
    assert_eq!(retired["error"]["code"], "INVALID_KIND");
    let list = api.get("/resources").await?;
    assert_eq!(list["data"].as_array().unwrap().len(), 3);
    let state = f.provider.state.lock().unwrap();
    assert_eq!(state.creates, 1);
    assert_eq!(state.database_creates, 2);
    assert_eq!(state.account_creates, 1);
    Ok(())
}
