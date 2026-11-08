//! Native product HTTP cases against separate and embedded metadata authorities.
#[path = "product_api/files.rs"]
mod files;
#[path = "product_api/import.rs"]
mod import;
#[path = "product_api/pending_policy.rs"]
mod pending_policy;

use anyhow::{Result, ensure};
use reqwest::{Method, RequestBuilder};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use uuid::Uuid;
use workspace_test_support::{
    provider::{NATIVE_SECRET, SqlResponse},
    workspaces::Workspaces,
};

const RESOURCES: &[&str] = &["fs_shared", "fs_live", "db_live", "db_pg"];
const SCOPES: &[&str] = &[
    "resources:read",
    "resources:write",
    "files:read",
    "files:write",
    "files:analyze",
    "queries:execute",
    "usage:read",
];
const SOURCE: &str = "id,value\n001,9007199254740993\n";

async fn check(req: RequestBuilder, code: u16, error: &str) -> Result<Value> {
    let r = req.send().await?;
    let status = r.status().as_u16();
    let bytes = r.bytes().await?;
    assert!(!String::from_utf8_lossy(&bytes).contains(NATIVE_SECRET));
    let v: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)?
    };
    ensure!(
        status == code,
        "Expected HTTP {code}, got {status} ({})",
        v["error"]["code"]
    );
    if !error.is_empty() {
        assert_eq!(v["error"]["code"], error);
        assert!(v["error"]["message"].is_string() && v["error"]["requestId"].is_string());
    }
    Ok(v)
}
async fn key(
    f: &Workspaces,
    i: usize,
    name: &str,
    scopes: &[&str],
    ids: &[&str],
) -> Result<(Value, String)> {
    let key = f.create_key(i, name, scopes, ids).await?;
    let token = f.exchange(i, key["secret"].as_str().unwrap()).await?;
    Ok((key, token))
}
fn agent(f: &Workspaces, method: Method, route: &str, token: &str) -> RequestBuilder {
    f.agent(0, method, route, Some(token))
}
fn calls(f: &Workspaces) -> usize {
    f.provider.state.lock().unwrap().calls
}
fn statements(f: &Workspaces) -> Vec<String> {
    f.provider.state.lock().unwrap().statements.clone()
}
fn creates(f: &Workspaces) -> (usize, usize, usize) {
    let s = f.provider.state.lock().unwrap();
    (s.creates, s.database_creates, s.account_creates)
}
async fn authorization(f: &Workspaces, token: &str) -> Result<()> {
    let (_, actions) = key(f, 0, "coverage-no-actions", &["resources:read"], RESOURCES).await?;
    let (_, resources) = key(f, 0, "coverage-other-resource", SCOPES, &["fs_shared"]).await?;
    let parse = json!({"format":"csv","header":true,"delimiter":","});
    let routes = [
        (
            Method::POST,
            "/queries",
            json!({"resourceId":"db_live","sql":"INSERT INTO forbidden VALUES (1)"}),
        ),
        (Method::GET, "/resources/db_live/tables", Value::Null),
        (
            Method::GET,
            "/resources/db_live/tables/demo_table",
            Value::Null,
        ),
        (
            Method::GET,
            "/resources/db_live/tables/demo_table/rows",
            Value::Null,
        ),
        (Method::GET, "/files?resourceId=fs_live", Value::Null),
        (
            Method::PUT,
            "/files",
            json!({"resourceId":"fs_live","path":"/forbidden.txt","type":"file","content":"forbidden"}),
        ),
        (
            Method::DELETE,
            "/files/entry?resourceId=fs_live&path=/live.csv",
            Value::Null,
        ),
        (
            Method::GET,
            "/files/content?resourceId=fs_live&path=/binary.bin",
            Value::Null,
        ),
        (
            Method::PUT,
            "/files/content?resourceId=fs_live&path=/forbidden.bin",
            json!("forbidden"),
        ),
        (
            Method::GET,
            "/files/tabular-preview?resourceId=fs_live&path=/live.csv",
            Value::Null,
        ),
        (
            Method::GET,
            "/file-analyses/capabilities?resourceId=fs_live&path=/live.csv",
            Value::Null,
        ),
        (
            Method::POST,
            "/file-analyses",
            json!({"resourceId":"fs_live","path":"/live.csv","engine":"duckdb","sql":"SELECT * FROM file"}),
        ),
        (
            Method::POST,
            "/database-import-preparations",
            json!({"resourceId":"db_live","source":{"resourceId":"fs_live","path":"/live.csv"},"parsing":parse}),
        ),
        (
            Method::POST,
            "/database-import-preparations?resourceId=db_live&filename=x.csv&format=csv&header=true&delimiter=%2C",
            json!("n\n1\n"),
        ),
        (
            Method::POST,
            "/result-exports",
            json!({"sourceResourceId":"db_live","result":{"columns":["n"],"rows":[{"n":1}]},"target":{"kind":"filesystem","resourceId":"fs_live","path":"/forbidden.csv","format":"csv"}}),
        ),
        (
            Method::POST,
            "/file-exports",
            json!({"source":{"kind":"original","resourceId":"fs_live","path":"/live.csv"},"target":{"kind":"filesystem","resourceId":"fs_shared","path":"/forbidden.csv"}}),
        ),
        (
            Method::POST,
            "/file-export-preparations",
            json!({"source":{"kind":"original","resourceId":"fs_live","path":"/live.csv"},"parsing":parse}),
        ),
    ];
    let before = calls(f);
    for (method, path, body) in routes {
        for (credential, status, code) in [
            (Some(actions.as_str()), 403, "INSUFFICIENT_SCOPE"),
            (Some(resources.as_str()), 403, "RESOURCE_ACCESS_DENIED"),
            (None, 401, "AGENT_TOKEN_REQUIRED"),
            (Some("invalid-coverage-key"), 401, "INVALID_CREDENTIAL"),
        ] {
            let mut req = f.agent(0, method.clone(), path, credential);
            if let Some(raw) = body.as_str() {
                req = req
                    .header("Content-Type", "application/octet-stream")
                    .body(raw.to_owned());
            } else if !body.is_null() {
                req = req.json(&body);
            }
            check(req, status, code).await?;
        }
    }
    check(
        agent(f, Method::POST, "/resources", &resources).json(
            &json!({"kind":"filesystem","name":"forbidden-resource","region":"aws-ap-southeast-1"}),
        ),
        403,
        "WORKSPACE_GRANT_REQUIRED",
    )
    .await?;
    assert_eq!(calls(f), before);
    assert!(statements(f).is_empty());
    let listed = check(
        f.owner(0, Method::GET, "/files?resourceId=fs_shared"),
        200,
        "",
    )
    .await?;
    let paths: Vec<_> = listed["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["/identity.txt"]);
    let (_, chosen) = key(
        f,
        0,
        "coverage-selected",
        &["resources:read", "files:read", "usage:read"],
        &["fs_shared"],
    )
    .await?;
    for (path, field) in [("/resources", "id"), ("/usage", "resourceId")] {
        let r = check(agent(f, Method::GET, path, &chosen), 200, "").await?;
        assert_eq!(r["data"].as_array().unwrap().len(), 1);
        assert_eq!(r["data"][0][field], "fs_shared");
    }
    assert_eq!(
        check(
            agent(f, Method::GET, "/files?resourceId=fs_shared", &chosen),
            200,
            ""
        )
        .await?["data"][0]["content"],
        "ws_agentlab"
    );
    assert_eq!(
        check(
            f.owner(1, Method::GET, "/files?resourceId=fs_shared"),
            200,
            ""
        )
        .await?["data"][0]["content"],
        "ws_other"
    );
    let before = calls(f);
    check(
        f.agent(1, Method::GET, "/files?resourceId=fs_live", Some(token)),
        401,
        "INVALID_CREDENTIAL",
    )
    .await?;
    check(
        f.at(
            0,
            Method::GET,
            "/api/v1/workspaces/ws_other/files?resourceId=fs_live",
            false,
        )
        .bearer_auth(token),
        404,
        "NOT_FOUND",
    )
    .await?;
    check(agent(f, Method::GET, "/keys", token), 404, "NOT_FOUND").await?;
    assert_eq!(calls(f), before);
    let listed = check(f.global(0, Method::GET, "/keys", None), 200, "")
        .await?
        .to_string();
    assert!(!listed.contains(token) && !listed.contains("digest"));
    let (_, wild) = key(f, 0, "coverage-wildcard", SCOPES, &["*"]).await?;
    let before = calls(f);
    check(
        agent(f, Method::GET, "/files?resourceId=hidden-storage", &wild),
        404,
        "NOT_FOUND",
    )
    .await?;
    let private = f
        .create_key(0, "private-store", &["files:read"], &["hidden-storage"])
        .await?;
    check(
        f.global(
            0,
            Method::POST,
            "/token-issuances",
            private["secret"].as_str(),
        )
        .json(&json!({"audience":workspace_test_support::workspaces::REGION})),
        503,
        "POLICY_DELIVERY_UNKNOWN",
    )
    .await?;
    assert_eq!(calls(f), before);
    Ok(())
}

fn row() -> Value {
    json!({"id":"9007199254740993","decimal":"12345678901234567890.012300","nullable":null,"enabled":true,"binary":"AP8NCg=="})
}
fn install_sql(f: &Workspaces, state: &Arc<Mutex<Option<Value>>>) {
    let state = state.clone();
    f.provider.set_sql_hook(move|input| {
        let state=state.clone();async move{
            assert_eq!(input["binding"]["password"],NATIVE_SECRET);
            let mut stored=state.lock().unwrap();
            let result=match input["sql"].as_str()?{
                "INSERT INTO coverage_roundtrip VALUES (1)"=>{*stored=Some(row());json!({"columns":[],"rows":[],"rowCount":0,"affectedRows":1})}
                "UPDATE coverage_roundtrip SET enabled = false"=>{stored.as_mut().unwrap()["enabled"]=json!(false);json!({"columns":[],"rows":[],"rowCount":0,"affectedRows":1})}
                "DELETE FROM coverage_roundtrip"=>{*stored=None;json!({"columns":[],"rows":[],"rowCount":0,"affectedRows":1})}
                "SELECT * FROM coverage_roundtrip"=>json!({"columns":["id","decimal","nullable","enabled","binary"],"rows":stored.iter().collect::<Vec<_>>(),"rowCount":usize::from(stored.is_some()),"affectedRows":0}),
                "INSERT INTO coverage_unknown VALUES (1)"=>return Some(SqlResponse::Disconnect),
                _=>return None,
            };Some(SqlResponse::Json(200,result))
        }
    });
}
async fn query(f: &Workspaces, id: &str, sql: &str, token: &str) -> Result<Value> {
    check(
        agent(f, Method::POST, "/queries", token).json(&json!({"resourceId":id,"sql":sql})),
        200,
        "",
    )
    .await
}
async fn sql_roundtrip(f: &Workspaces, token: &str) -> Result<()> {
    for id in ["db_live", "db_pg"] {
        let before = statements(f).len();
        let write = query(f, id, "INSERT INTO coverage_roundtrip VALUES (1)", token).await?;
        assert_eq!(write["columns"], json!([]));
        assert_eq!(write["rows"], json!([]));
        assert_eq!(write["mode"], "live");
        assert_eq!(write["affectedRows"], 1);
        assert_eq!(
            query(f, id, "SELECT * FROM coverage_roundtrip", token).await?["rows"],
            json!([row()])
        );
        query(
            f,
            id,
            "UPDATE coverage_roundtrip SET enabled = false",
            token,
        )
        .await?;
        let mut updated = row();
        updated["enabled"] = json!(false);
        assert_eq!(
            query(f, id, "SELECT * FROM coverage_roundtrip", token).await?["rows"],
            json!([updated])
        );
        query(f, id, "DELETE FROM coverage_roundtrip", token).await?;
        let empty = query(f, id, "SELECT * FROM coverage_roundtrip", token).await?;
        assert_eq!(empty["rows"], json!([]));
        assert_eq!(empty["rowCount"], 0);
        assert_eq!(statements(f).len(), before + 6);
        check(
            agent(f, Method::POST, "/queries", token)
                .json(&json!({"resourceId":id,"sql":"INSERT INTO coverage_unknown VALUES (1)"})),
            502,
            "SQL_EXECUTION_FAILED",
        )
        .await?;
        assert_eq!(statements(f).len(), before + 7);
    }
    Ok(())
}

// A live HTTP request can only finish while this test's single-thread Tokio runtime
// continues serving the SQL provider. Start the shutdown before releasing that response.
async fn restart_during_query(f: &mut Workspaces, db: &Arc<Mutex<Option<Value>>>) -> Result<()> {
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    f.provider.set_sql_hook({
        let entered = entered.clone();
        let release = release.clone();
        move |input| {
            let entered = entered.clone();
            let release = release.clone();
            async move {
                assert_eq!(input["sql"], "SELECT 42");
                entered.notify_one();
                release.notified().await;
                Some(SqlResponse::Json(200, json!({"columns":["value"],"rows":[{"value":42}],"rowCount":1,"affectedRows":0})))
            }
        }
    });
    // Hosts stop in reverse dependency order, starting with ws_other.
    let request = f
        .owner(1, Method::POST, "/queries")
        .json(&json!({"sql":"SELECT 42", "resourceId":"db_live"}));
    let query = tokio::spawn(check(request, 200, ""));
    tokio::time::timeout(std::time::Duration::from_secs(10), entered.notified()).await?;
    let (restarted, ()) = tokio::join!(biased;
        f.restart(false),
        async { release.notify_one(); }
    );
    restarted?;
    assert_eq!(query.await??["rows"], json!([{"value":42}]));
    install_sql(f, db);
    Ok(())
}

async fn persistence(
    f: &mut Workspaces,
    token: &str,
    db: &Arc<Mutex<Option<Value>>>,
) -> Result<()> {
    let file = json!({"resourceId":"fs_shared","path":"/durable.txt","type":"file","content":"durable 😀\r\n"});
    check(agent(f, Method::PUT, "/files", token).json(&file), 200, "").await?;
    let data = vec![0, 255, 1, 13, 10];
    let path = "/files/content?resourceId=fs_live&path=/durable.bin";
    check(
        agent(f, Method::PUT, path, token)
            .header("Content-Type", "application/octet-stream")
            .body(data.clone()),
        200,
        "",
    )
    .await?;
    query(
        f,
        "db_live",
        "INSERT INTO coverage_roundtrip VALUES (1)",
        token,
    )
    .await?;
    let (revoked, stale) = key(f, 0, "coverage-revoked-before-restart", SCOPES, RESOURCES).await?;
    f.revoke(0, &revoked["data"]).await?;
    check(
        agent(f, Method::GET, "/files?resourceId=fs_live", &stale),
        401,
        "INVALID_CREDENTIAL",
    )
    .await?;
    let review = import::upload(f, "db_live", token, SOURCE, 201, "").await?;
    let initial = creates(f);
    restart_during_query(f, db).await?;
    let listed = check(
        agent(f, Method::GET, "/files?resourceId=fs_shared", token),
        200,
        "",
    )
    .await?;
    assert!(
        listed["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["path"] == file["path"] && v["content"] == file["content"])
    );
    assert_eq!(
        agent(f, Method::GET, path, token)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?,
        data
    );
    assert_eq!(
        query(f, "db_live", "SELECT * FROM coverage_roundtrip", token).await?["rows"],
        json!([row()])
    );
    let before = calls(f);
    for denied in [&*stale, "expired-coverage-key"] {
        check(
            agent(f, Method::GET, "/files?resourceId=fs_live", denied),
            401,
            "INVALID_CREDENTIAL",
        )
        .await?;
    }
    check(
        f.agent(1, Method::GET, "/files?resourceId=fs_live", Some(token)),
        401,
        "INVALID_CREDENTIAL",
    )
    .await?;
    check(
        agent(f, Method::POST, "/database-imports", token).json(&import::commit(
            &review,
            "lost_review",
            "db_live",
        )),
        409,
        "IMPORT_PREPARATION_UNAVAILABLE",
    )
    .await?;
    assert_eq!(calls(f), before);
    let fresh = import::upload(f, "db_live", token, SOURCE, 201, "").await?;
    check(
        agent(f, Method::POST, "/database-imports", token).json(&import::commit(
            &fresh,
            "new_review",
            "db_live",
        )),
        200,
        "",
    )
    .await?;
    assert_eq!(creates(f), initial);
    let (_, other) = key(
        f,
        1,
        "coverage-other-crash-key",
        &["files:read"],
        &["fs_shared"],
    )
    .await?;
    let crash = json!({"resourceId":"fs_shared","path":"/crash-ack.txt","type":"file","content":"acknowledged before SIGKILL 😀"});
    check(agent(f, Method::PUT, "/files", token).json(&crash), 200, "").await?;
    f.restart(true).await?;
    let listed = check(
        agent(f, Method::GET, "/files?resourceId=fs_shared", token),
        200,
        "",
    )
    .await?;
    assert!(
        listed["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["path"] == crash["path"] && v["content"] == crash["content"])
    );
    assert_eq!(
        check(
            f.agent(1, Method::GET, "/files?resourceId=fs_shared", Some(&other)),
            200,
            ""
        )
        .await?["data"][0]["content"],
        "ws_other"
    );
    assert_eq!(
        query(f, "db_live", "SELECT * FROM coverage_roundtrip", token).await?["rows"],
        json!([row()])
    );
    assert_eq!(creates(f), initial);
    Ok(())
}

async fn verify(embedded: bool) -> Result<()> {
    let mut f = Workspaces::start(embedded, false).await?;
    let (_, token) = key(&f, 0, "coverage-all", SCOPES, RESOURCES).await?;
    let db = Arc::new(Mutex::new(None));
    install_sql(&f, &db);
    authorization(&f, &token).await?;
    files::verify(&f, &token).await?;
    sql_roundtrip(&f, &token).await?;
    files::exports(&f, &token).await?;
    import::verify(&f, &token).await?;
    install_sql(&f, &db);
    persistence(&mut f, &token, &db).await
}
#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn remote_product_http() -> Result<()> {
    verify(false).await
}
#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn embedded_product_http() -> Result<()> {
    verify(true).await
}
