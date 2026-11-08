use super::*;

const IDS: [&str; 4] = ["fs_shared", "fs_live", "db_live", "db_pg"];
fn write(f: &Workspaces, id: &str, path: &str, content: &str, t: &str) -> RequestBuilder {
    f.agent(0, Method::PUT, "/files", Some(t))
        .json(&json!({"resourceId":id,"path":path,"content":content,"type":"file"}))
}
fn meta(f: &Workspaces, id: &str, path: &str, t: &str) -> RequestBuilder {
    get(f, "/files/metadata", t).query(&[("resourceId", id), ("path", path)])
}
fn query(f: &Workspaces, id: &str, sql: &str, t: &str) -> RequestBuilder {
    post(f, "/queries", t).json(&json!({"resourceId":id,"sql":sql}))
}
async fn discovery(f: &Workspaces, full: &Key, read: &Key) -> Result<()> {
    let pages = key(f, 0, &["resources:read"], &["db_live", "fs_shared"]).await?;
    let mut ids = Vec::new();
    let mut cursor = Value::Null;
    loop {
        let mut req = get(f, "/resources?limit=1", &pages.token);
        if let Some(value) = cursor.as_str() {
            req = req.query(&[("cursor", value)]);
        }
        let page = check(req, 200, "").await?.data;
        let rows = page["data"].as_array().unwrap();
        assert!(rows.len() <= 1);
        ids.extend(rows.iter().map(|row| text(row, "id").to_owned()));
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(ids, ["db_live", "fs_shared"]);
    check(
        f.agent(1, Method::GET, "/resources?limit=1", Some(&pages.token)),
        401,
        "",
    )
    .await?;
    for (query, code) in [
        ("limit=0", "INVALID_PAGE_LIMIT"),
        ("limit=513", "INVALID_PAGE_LIMIT"),
        ("cursor=!!!", "INVALID_PAGE_CURSOR"),
        ("cursor=ZGJfcGc", "INVALID_PAGE_CURSOR"),
    ] {
        check(
            get(f, &format!("/resources?{query}"), &pages.token),
            400,
            code,
        )
        .await?;
    }
    let first = check(get(f, "/resources?limit=1", &pages.token), 200, "")
        .await?
        .data;
    f.revoke(0, &pages.meta).await?;
    check(
        get(f, "/resources", &pages.token).query(&[("cursor", text(&first, "nextCursor"))]),
        401,
        "INVALID_CREDENTIAL",
    )
    .await?;
    let minimal = key(f, 0, &["queries:read"], &["db_live"]).await?;
    let ctx = check(get(f, "/context", &minimal.token), 200, "")
        .await?
        .data;
    let mut principal = ctx["principal"].clone();
    assert_eq!(
        chrono::DateTime::parse_from_rfc3339(text(&principal, "expiresAt"))?.timestamp_millis(),
        minimal.expires * 1000
    );
    principal.as_object_mut().unwrap().remove("expiresAt");
    assert_eq!(
        principal,
        json!({"id":minimal.meta["principalId"],"kind":"workspaceKey","scopes":["queries:read"],"resourceIds":["db_live"]})
    );
    assert_eq!(ctx["workspaceId"], "ws_agentlab");
    assert_eq!(ctx["permissions"]["manageKeys"], false);
    assert_eq!(ctx["permissions"]["createResources"], false);
    assert_eq!(
        ctx["links"]["self"],
        "/api/v1/workspaces/ws_agentlab/context"
    );
    assert!(!ctx.to_string().contains(text(&full.meta, "keyId")));
    assert!(!ctx.to_string().contains("digest"));
    let implicit = check(get(f, "/context", &full.token), 200, "").await?.data;
    assert!(
        implicit["principal"]["scopes"]
            .as_array()
            .unwrap()
            .contains(&json!("queries:read"))
    );
    for token in [
        None,
        Some("bad-key"),
        Some("expired-coverage-key"),
        Some("revoked-coverage-key"),
    ] {
        check(f.agent(0, Method::GET, "/context", token), 401, "").await?;
    }
    check(
        f.agent(1, Method::GET, "/context", Some(&full.token)),
        401,
        "",
    )
    .await?;
    f.revoke(0, &minimal.meta).await?;
    check(
        get(f, "/context", &minimal.token),
        401,
        "INVALID_CREDENTIAL",
    )
    .await?;
    let download = json!({"sourceResourceId":"db_live","result":{"columns":["id"],"rows":[{"id":1}]},"target":{"kind":"download","format":"json"}});
    check(
        post(f, "/result-exports", &read.token).json(&download),
        200,
        "",
    )
    .await?;
    for id in ["db_live", "db_pg"] {
        check(query(f, id, "SELECT 1 AS connected", &read.token), 200, "").await?;
        check(
            get(f, &format!("/resources/{id}/tables"), &read.token),
            200,
            "",
        )
        .await?;
        let before = calls(f);
        for sql in [
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET id=2",
            "DELETE FROM t",
            "CREATE TABLE t(id int)",
            "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
            "SELECT * INTO copied FROM t",
            "SELECT * FROM t FOR UPDATE",
            "SELECT nextval('s')",
            "SELECT set_config('transaction_read_only','off',false)",
            "SELECT 1; DELETE FROM t",
            "SELECT 1 /*! INTO OUTFILE '/tmp/file' */",
        ] {
            check(
                query(f, id, sql, &read.token),
                403,
                "READ_ONLY_SQL_REQUIRED",
            )
            .await?;
        }
        assert_eq!(calls(f), before);
        for (sql, flag, status, code) in [
            ("DELETE FROM t", json!(true), 403, "READ_ONLY_SQL_REQUIRED"),
            ("SELECT 1", json!("true"), 400, "INVALID_BODY"),
        ] {
            check(
                post(f, "/queries", &full.token)
                    .json(&json!({"resourceId":id,"sql":sql,"readOnly":flag})),
                status,
                code,
            )
            .await?;
        }
    }
    check(
        post(f, "/queries", &full.token)
            .json(&json!({"resourceId":"db_live","sql":"SELECT 1","readOnly":null})),
        400,
        "INVALID_BODY",
    )
    .await?;
    check(post(f,"/database-import-preparations?resourceId=db_live&filename=x.csv&format=csv&header=true&delimiter=%2C",&read.token).header(header::CONTENT_TYPE,"application/octet-stream").body("id\n1\n"),403,"INSUFFICIENT_SCOPE").await?;
    let mut export = download;
    export["target"] = json!({"kind":"database","resourceId":"db_pg","table":"forbidden"});
    check(
        post(f, "/result-exports", &read.token).json(&export),
        403,
        "INSUFFICIENT_SCOPE",
    )
    .await?;
    Ok(())
}
async fn compare_write(
    f: &Workspaces,
    id: &str,
    path: &str,
    token: &str,
    version: &str,
) -> Result<()> {
    let a = send(write(f, id, path, "one", token).header(header::IF_MATCH, version));
    let b = send(write(f, id, path, "two", token).header(header::IF_MATCH, version));
    let (a, b) = tokio::try_join!(a, b)?;
    let mut statuses = [a.status, b.status];
    statuses.sort();
    assert_eq!(statuses, [200, 412]);
    Ok(())
}
async fn files(f: &mut Workspaces, t: &str) -> Result<String> {
    let path = "/p0-local.txt";
    check(
        write(f, "fs_shared", path, "original", t).header(header::IF_NONE_MATCH, "*"),
        200,
        "",
    )
    .await?;
    let preflight = workspace_test_support::http_client()?
        .request(
            Method::OPTIONS,
            format!("{}/api/v1/workspaces/ws_agentlab/files", f.origin(0)),
        )
        .header(header::ORIGIN, "http://127.0.0.1:5173")
        .header("Access-Control-Request-Method", "PUT")
        .header(
            "Access-Control-Request-Headers",
            "authorization, content-type, if-match",
        );
    assert!(
        check(preflight, 204, "").await?.headers[header::ACCESS_CONTROL_ALLOW_HEADERS]
            .to_str()?
            .contains("if-match")
    );
    let m = workspace_test_support::http_client()?
        .get(format!(
            "{}/api/v1/workspaces/ws_agentlab/files/metadata",
            f.origin(0)
        ))
        .bearer_auth(t)
        .query(&[("resourceId", "fs_shared"), ("path", path)])
        .header(header::ORIGIN, "http://127.0.0.1:5173");
    let initial = check(m, 200, "").await?;
    assert!(
        initial.headers[header::ACCESS_CONTROL_EXPOSE_HEADERS]
            .to_str()?
            .to_lowercase()
            .contains("etag")
    );
    let original = text(&initial.data["data"], "version");
    assert_eq!(initial.headers[header::ETAG], original);
    compare_write(f, "fs_shared", path, t, original).await?;
    let m = check(meta(f, "fs_shared", path, t), 200, "").await?.data;
    let current = text(&m["data"], "version");
    assert_ne!(current, original);
    check(
        write(f, "fs_shared", path, "stale", t).header(header::IF_MATCH, original),
        412,
        "PRECONDITION_FAILED",
    )
    .await?;
    let list = check(get(f, "/files?resourceId=fs_shared", t), 200, "")
        .await?
        .data;
    let content = text(
        list["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["path"] == path)
            .unwrap(),
        "content",
    );
    check(
        write(f, "fs_shared", path, content, t).header(header::IF_MATCH, current),
        200,
        "",
    )
    .await?;
    assert_ne!(
        check(meta(f, "fs_shared", path, t), 200, "").await?.data["data"]["version"],
        current
    );
    check(
        write(f, "fs_shared", path, "exists", t).header(header::IF_NONE_MATCH, "*"),
        412,
        "",
    )
    .await?;
    check(
        delete(f, "/files/entry", t).query(&[("resourceId", "fs_shared"), ("path", path)]),
        200,
        "",
    )
    .await?;
    check(
        write(f, "fs_shared", path, "missing", t).header(header::IF_MATCH, current),
        412,
        "",
    )
    .await?;
    check(write(f, "fs_shared", path, "recreated", t), 200, "").await?;
    check(
        write(f, "fs_shared", path, "old", t).header(header::IF_MATCH, current),
        412,
        "",
    )
    .await?;
    for h in [
        vec![("If-Match", "*")],
        vec![("If-Match", "W/\"weak\"")],
        vec![("If-Match", "\"one\", \"two\"")],
        vec![("If-Match", "\"valid\""), ("If-None-Match", "*")],
        vec![("If-None-Match", "invalid")],
    ] {
        let mut req = write(f, "fs_shared", path, "invalid", t);
        for (k, v) in h {
            req = req.header(k, v);
        }
        check(req, 400, "INVALID_PRECONDITION").await?;
    }
    let remote = "/live.csv";
    let m = check(meta(f, "fs_live", remote, t), 200, "").await?;
    let version = text(&m.data["data"], "version");
    assert_eq!(m.headers[header::ETAG], version);
    assert_eq!(m.data["data"]["conditionalWrites"], true);
    let raw = "/files/content?resourceId=fs_live&path=/live.csv";
    check(
        f.agent(0, Method::PUT, raw, Some(t))
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(header::IF_MATCH, version)
            .body("first"),
        200,
        "",
    )
    .await?;
    check(
        write(f, "fs_live", remote, "stale", t).header(header::IF_MATCH, version),
        412,
        "",
    )
    .await?;
    let m = check(meta(f, "fs_live", remote, t), 200, "").await?.data;
    let current = text(&m["data"], "version");
    f.provider.state.lock().unwrap().write_race = Some(Box::new(|path, files| {
        files.insert(path.into(), b"upstream concurrent change".to_vec());
        None
    }));
    check(
        write(f, "fs_live", remote, "must not overwrite", t).header(header::IF_MATCH, current),
        412,
        "PRECONDITION_FAILED",
    )
    .await?;
    assert_eq!(
        check(get(f, raw, t), 200, "").await?.bytes,
        b"upstream concurrent change"
    );
    let m = check(meta(f, "fs_live", remote, t), 200, "").await?.data;
    compare_write(f, "fs_live", remote, t, text(&m["data"], "version")).await?;
    f.provider.state.lock().unwrap().write_race = Some(Box::new(|_, _| Some((404, json!({})))));
    check(
        write(
            f,
            "fs_live",
            "/missing-parent/child.txt",
            "must not create",
            t,
        )
        .header(header::IF_NONE_MATCH, "*"),
        404,
        "NOT_FOUND",
    )
    .await?;
    let retained = check(meta(f, "fs_live", remote, t), 200, "").await?.data;
    let version = text(&retained["data"], "version");
    f.provider.state.lock().unwrap().versions_available = false;
    let unsupported = check(meta(f, "fs_live", remote, t), 200, "").await?.data;
    assert_eq!(unsupported["data"]["version"], Value::Null);
    assert_eq!(unsupported["data"]["conditionalWrites"], false);
    check(
        write(f, "fs_live", remote, "must not fall back", t).header(header::IF_MATCH, version),
        409,
        "FILE_VERSION_UNAVAILABLE",
    )
    .await?;
    f.provider.state.lock().unwrap().versions_available = true;
    let local = check(meta(f, "fs_shared", path, t), 200, "").await?.data;
    let local = text(&local["data"], "version");
    f.restart(true).await?;
    for (id, path, v) in [("fs_shared", path, local), ("fs_live", remote, version)] {
        assert_eq!(
            check(meta(f, id, path, t), 200, "").await?.data["data"]["version"],
            v
        );
        check(
            write(f, id, path, "after restart", t).header(header::IF_MATCH, v),
            200,
            "",
        )
        .await?;
    }
    Ok(text(
        &check(meta(f, "fs_live", remote, t), 200, "").await?.data["data"],
        "version",
    )
    .into())
}
async fn deletion(f: &mut Workspaces, read: &Key, full: &Key, retained: &str) -> Result<()> {
    let t = read.token.as_str();
    let owner = full.token.as_str();
    let detail = check(get(f, "/resources/db_live", t), 200, "").await?.data;
    let d = &detail["data"];
    assert_eq!(d["id"], "db_live");
    assert_eq!(d["capabilities"]["delete"], true);
    let actions = d["allowedActions"].as_array().unwrap();
    assert!(actions.contains(&json!("queries:read")));
    assert!(!actions.contains(&json!("queries:execute")));
    let restricted = key(f, 0, &["resources:read", "resources:write"], &["fs_shared"]).await?;
    let before = calls(f);
    for method in [Method::GET, Method::DELETE] {
        check(
            f.agent(0, method, "/resources/fs_live", Some(&restricted.token)),
            403,
            "RESOURCE_ACCESS_DENIED",
        )
        .await?;
    }
    check(
        delete(f, "/resources/fs_live", t),
        403,
        "INSUFFICIENT_SCOPE",
    )
    .await?;
    check(
        f.agent(1, Method::DELETE, "/resources/fs_live", Some(owner)),
        401,
        "",
    )
    .await?;
    assert_eq!(calls(f), before);
    check(
        get(f, "/resources/missing", owner),
        403,
        "RESOURCE_ACCESS_DENIED",
    )
    .await?;
    let wildcard = key(f, 0, &["resources:read", "resources:write"], &["*"]).await?;
    check(
        delete(f, "/resources/db_retired_mysql", &wildcard.token),
        404,
        "NOT_FOUND",
    )
    .await?;
    assert_eq!(
        check(get(f, "/resources/db_live", t), 200, "").await?.data["data"]["status"],
        "active"
    );
    let keys = [
        "bindings/drive9/fs_live",
        "credentials/drive9/fs_live",
        "bindings/db9/db_live",
        "credentials/db9/db_live",
    ];
    let bindings = f.records(0, &keys).await?;
    let local = check(delete(f, "/resources/fs_shared", owner), 200, "")
        .await?
        .data;
    assert_eq!(local["data"]["status"], "deleted");
    assert_eq!(local["data"]["deletion"]["phase"], "completed");
    assert!(
        check(get(f, "/resources", t), 200, "").await?.data["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["id"] != "fs_shared")
    );
    check(delete(f, "/resources/fs_shared", owner), 200, "").await?;
    check(
        get(f, "/files?resourceId=fs_shared", t),
        409,
        "RESOURCE_DELETING",
    )
    .await?;
    check(
        write(f, "fs_shared", "/blocked.txt", "blocked", t),
        409,
        "RESOURCE_DELETING",
    )
    .await?;
    assert_eq!(
        check(get(f, "/context", t), 200, "").await?.data["principal"]["id"],
        read.meta["principalId"]
    );
    assert_eq!(
        check(
            f.owner(1, Method::GET, "/files?resourceId=fs_shared"),
            200,
            ""
        )
        .await?
        .data["data"][0]["content"],
        "ws_other"
    );
    f.seed_scale("resources",1,|_|json!({"id":"fs_scale_00000000","kind":"filesystem","provider":"local","name":"scale","region":"aws-ap-southeast-1","status":"active","createdAt":"2026-01-01T00:00:00Z"})).await?;
    let (entered, release) = f.provider.hold_next_file_write();
    let writing = tokio::spawn(check(
        write(f, "fs_live", "/live.csv", "drained before removal", t)
            .header(header::IF_MATCH, retained),
        200,
        "",
    ));
    tokio::time::timeout(Duration::from_secs(10), entered).await??;
    let mut deleting = tokio::spawn(check(delete(f, "/resources/fs_live", owner), 202, ""));
    tokio::time::timeout(
        Duration::from_secs(5),
        check(
            f.owner(0, Method::DELETE, "/resources/fs_scale_00000000"),
            200,
            "",
        ),
    )
    .await??;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut deleting)
            .await
            .is_err()
    );
    assert!(f.provider.state.lock().unwrap().deleted.is_empty());
    let _ = release.send(());
    writing.await??;
    let accepted = deleting.await??;
    assert_eq!(
        accepted.data["data"]["deletion"]["phase"],
        "provider-accepted"
    );
    assert_eq!(
        accepted.headers[header::LOCATION],
        "/api/v1/workspaces/ws_agentlab/resources/fs_live"
    );
    assert_eq!(f.provider.state.lock().unwrap().deleted.len(), 1);
    for crash in [false, true] {
        f.restart(crash).await?;
        check(delete(f, "/resources/fs_live", owner), 202, "").await?;
        assert_eq!(f.provider.state.lock().unwrap().deleted.len(), 1);
        assert_eq!(
            check(get(f, "/resources/fs_live", t), 200, "").await?.data["data"]["deletion"]["phase"],
            "provider-accepted"
        );
        check(
            get(f, "/files/content?resourceId=fs_live&path=/live.csv", t),
            409,
            "RESOURCE_DELETING",
        )
        .await?;
        check(query(f, "db_live", "SELECT 1 AS connected", t), 200, "").await?;
        let records = f.records(0, &keys).await?;
        for key in keys {
            assert_eq!(records[key]["value"], bindings[key]["value"]);
        }
        assert_eq!(
            check(get(f, "/context", t), 200, "").await?.data["principal"]["id"],
            read.meta["principalId"]
        );
    }
    assert_eq!(f.provider.state.lock().unwrap().database_creates, 0);
    f.provider.state.lock().unwrap().file_status = "deleted".into();
    assert_eq!(
        check(get(f, "/resources/fs_live", t), 200, "").await?.data["data"]["status"],
        "deleted"
    );
    assert_eq!(
        check(delete(f, "/resources/db_pg", owner), 202, "")
            .await?
            .data["data"]["deletion"]["phase"],
        "provider-accepted"
    );
    let before = f.provider.state.lock().unwrap().deleted.len();
    check(delete(f, "/resources/db_pg", owner), 202, "").await?;
    assert_eq!(f.provider.state.lock().unwrap().deleted.len(), before);
    check(query(f, "db_pg", "SELECT 1", t), 409, "RESOURCE_DELETING").await?;
    check(
        delete(f, "/resources/db_duck", owner),
        403,
        "RESOURCE_ACCESS_DENIED",
    )
    .await?;
    assert_eq!(f.provider.state.lock().unwrap().deleted.len(), before);
    assert!(
        f.provider
            .state
            .lock()
            .unwrap()
            .deleted
            .iter()
            .any(|(kind, _)| kind == "db9")
    );
    let records = f
        .records(
            0,
            &[
                "credentials/db9/db_pg",
                "credentials/drive9/hidden-storage",
                "credentials/accounts/db9",
            ],
        )
        .await?;
    assert_eq!(
        records["credentials/db9/db_pg"]["value"]["connection"]["password"],
        NATIVE_SECRET
    );
    assert_eq!(
        records["credentials/drive9/hidden-storage"]["value"]["apiKey"],
        NATIVE_SECRET
    );
    assert_eq!(
        records["credentials/accounts/db9"]["value"]["anonymousSecret"],
        NATIVE_SECRET
    );
    Ok(())
}
pub(super) async fn run(embedded: bool) -> Result<()> {
    {
        let mut f = Workspaces::start(embedded, false).await?;
        let read = key(
            &f,
            0,
            &[
                "queries:read",
                "resources:read",
                "files:read",
                "files:write",
            ],
            &IDS,
        )
        .await?;
        let full = key(
            &f,
            0,
            &[
                "queries:execute",
                "resources:read",
                "resources:write",
                "files:read",
                "files:write",
            ],
            &IDS,
        )
        .await?;
        discovery(&f, &full, &read).await?;
        let retained = files(&mut f, &read.token).await?;
        deletion(&mut f, &read, &full, &retained).await?;
    }
    let mut f = Workspaces::start(embedded, false).await?;
    f.provider.state.lock().unwrap().delete_lost = true;
    let keys = ["bindings/drive9/fs_live", "credentials/drive9/fs_live"];
    let before = f.records(0, &keys).await?;
    for crash in [false, true] {
        if crash {
            f.restart(true).await?;
        }
        assert_eq!(
            check(f.owner(0, Method::DELETE, "/resources/fs_live"), 202, "")
                .await?
                .data["data"]["deletion"]["phase"],
            "outcome-unknown"
        );
        assert_eq!(f.provider.state.lock().unwrap().deleted.len(), 1);
    }
    let after = f.records(0, &keys).await?;
    for key in keys {
        assert_eq!(before[key]["value"], after[key]["value"]);
    }
    let state = f.provider.state.lock().unwrap();
    assert_eq!(state.account_creates, 0);
    assert_eq!(state.creates, 0);
    Ok(())
}
