use super::*;
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};

const PREP: &str = "/database-import-preparations?resourceId=db_live&filename=input.csv&format=csv&header=true&delimiter=%2C";
fn upload(f: &Workspaces, t: &str) -> RequestBuilder {
    post(f, PREP, t)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body("id,label\n001,alice\n")
}
fn confirm(f: &Workspaces, t: &str, review: &Value, table: &str) -> RequestBuilder {
    post(f,"/database-imports",t).json(&json!({"resourceId":"db_live","preparationId":review["id"],"confirmed":true,"table":table,"fields":review["fields"]}))
}
fn statements(f: &Workspaces) -> usize {
    f.provider.state.lock().unwrap().statements.len()
}
async fn imports_exports(f: &Workspaces, full: &Key, reader: &Key) -> Result<()> {
    let t = full.token.as_str();
    let uploaded = check(upload(f, t), 201, "").await?;
    let review = &uploaded.data;
    assert_eq!(review["status"], "ready");
    assert_eq!(review["rows"][0]["id"], "001");
    assert!(
        chrono::DateTime::parse_from_rfc3339(text(review, "expiresAt"))?
            > chrono::DateTime::parse_from_rfc3339(text(review, "createdAt"))?
    );
    let location = follow(&uploaded)?;
    let id = text(review, "id");
    assert_eq!(
        location,
        format!("/api/v1/workspaces/ws_agentlab/database-import-preparations/{id}")
    );
    let proxy = Url::parse(
        "https://regional.example/proxy/api/v1/workspaces/ws_agentlab/database-import-preparations",
    )?;
    assert_eq!(
        proxy
            .join(uploaded.headers[header::LOCATION].to_str()?)?
            .path(),
        format!("/proxy{location}")
    );
    let route = relative(&location);
    let before = calls(f);
    assert_eq!(check(get(f, route, t), 200, "").await?.data, *review);
    assert_eq!(calls(f), before);
    check(get(f, route, &reader.token), 404, "PREPARATION_NOT_FOUND").await?;
    let other = key(f, 1, &["resources:read"], &["*"]).await?;
    check(f.agent(1, Method::GET, route, Some(&other.token)), 404, "").await?;
    check(
        get(
            f,
            &route.replace("database-import-preparations", "file-export-preparations"),
            t,
        ),
        404,
        "PREPARATION_NOT_FOUND",
    )
    .await?;
    let parsing = json!({"format":"csv","header":true,"delimiter":","});
    let input = json!({"resourceId":"db_live","source":{"resourceId":"fs_live","path":"/live.csv"},"parsing":parsing});
    let saved = check(
        post(f, "/database-import-preparations", t).json(&input),
        201,
        "",
    )
    .await?;
    assert_ne!(saved.data["id"], review["id"]);
    let saved_url = follow(&saved)?;
    let saved_path = relative(&saved_url);
    let before = calls(f);
    check(get(f, saved_path, t), 200, "").await?;
    assert_eq!(calls(f), before);
    check(
        post(f, "/database-import-preparations?resourceId=db_live", t).json(&input),
        400,
        "INVALID_IMPORT",
    )
    .await?;
    check(delete(f, route, t), 204, "").await?;
    check(get(f, route, t), 404, "PREPARATION_NOT_FOUND").await?;
    check(
        confirm(f, t, review, "reviewed_import"),
        409,
        "IMPORT_PREPARATION_UNAVAILABLE",
    )
    .await?;
    check(confirm(f, t, &saved.data, "reviewed_import"), 200, "").await?;
    assert_eq!(
        check(get(f, saved_path, t), 200, "").await?.data["status"],
        "consumed"
    );
    let before = statements(f);
    check(delete(f, saved_path, t), 409, "IMPORT_ALREADY_COMMITTED").await?;
    check(
        confirm(f, t, &saved.data, "reviewed_import"),
        409,
        "IMPORT_ALREADY_COMMITTED",
    )
    .await?;
    assert_eq!(statements(f), before);
    let race = check(upload(f, t), 201, "").await?;
    let url = follow(&race)?;
    let before = statements(f);
    let (cancel, commit) = tokio::try_join!(
        send(delete(f, relative(&url), t)),
        send(confirm(f, t, &race.data, "cancel_race"))
    )?;
    if cancel.status == 204 {
        assert_eq!(commit.status, 409);
        assert_eq!(statements(f), before);
    } else {
        assert_eq!((cancel.status, commit.status), (409, 200));
        assert_eq!(statements(f), before + 2);
    }
    let export = |text: &str, parsing: &Value| {
        post(f,"/file-export-preparations",t).json(&json!({"source":{"kind":"output","resourceId":"fs_live","stream":"stdout","text":text},"parsing":parsing}))
    };
    let exported = check(
        export("line one\nline two\n", &json!({"format":"lines"})),
        201,
        "",
    )
    .await?;
    let url = follow(&exported)?;
    let p = relative(&url);
    let before = calls(f);
    assert_eq!(check(get(f, p, t), 200, "").await?.data, exported.data);
    assert_eq!(calls(f), before);
    check(get(f, p, &reader.token), 404, "PREPARATION_NOT_FOUND").await?;
    check(delete(f, p, t), 204, "").await?;
    check(get(f, p, t), 404, "PREPARATION_NOT_FOUND").await?;
    let quoted = check(
        export(&format!("c\n\"{}\"\n", "\"\"".repeat(270000)), &parsing),
        201,
        "",
    )
    .await?;
    assert_eq!(quoted.data["rowCount"], 1);
    assert_eq!(text(&quoted.data["rows"][0], "c").len(), 270000);
    check(delete(f, relative(&follow(&quoted)?), t), 204, "").await?;
    let restricted = key(f, 0, &["queries:execute"], &["db_live"]).await?;
    let revocable = check(upload(f, &restricted.token), 201, "").await?;
    f.revoke(0, &restricted.meta).await?;
    check(
        get(f, relative(&follow(&revocable)?), &restricted.token),
        401,
        "INVALID_CREDENTIAL",
    )
    .await?;
    Ok(())
}
async fn setup_history(f: &mut Workspaces, full: &Key, read: &Key) -> Result<()> {
    let t = full.token.as_str();
    let before = calls(f);
    let route = "/resources/db_live/setup-attempts";
    check(post(f, route, t), 400, "INVALID_IDEMPOTENCY_KEY").await?;
    check(
        setup(f, "db_live", "body", t).json(&json!({})),
        400,
        "INVALID_BODY",
    )
    .await?;
    let missing = ["bindings/db9/db_missing", "credentials/db9/db_missing"];
    let saved = f.records(0, &missing).await?;
    let failed = check(setup(f, "db_missing", "missing", t), 201, "")
        .await?
        .data;
    assert_eq!(failed["data"]["status"], "failed");
    assert_eq!(failed["data"]["errorCode"], "SETUP_NOT_RESUMABLE");
    assert_eq!(f.records(0, &missing).await?, saved);
    let (first, again) = tokio::try_join!(
        check(setup(f, "db_live", "same", t), 201, ""),
        check(setup(f, "db_live", "same", t), 201, "")
    )?;
    assert_eq!(first.data, again.data);
    assert_eq!(first.data["data"]["status"], "succeeded");
    let url = follow(&first)?;
    let path = relative(&url);
    let id = text(&first.data["data"], "id");
    assert_eq!(path, format!("{route}/{id}"));
    assert_eq!(
        check(get(f, path, &read.token), 200, "").await?.data,
        first.data
    );
    assert_ne!(
        check(setup(f, "db_live", "second", t), 201, "").await?.data["data"]["id"],
        id
    );
    let foreign = key(f, 0, &["resources:write"], &["db_live"]).await?;
    assert_ne!(
        check(setup(f, "db_live", "same", &foreign.token), 201, "")
            .await?
            .data["data"]["id"],
        id
    );
    assert_ne!(
        check(setup(f, "db_pg", "same", t), 201, "").await?.data["data"]["id"],
        id
    );
    assert_eq!(calls(f), before);
    let first_page = check(get(f, route, &read.token).query(&[("limit", "1")]), 200, "")
        .await?
        .data;
    assert_eq!(first_page["data"].as_array().unwrap().len(), 1);
    let next = check(
        get(f, route, &read.token).query(&[
            ("limit", "100"),
            ("cursor", text(&first_page, "nextCursor")),
        ]),
        200,
        "",
    )
    .await?
    .data;
    assert!(next["nextCursor"].is_null());
    assert_eq!(
        first_page["data"]
            .as_array()
            .unwrap()
            .iter()
            .chain(next["data"].as_array().unwrap())
            .map(|v| text(v, "id"))
            .collect::<BTreeSet<_>>()
            .len(),
        3
    );
    for query in ["limit=0", "limit=101", "cursor=bad", "extra=value"] {
        check(
            get(f, &format!("{route}?{query}"), t),
            400,
            "INVALID_PAGINATION",
        )
        .await?;
    }
    check(
        setup(f, "db_live", "denied", &read.token),
        403,
        "INSUFFICIENT_SCOPE",
    )
    .await?;
    let excluded = key(f, 0, &["resources:read", "resources:write"], &["fs_shared"]).await?;
    check(get(f, path, &excluded.token), 403, "RESOURCE_ACCESS_DENIED").await?;
    check(f.agent(1, Method::GET, path, Some(t)), 401, "").await?;
    assert_eq!(calls(f), before);
    for crash in [false, true] {
        let ephemeral = check(upload(f, t), 201, "").await?;
        f.restart(crash).await?;
        check(
            get(f, relative(&follow(&ephemeral)?), t),
            404,
            "PREPARATION_NOT_FOUND",
        )
        .await?;
        assert_eq!(
            check(setup(f, "db_live", "same", t), 201, "").await?.data,
            first.data
        );
        assert_eq!(check(get(f, path, t), 200, "").await?.data, first.data);
        assert_eq!(calls(f), before);
    }
    Ok(())
}
async fn fresh_setup(embedded: bool, crash: bool) -> Result<()> {
    use workspace_test_support::provider::SqlResponse;
    let mut f = Workspaces::start(embedded, true).await?;
    let fail = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let flag = fail.clone();
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let (started, unblock) = (entered.clone(), release.clone());
    let hold = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let held = hold.clone();
    f.provider.set_sql_hook(move |v| {
        let (started, unblock, flag, held) =
            (started.clone(), unblock.clone(), flag.clone(), held.clone());
        async move {
            if !text(&v, "sql").starts_with("CREATE SCHEMA") {
                return None;
            }
            if held.load(std::sync::atomic::Ordering::SeqCst) {
                started.notify_one();
                unblock.notified().await;
            }
            flag.load(std::sync::atomic::Ordering::SeqCst)
                .then(|| SqlResponse::Json(503, json!({"error":{"code":"SQL_EXECUTION_FAILED"}})))
        }
    });
    let create = |f: &Workspaces, name: &str, id: &str| {
        f.owner(0, Method::POST, "/resources")
            .header("Idempotency-Key", id)
            .json(&json!({"name":name,"kind":"postgresql","region":"automatic"}))
    };
    let resource = check(create(&f, "partial-setup", "partial-resource"), 201, "")
        .await?
        .data;
    assert_ne!(resource["data"]["status"], "active");
    let id = text(&resource["data"], "id");
    let setup = |f: &Workspaces, id: &str, attempt: &str| {
        f.owner(0, Method::POST, &format!("/resources/{id}/setup-attempts"))
            .header("Idempotency-Key", attempt)
    };
    if crash {
        hold.store(true, std::sync::atomic::Ordering::SeqCst);
        let active = tokio::spawn(send(setup(&f, id, "crashed")));
        tokio::time::timeout(Duration::from_secs(15), entered.notified()).await?;
        let state = check(
            f.owner(0, Method::GET, &format!("/resources/{id}/setup-attempts")),
            200,
            "",
        )
        .await?
        .data;
        assert_eq!(state["data"].as_array().unwrap().len(), 1);
        assert_eq!(state["data"][0]["status"], "outcome-unknown");
        let before = statements(&f);
        f.restart(true).await?;
        hold.store(false, std::sync::atomic::Ordering::SeqCst);
        fail.store(false, std::sync::atomic::Ordering::SeqCst);
        release.notify_one();
        let _ = active.await?;
        assert_eq!(
            check(setup(&f, id, "crashed"), 201, "").await?.data["data"],
            state["data"][0]
        );
        assert_eq!(statements(&f), before);
        assert_eq!(
            check(setup(&f, id, "explicit-new-attempt"), 201, "")
                .await?
                .data["data"]["status"],
            "succeeded"
        );
    } else {
        let binding = format!("bindings/db9/{id}");
        let creds = format!("credentials/db9/{id}");
        let keys = [binding.as_str(), creds.as_str()];
        let saved = f.records(0, &keys).await?;
        let counts = |f: &Workspaces| {
            let s = f.provider.state.lock().unwrap();
            (s.database_creates, s.account_creates)
        };
        let before = counts(&f);
        fail.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            check(setup(&f, id, "resume"), 201, "").await?.data["data"]["status"],
            "succeeded"
        );
        let after = f.records(0, &keys).await?;
        assert_eq!(
            after[&creds]["value"]["connection"],
            saved[&creds]["value"]["connection"]
        );
        assert_eq!(
            after[&binding]["value"]["instanceId"],
            saved[&binding]["value"]["instanceId"]
        );
        assert_eq!(counts(&f), before);
        f.provider.state.lock().unwrap().lost = true;
        let unknown = check(create(&f, "lost-setup", "lost-resource"), 201, "")
            .await?
            .data;
        f.provider.state.lock().unwrap().lost = false;
        assert_ne!(unknown["data"]["status"], "active");
        let id = text(&unknown["data"], "id");
        let recovered = check(setup(&f, id, "reconcile"), 201, "").await?.data;
        assert_eq!(recovered["data"]["status"], "succeeded");
        let calls_before = calls(&f);
        f.restart(true).await?;
        assert_eq!(
            check(setup(&f, id, "reconcile"), 201, "").await?.data,
            recovered
        );
        assert_eq!(calls(&f), calls_before);
    }
    Ok(())
}
pub(super) async fn run(embedded: bool) -> Result<()> {
    {
        let mut f = Workspaces::start(embedded, false).await?;
        f.seed_scale("resources",1,|_|json!({"id":"db_missing","name":"missing-binding","kind":"postgresql","provider":"db9-anonymous","region":"automatic","status":"failed","createdAt":"2026-01-01T00:00:00Z"})).await?;
        let name = Arc::new(Mutex::new("demo_table".to_string()));
        let shared = name.clone();
        f.provider.set_sql_hook(move|v|{let name=shared.clone();async move{
            text(&v,"sql").to_lowercase().contains("from information_schema.tables").then(||workspace_test_support::provider::SqlResponse::Json(200,json!({"columns":["name","type"],"rows":[{"name":name.lock().unwrap().clone(),"type":"BASE TABLE"}],"rowCount":1})))
        }});
        let full = key(
            &f,
            0,
            &[
                "resources:read",
                "resources:write",
                "queries:execute",
                "files:read",
                "files:write",
                "files:analyze",
            ],
            &["*"],
        )
        .await?;
        let read = key(
            &f,
            0,
            &["resources:read", "queries:read", "files:read"],
            &["*"],
        )
        .await?;
        imports_exports(&f, &full, &read).await?;
        setup_history(&mut f, &full, &read).await?;
        for raw in [
            "setup",
            "table",
            "rows",
            "report/setup",
            "literal%2Fname",
            "quote\" /百分号",
        ] {
            *name.lock().unwrap() = raw.into();
            let encoded =
                percent_encoding::utf8_percent_encode(raw, percent_encoding::NON_ALPHANUMERIC);
            let details = check(
                get(
                    &f,
                    &format!("/resources/db_live/tables/{encoded}"),
                    &full.token,
                ),
                200,
                "",
            )
            .await?
            .data;
            assert_eq!(details["name"], raw);
            assert_eq!(
                details["query"],
                format!(
                    "SELECT * FROM \"workspace\".\"{}\" LIMIT 100;",
                    raw.replace('"', "\"\"")
                )
            );
        }
        let before = calls(&f);
        for raw in ["%", "%GG", "%FF"] {
            check(
                get(&f, &format!("/resources/db_live/tables/{raw}"), &full.token),
                400,
                "INVALID_TABLE_NAME",
            )
            .await?;
        }
        for (path, method) in [
            ("/database-imports/prepare", Method::POST),
            ("/database-imports/prepare-upload", Method::POST),
            ("/file-exports/prepare", Method::POST),
            ("/resources/db_live/setup", Method::POST),
            ("/resources/db_live/table?name=demo_table", Method::GET),
            ("/resources/db_live/table/rows?name=demo_table", Method::GET),
            ("/files", Method::DELETE),
        ] {
            let mut req = f.agent(0, method.clone(), path, Some(&full.token));
            if method != Method::GET {
                req = req.json(&json!({}));
            }
            check(req, 404, "NOT_FOUND").await?;
        }
        check(
            post(&f, "/database-imports/prepare-upload", &full.token)
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .body("id\n1\n"),
            404,
            "NOT_FOUND",
        )
        .await?;
        assert_eq!(calls(&f), before);
    }
    fresh_setup(embedded, false).await?;
    fresh_setup(embedded, true).await
}
