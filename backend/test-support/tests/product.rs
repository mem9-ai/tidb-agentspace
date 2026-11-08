use anyhow::{Context, Result, ensure};
use reqwest::Method;
use serde_json::{Value, json};
use workspace_test_support::workspaces;
use workspaces::{Workspaces, expect};

#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn retired_database_resources_and_scopes_never_reach_the_provider() -> Result<()> {
    let f = Workspaces::start(false, false).await?;
    let paths = [
        "state/resources/db_retired_mysql",
        "bindings/zero/db_retired_mysql",
        "credentials/zero/db_retired_mysql",
        "state/resources/db_duck",
        "bindings/duckdb/db_duck",
        "credentials/duckdb/db_duck",
    ];
    let before = f.records(0, &paths).await?;
    let key = f
        .create_key(
            0,
            "retired-database-denial",
            &["resources:read", "queries:execute"],
            &["*"],
        )
        .await?;
    let token = f.exchange(0, key["secret"].as_str().unwrap()).await?;
    let calls = f.provider.state.lock().unwrap().calls;
    for route in ["/resources", "/context", "/bootstrap"] {
        let body = expect(f.owner(0, Method::GET, route), 200).await?;
        let kinds = body["capabilities"]
            .as_object()
            .context("capabilities")?
            .keys()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            kinds,
            std::collections::BTreeSet::from(["postgresql", "filesystem"])
        );
        if route == "/resources" {
            let data = body["data"].as_array().unwrap();
            for id in ["db_pg", "fs_shared"] {
                assert!(data.iter().any(|v| v["id"] == id));
            }
            assert!(
                data.iter()
                    .all(|v| v["kind"] != "duckdb" && v["kind"] != "mysql")
            );
        }
    }
    for (kind, id) in [("mysql", "db_retired_mysql"), ("duckdb", "db_duck")] {
        let target = f
            .create_key(0, "retired-target", &["resources:read"], &[id])
            .await?;
        assert_eq!(target["regionalStatus"], "pending");
        let denial = expect(
            f.global(
                0,
                Method::POST,
                "/token-issuances",
                target["secret"].as_str(),
            )
            .json(&json!({"audience":workspaces::REGION})),
            503,
        )
        .await?;
        assert!(denial.get("accessToken").is_none());
        for m in [Method::GET, Method::DELETE] {
            expect(f.owner(0, m, &format!("/resources/{id}")), 404).await?;
        }
        let bad = expect(
            f.owner(0, Method::POST, "/resources")
                .json(&json!({"kind":kind,"name":"retired-db","region":"automatic"})),
            400,
        )
        .await?;
        assert_eq!(bad["error"]["code"], "INVALID_KIND");
        for req in [
            f.owner(0, Method::POST, "/queries"),
            f.agent(0, Method::POST, "/queries", Some(&token)),
        ] {
            expect(req.json(&json!({"resourceId":id,"sql":"SELECT 1"})), 404).await?;
        }
        expect(
            f.owner(0, Method::GET, &format!("/resources/{id}/tables")),
            404,
        )
        .await?;
        expect(
            f.owner(0, Method::POST, &format!("/resources/{id}/setup-attempts"))
                .header("Idempotency-Key", "retired"),
            404,
        )
        .await?;
        expect(f.owner(0,Method::POST,"/database-import-preparations").json(&json!({"resourceId":id,"source":{"resourceId":"fs_shared","path":"/identity.txt"},"parsing":{"format":"csv","header":true,"delimiter":","}})),404).await?;
        for (source, target) in [
            (id, json!({"kind":"download","format":"csv"})),
            (
                "db_pg",
                json!({"kind":"database","resourceId":id,"table":"retired_target"}),
            ),
        ] {
            expect(f.owner(0,Method::POST,"/result-exports").json(&json!({"sourceResourceId":source,"result":{"columns":["n"],"rows":[{"n":1}]},"target":target})),404).await?;
        }
    }
    assert_eq!(f.provider.state.lock().unwrap().calls, calls);
    assert_eq!(f.records(0, &paths).await?, before);
    expect(
        f.owner(0, Method::POST, "/queries")
            .json(&json!({"resourceId":"db_pg","sql":"SELECT 1"})),
        200,
    )
    .await?;
    expect(f.owner(0,Method::PUT,"/files").header("If-None-Match","*").json(&json!({"resourceId":"fs_shared","path":"/retirement-test.csv","type":"file","content":"state,sales\nCA,10\n"})),200).await?;
    let analyzed=expect(f.owner(0,Method::POST,"/file-analyses").json(&json!({"resourceId":"fs_shared","path":"/retirement-test.csv","engine":"duckdb","sql":"SELECT * FROM file"})),200).await?;
    assert_eq!(analyzed["rows"].as_array().unwrap().len(), 1);
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn audit_outage_blocks_mutation_before_provider_io() -> Result<()> {
    let mut f = Workspaces::start(false, false).await?;
    expect(f.owner(0, Method::GET, "/resources"), 200).await?;
    f.region.process.stop()?;
    let calls = f.provider.state.lock().unwrap().calls;
    let r = expect(
        f.owner(
            0,
            Method::PUT,
            "/files/content?resourceId=fs_live&path=%2Fmust-not-exist",
        )
        .header("Content-Type", "application/octet-stream")
        .body("private-content"),
        503,
    )
    .await?;
    assert_eq!(r["error"]["code"], "AUDIT_UNAVAILABLE");
    assert!(
        r["error"]["message"]
            .as_str()
            .unwrap()
            .contains("did not start")
    );
    assert_eq!(f.provider.state.lock().unwrap().calls, calls);
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn image_preview_rejects_oversized_images_before_read() -> Result<()> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let f = Workspaces::start(false, false).await?;
    let mut bytes = vec![0; 1024 * 1024];
    bytes[..8].copy_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
    {
        let mut state = f.provider.state.lock().unwrap();
        state.files.insert("/limit.png".into(), bytes.clone());
        state
            .files
            .insert("/too-large.png".into(), vec![0; 1024 * 1024 + 1]);
        state
            .files
            .insert("/wrong.png".into(), b"not an image".to_vec());
    }
    let preview = |file: &str| {
        f.owner(
            0,
            Method::GET,
            &format!("/files/content?resourceId=fs_live&path=%2F{file}&preview=1"),
        )
    };
    let exact = expect(preview("limit.png"), 200).await?;
    assert_eq!(exact["size"], bytes.len());
    assert!(
        exact["unavailableReason"]
            .as_str()
            .unwrap()
            .contains("this version")
    );
    assert_eq!(
        STANDARD.decode(exact["image"]["base64"].as_str().context("image body")?)?,
        bytes
    );
    let reads = f.provider.state.lock().unwrap().file_reads;
    let large = expect(preview("too-large.png"), 200).await?;
    assert_eq!(f.provider.state.lock().unwrap().file_reads, reads);
    assert!(
        large["unavailableReason"]
            .as_str()
            .unwrap()
            .contains("1 MiB")
    );
    assert!(large.get("image").is_none());
    let wrong = expect(preview("wrong.png"), 200).await?;
    assert!(
        wrong["unavailableReason"]
            .as_str()
            .unwrap()
            .contains("invalid")
    );
    Ok(())
}

fn put(
    f: &Workspaces,
    resource: &str,
    path: &str,
    kind: &str,
    content: &str,
) -> reqwest::RequestBuilder {
    f.owner(0, Method::PUT, "/files")
        .json(&json!({"resourceId":resource,"path":path,"type":kind,"content":content}))
}
async fn listed_paths(f: &Workspaces) -> Result<Vec<String>> {
    let list = expect(f.owner(0, Method::GET, "/files?resourceId=fs_shared"), 200).await?;
    let mut paths = list["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["path"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn parallel_writes_to_two_filesystems_preserve_both_events() -> Result<()> {
    let f = Workspaces::start(false, false).await?;
    f.guarded("commit",json!({"mutationId":uuid::Uuid::new_v4().to_string(),"changes":[{"key":"state/resources/fs_second","expectedVersion":null,"value":{"position":50,"record":{"id":"fs_second","name":"fs_second","kind":"filesystem","region":"aws-us-east-1","provider":"local","status":"active","createdAt":"2026-01-01T00:00:00Z"}}}]})).await?;
    tokio::try_join!(
        expect(
            put(&f, "fs_shared", "/parallel.txt", "file", "fs_shared"),
            200
        ),
        expect(
            put(&f, "fs_second", "/parallel.txt", "file", "fs_second"),
            200
        )
    )?;
    for resource in ["fs_shared", "fs_second"] {
        let list = expect(
            f.owner(0, Method::GET, &format!("/files?resourceId={resource}")),
            200,
        )
        .await?;
        let row = list["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["path"] == "/parallel.txt")
            .unwrap();
        assert_eq!(row["content"], resource);
    }
    let events = f
        .guarded("list", json!({"prefix":"state/events/","limit":512}))
        .await?;
    assert_eq!(
        events["records"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["value"]["record"]["resource"] == "/parallel.txt")
            .count(),
        2
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn deleting_filesystem_clears_index_in_batches() -> Result<()> {
    let f = Workspaces::start(false, false).await?;
    f.seed_files(64, Some("fs_shared")).await?;
    expect(put(&f, "fs_shared", "/nested", "directory", ""), 200).await?;
    expect(
        put(&f, "fs_shared", "/nested/item.txt", "file", "item"),
        200,
    )
    .await?;
    let deleted = expect(f.owner(0, Method::DELETE, "/resources/fs_shared"), 200).await?;
    assert_eq!(deleted["data"]["status"], "deleted");
    let paths = [
        "state/files/file_scale_00000000",
        "state/files/file_scale_00000063",
    ];
    let records = f.records(0, &paths).await?;
    for p in paths {
        assert!(records[p].is_null());
    }
    expect(f.owner(0, Method::GET, "/files?resourceId=fs_shared"), 409).await?;
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn directory_deletion_and_conditional_writes_are_atomic() -> Result<()> {
    let f = Workspaces::start(false, false).await?;
    expect(put(&f, "fs_shared", "/race", "directory", ""), 200).await?;
    let (child, deleted) = tokio::try_join!(
        put(&f, "fs_shared", "/race/child.txt", "file", "child").send(),
        f.owner(
            0,
            Method::DELETE,
            "/files/entry?resourceId=fs_shared&path=%2Frace"
        )
        .send()
    )?;
    let (created, removed) = (child.status() == 200, deleted.status() == 200);
    assert!(!(created && removed));
    if created {
        assert_eq!(
            deleted.json::<Value>().await?["error"]["code"],
            "DIRECTORY_NOT_EMPTY"
        );
    }
    if removed {
        assert_eq!(
            child.json::<Value>().await?["error"]["code"],
            "PARENT_MISSING"
        );
    }
    expect(put(&f, "fs_shared", "/compare.txt", "file", "before"), 200).await?;
    let meta = expect(
        f.owner(
            0,
            Method::GET,
            "/files/metadata?resourceId=fs_shared&path=%2Fcompare.txt",
        ),
        200,
    )
    .await?;
    let write = |value| {
        put(&f, "fs_shared", "/compare.txt", "file", value)
            .header("If-Match", meta["data"]["version"].as_str().unwrap())
            .send()
    };
    let (a, b) = tokio::try_join!(write("one"), write("two"))?;
    let mut codes = [a.status().as_u16(), b.status().as_u16()];
    codes.sort();
    assert_eq!(codes, [200, 412]);
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn ten_thousand_files_support_bounded_pages_and_point_operations() -> Result<()> {
    let f = Workspaces::start(false, false).await?;
    f.seed_files(10000, Some("fs_shared")).await?;
    let bootstrap = expect(f.owner(0, Method::GET, "/bootstrap"), 200).await?;
    assert_eq!(bootstrap["files"], json!([]));
    let file_count = |v: &Value| {
        v.as_array()
            .unwrap()
            .iter()
            .find(|v| v["resourceId"] == "fs_shared")
            .unwrap()["fileCount"]
            .as_u64()
    };
    assert_eq!(file_count(&bootstrap["usage"]), Some(10001));
    let first = expect(
        f.owner(0, Method::GET, "/files?resourceId=fs_shared&limit=16"),
        200,
    )
    .await?;
    let a = first["data"].as_array().unwrap();
    assert_eq!(a.len(), 16);
    let cursor = first["nextCursor"].as_str().context("next page")?;
    let second = expect(
        f.owner(0, Method::GET, "/files").query(&[
            ("resourceId", "fs_shared"),
            ("limit", "16"),
            ("cursor", cursor),
        ]),
        200,
    )
    .await?;
    let b = second["data"].as_array().unwrap();
    assert_eq!(b.len(), 16);
    assert!(a.iter().all(|x| b.iter().all(|y| x["id"] != y["id"])));
    let path = "/synthetic-00009999.txt";
    expect(
        f.owner(0, Method::GET, "/files/metadata")
            .query(&[("resourceId", "fs_shared"), ("path", path)]),
        200,
    )
    .await?;
    expect(put(&f, "fs_shared", path, "file", "updated"), 200).await?;
    let preview = expect(
        f.owner(0, Method::GET, "/files/content").query(&[
            ("resourceId", "fs_shared"),
            ("path", path),
            ("preview", "1"),
        ]),
        200,
    )
    .await?;
    assert_eq!(preview["content"], "updated");
    assert_eq!(
        file_count(&expect(f.owner(0, Method::GET, "/usage"), 200).await?["data"]),
        Some(10001)
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn index_migration_only_reads_selected_filesystem_and_survives_restart() -> Result<()> {
    let mut f = Workspaces::start(false, false).await?;
    f.seed_files(4100, None).await?;
    let boot = expect(f.owner(0, Method::GET, "/bootstrap"), 200).await?;
    assert_eq!(boot["files"], json!([]));
    assert_eq!(
        boot["usage"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["resourceId"] == "fs_shared")
            .unwrap()["fileCount"],
        1
    );
    assert_eq!(listed_paths(&f).await?, ["/identity.txt"]);
    expect(put(&f, "fs_shared", "/added.txt", "file", "ok"), 200).await?;
    assert_eq!(listed_paths(&f).await?, ["/added.txt", "/identity.txt"]);
    f.restart(false).await?;
    assert_eq!(listed_paths(&f).await?, ["/added.txt", "/identity.txt"]);
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn legacy_key_cleanup_keeps_global_key_valid() -> Result<()> {
    use sha2::{Digest, Sha256};
    let mut f = Workspaces::start(false, false).await?;
    let key = f
        .create_key(
            0,
            "retained-global-key",
            &["queries:execute"],
            &["db_memory"],
        )
        .await?;
    let token = f.exchange(0, key["secret"].as_str().unwrap()).await?;
    f.seed_scale("keys",4100,|n|{let id=format!("key_scale_{n:08}");json!({"id":id,"name":id,"digest":hex::encode(Sha256::digest(id.as_bytes())),"scopes":["resources:read"],"resourceIds":["*"],"expiresAt":"2099-01-01T00:00:00.000Z","revokedAt":null})}).await?;
    f.restart(false).await?;
    let boot = expect(f.owner(0, Method::GET, "/bootstrap"), 200).await?;
    assert_eq!(boot["keys"], json!([]));
    expect(
        f.agent(0, Method::GET, "/resources", Some("key_scale_00000000")),
        401,
    )
    .await?;
    expect(f.owner(0, Method::GET, "/keys"), 404).await?;
    expect(
        f.agent(0, Method::POST, "/queries", Some(&token))
            .json(&json!({"resourceId":"db_memory","sql":"SELECT 1"})),
        200,
    )
    .await?;
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn slow_postgresql_query_is_recorded_after_clock_reservation_expires() -> Result<()> {
    use std::time::Duration;
    use workspace_test_support::provider::SqlResponse;
    let f = Workspaces::configured(false, false, true).await?;
    f.provider.set_sql_hook(|_| async {
        tokio::time::sleep(Duration::from_millis(6100)).await;
        Some(SqlResponse::Json(
            200,
            json!({"columns":["total"],"rows":[{"total":42}],"rowCount":1}),
        ))
    });
    let key = f
        .create_key(
            0,
            "query-reader",
            &["queries:read", "usage:read"],
            &["db_pg"],
        )
        .await?;
    let token = f.exchange(0, key["secret"].as_str().unwrap()).await?;
    let before = expect(f.agent(0, Method::GET, "/usage", Some(&token)), 200).await?;
    let result = expect(
        f.agent(0, Method::POST, "/queries", Some(&token))
            .json(&json!({"resourceId":"db_pg","sql":"SELECT 42 AS total"})),
        200,
    )
    .await?;
    assert_eq!(result["rows"], json!([{"total":42}]));
    let after = expect(f.agent(0, Method::GET, "/usage", Some(&token)), 200).await?;
    assert_eq!(
        after["queryCount"].as_u64().unwrap(),
        before["queryCount"].as_u64().unwrap() + 1
    );
    assert_eq!(
        f.provider
            .state
            .lock()
            .unwrap()
            .statements
            .iter()
            .filter(|s| *s == "SELECT 42 AS total")
            .count(),
        1
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn concurrent_key_access_is_fenced_after_confirmed_revocation() -> Result<()> {
    let f = Workspaces::start(false, false).await?;
    let key = f
        .create_key(0, "concurrent-reader", &["resources:read"], &["*"])
        .await?;
    let token = f.exchange(0, key["secret"].as_str().unwrap()).await?;
    futures::future::try_join_all(
        (0..4).map(|_| expect(f.agent(0, Method::GET, "/context", Some(&token)), 200)),
    )
    .await?;
    f.revoke(0, &key["data"]).await?;
    expect(f.agent(0, Method::GET, "/context", Some(&token)), 401).await?;
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn history_requires_owner_and_discloses_unavailable_collection() -> Result<()> {
    let f = Workspaces::start(false, false).await?;
    let key = f
        .create_key(0, "broad-agent", &["resources:read", "files:read"], &["*"])
        .await?;
    let token = f.exchange(0, key["secret"].as_str().unwrap()).await?;
    for route in ["/audit-history", "/request-history"] {
        let r = f.owner(0, Method::GET, route).send().await?;
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["cache-control"], "no-store");
        let v = r.json::<Value>().await?;
        assert_eq!(v["data"], json!([]));
        assert_eq!(v["coverage"]["status"], "partial");
        assert_eq!(v["health"]["status"], "unavailable");
        for (auth, status) in [(None, 401), (Some(token.as_str()), 403)] {
            expect(
                f.agent(0, Method::GET, &format!("{route}?limit=bad"), auth),
                status,
            )
            .await?;
        }
        expect(
            f.owner(0, Method::GET, &format!("{route}?limit=1&limit=2")),
            400,
        )
        .await?;
        expect(
            f.at(
                0,
                Method::GET,
                &format!("/api/v1/workspaces/ws_other{route}"),
                true,
            ),
            404,
        )
        .await?;
        expect(
            f.at(
                0,
                Method::GET,
                &format!("/api/v1/workspaces/ws_agentlab{route}"),
                true,
            ),
            200,
        )
        .await?;
    }
    Ok(())
}

async fn history_rows(
    f: &Workspaces,
    route: &str,
    id: &str,
    count: usize,
) -> Result<(Value, Vec<Value>)> {
    use std::time::{Duration, Instant};
    let end = Instant::now() + Duration::from_secs(20);
    loop {
        let page = expect(f.owner(0, Method::GET, route), 200).await?;
        let records = page["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["requestId"] == id)
            .cloned()
            .collect::<Vec<_>>();
        if records.len() == count {
            return Ok((page, records));
        }
        ensure!(Instant::now() < end, "{route}: missing history records");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn request_history_redacts_secrets_paths_and_other_workspaces() -> Result<()> {
    let f = Workspaces::start(false, false).await?;
    let key = f
        .create_key(0, "read-resources-only", &["resources:read"], &["*"])
        .await?;
    let token = f.exchange(0, key["secret"].as_str().unwrap()).await?;
    let invalid = f
        .agent(
            0,
            Method::GET,
            "/resources",
            Some("synthetic-invalid-token"),
        )
        .send()
        .await?;
    assert_eq!(invalid.status(), 401);
    let invalid_id = invalid.headers()["x-request-id"].to_str()?;
    let denied = f
        .agent(
            0,
            Method::GET,
            "/files?resourceId=fs_shared&path=%2Fprivate-canary",
            Some(&token),
        )
        .header("x-sensitive-canary", "sensitive-canary")
        .send()
        .await?;
    assert_eq!(denied.status(), 403);
    let id = denied.headers()["x-request-id"].to_str()?;
    let (history, records) = history_rows(&f, "/request-history", id, 1).await?;
    let row = &records[0];
    assert_eq!(history["coverage"]["status"], "partial");
    assert_eq!(history["health"]["status"], "unknown");
    assert!(history["health"]["droppedCount"].is_null());
    assert_eq!(row["operation"], "files");
    assert_eq!(row["method"], "GET");
    assert_eq!(row["status"], 403);
    assert_eq!(row["actor"]["kind"], "workspaceKey");
    assert_eq!(row["actor"]["id"], key["data"]["keyId"]);
    assert!(
        !history["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["requestId"] == invalid_id)
    );
    for secret in [
        "private-canary",
        "sensitive-canary",
        &token,
        "synthetic-invalid-token",
    ] {
        assert!(!history.to_string().contains(secret));
    }
    assert_eq!(
        expect(f.owner(1, Method::GET, "/request-history"), 200).await?["data"],
        json!([])
    );
    let after = f.owner(0, Method::GET, "/request-history").send().await?;
    let own_id = after.headers()["x-request-id"].to_str()?.to_owned();
    assert!(
        !after.json::<Value>().await?["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["requestId"] == own_id)
    );
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn audit_history_distinguishes_succeeded_denied_and_unknown_without_private_content()
-> Result<()> {
    let f = Workspaces::start(false, false).await?;
    let write = put(
        &f,
        "fs_shared",
        "/audit-private-canary",
        "file",
        "audit-content-canary",
    )
    .send()
    .await?;
    assert_eq!(write.status(), 200);
    let id = write.headers()["x-request-id"].to_str()?;
    let (history, rows) = history_rows(&f, "/audit-history", id, 2).await?;
    for (row, outcome) in rows.iter().zip(["succeeded", "attempted"]) {
        assert_eq!(row["outcome"], outcome);
    }
    assert_eq!(rows[0]["action"], "file.write");
    assert_eq!(
        rows[0]["target"],
        json!({"type":"filesystem","id":"fs_shared"})
    );
    assert!(rows[1].get("target").is_none());
    assert_eq!(rows[0]["actor"]["kind"], "owner");
    assert_eq!(rows[0]["operationId"], rows[1]["operationId"]);
    assert_eq!(rows[1]["resolution"], "succeeded");
    assert_eq!(history["coverage"]["status"], "partial");
    for private in ["audit-private-canary", "audit-content-canary"] {
        assert!(!history.to_string().contains(private));
    }
    let key = f
        .create_key(
            0,
            "read-only-agent",
            &["resources:read", "files:read"],
            &["*"],
        )
        .await?;
    let token = f.exchange(0, key["secret"].as_str().unwrap()).await?;
    let denied=f.agent(0,Method::PUT,"/files",Some(&token)).json(&json!({"resourceId":"fs_shared","path":"/denied-private-canary","type":"file","content":"must-not-write"})).send().await?;
    assert_eq!(denied.status(), 403);
    let (_, rows) = history_rows(
        &f,
        "/audit-history",
        denied.headers()["x-request-id"].to_str()?,
        2,
    )
    .await?;
    assert_eq!(rows[0]["outcome"], "denied");
    assert_eq!(rows[1]["outcome"], "attempted");
    assert_eq!(rows[0]["decision"], "denied");
    assert!(rows[0].get("target").is_none());
    assert_eq!(rows[0]["actor"]["id"], key["data"]["keyId"]);
    for private in ["denied-private-canary", &token] {
        assert!(!json!(rows).to_string().contains(private));
    }
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let attempts = Arc::new(AtomicUsize::new(0));
    let counter = attempts.clone();
    f.provider.state.lock().unwrap().write_race = Some(Box::new(move |path, files| {
        counter.fetch_add(1, Ordering::SeqCst);
        files.insert(
            path.to_owned(),
            b"provider may already have applied this".to_vec(),
        );
        Some((503, json!({"error":"private-provider-error"})))
    }));
    let uncertain = put(
        &f,
        "fs_live",
        "/uncertain-private-canary",
        "file",
        "uncertain-content-canary",
    )
    .send()
    .await?;
    assert!(uncertain.status().is_server_error());
    let (_, rows) = history_rows(
        &f,
        "/audit-history",
        uncertain.headers()["x-request-id"].to_str()?,
        2,
    )
    .await?;
    assert_eq!(rows[0]["outcome"], "unknown");
    assert_eq!(rows[1]["outcome"], "attempted");
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    for private in [
        "private-provider-error",
        "uncertain-private-canary",
        "uncertain-content-canary",
    ] {
        assert!(!json!(rows).to_string().contains(private));
    }
    let other = expect(f.owner(1, Method::GET, "/audit-history"), 200).await?;
    assert!(
        !other["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["requestId"] == id)
    );
    Ok(())
}

fn create_pg(f: &Workspaces, name: &str, key: &str) -> reqwest::RequestBuilder {
    f.owner(0, Method::POST, "/resources")
        .header("Idempotency-Key", key)
        .json(&json!({"kind":"postgresql","name":name,"region":"automatic"}))
}
async fn expect_backfilled_duplicate(f: &Workspaces) -> Result<()> {
    use std::time::{Duration, Instant};
    let before = f.provider.state.lock().unwrap().calls;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let r = create_pg(f, "fixture-postgresql", "index-readiness")
            .send()
            .await?;
        let status = r.status();
        let v = r.json::<Value>().await?;
        assert_eq!(f.provider.state.lock().unwrap().calls, before);
        if status == 503 && v["error"]["code"] == "RESOURCE_INDEX_MIGRATING" {
            ensure!(Instant::now() < deadline, "index migration timed out");
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        assert_eq!(status, 409);
        assert_eq!(v["error"]["code"], "NAME_EXISTS");
        return Ok(());
    }
}

#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn concurrent_creations_share_one_idempotency_result() -> Result<()> {
    let f = Workspaces::start(false, false).await?;
    expect_backfilled_duplicate(&f).await?;
    let create = || expect(create_pg(&f, "concurrent-same", "concurrent-same"), 201);
    let (a, b) = tokio::try_join!(create(), create())?;
    assert_eq!(a["data"]["id"], b["data"]["id"]);
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn backfilled_resource_indexes_preserve_quota_names_and_idempotency() -> Result<()> {
    let f = Workspaces::start(false, false).await?;
    expect(f.owner(0, Method::GET, "/resources?limit=1"), 200).await?;
    expect_backfilled_duplicate(&f).await?;
    let (a, b) = tokio::try_join!(
        create_pg(&f, "indexed-race", "race-a").send(),
        create_pg(&f, "indexed-race", "race-b").send()
    )?;
    let (winner, key, loser) = if a.status() == 201 {
        (a, "race-a", b)
    } else {
        (b, "race-b", a)
    };
    assert_eq!(winner.status(), 201);
    assert_eq!(loser.status(), 409);
    let id = winner.json::<Value>().await?["data"]["id"].clone();
    assert_eq!(
        expect(create_pg(&f, "indexed-race", key), 201).await?["data"]["id"],
        id
    );
    assert_eq!(
        create_pg(&f, "changed-name", key)
            .send()
            .await?
            .json::<Value>()
            .await?["error"]["code"],
        "IDEMPOTENCY_CONFLICT"
    );
    expect(create_pg(&f, "indexed-two", "two"), 201).await?;
    assert_eq!(
        create_pg(&f, "indexed-limit", "limit")
            .send()
            .await?
            .json::<Value>()
            .await?["error"]["code"],
        "FREE_TIER_LIMIT"
    );
    expect(f.owner(0, Method::DELETE, "/resources/db_memory"), 202).await?;
    assert_eq!(
        expect(create_pg(&f, "fixture-postgresql", "reused"), 409).await?["error"]["code"],
        "NAME_EXISTS"
    );
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn portal_cookie_and_agent_token_only_work_at_their_documented_boundaries() -> Result<()> {
    let f = Workspaces::start(false, false).await?;
    let portal = "/api/portal/v1/workspaces/ws_agentlab/resources";
    let session = expect(f.at(0, Method::GET, portal, true), 200).await?;
    expect(
        f.at(
            0,
            Method::GET,
            "/api/v1/workspaces/ws_agentlab/resources",
            true,
        ),
        401,
    )
    .await?;
    expect(f.at(0, Method::GET, portal, false), 401).await?;
    let key = f
        .create_key(0, "agent-reader", &["resources:read"], &["*"])
        .await?;
    let token = f.exchange(0, key["secret"].as_str().unwrap()).await?;
    assert_eq!(
        expect(f.agent(0, Method::GET, "/resources", Some(&token)), 200).await?["data"],
        session["data"]
    );
    expect(f.at(0, Method::GET, portal, false).bearer_auth(&token), 401).await?;
    for (profile, token, status) in [
        ("v1", None, 401),
        ("portal/v1", Some(token.as_str()), 401),
        ("portal/v1", None, 200),
    ] {
        expect(
            f.global_profile(
                0,
                Method::GET,
                &format!("/api/{profile}/workspaces/ws_agentlab/keys"),
                token,
            ),
            status,
        )
        .await?;
    }
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn independent_global_metadata_crash_preserves_native_region_io_and_binding() -> Result<()> {
    use std::sync::{Arc, Mutex};
    use workspace_test_support::provider::{NATIVE_SECRET, SqlResponse};
    let mut f = Workspaces::start(true, false).await?;
    let table = Arc::new(Mutex::new(std::collections::HashMap::new()));
    f.provider.set_sql_hook(move |v| {
        let table = table.clone();
        async move {
            assert_eq!(v["binding"]["password"], NATIVE_SECRET);
            let kind = v["binding"]["kind"].as_str().unwrap();
            let result = match v["sql"].as_str()? {
                "INSERT INTO outage_test VALUES (7)" => {
                    table.lock().unwrap().insert(kind.to_owned(), 7);
                    json!({"columns":[],"rows":[],"rowCount":0,"affectedRows":1})
                }
                "SELECT value FROM outage_test" => {
                    let rows: Vec<_> = table
                        .lock()
                        .unwrap()
                        .get(kind)
                        .into_iter()
                        .map(|v| json!({"value":v}))
                        .collect();
                    json!({"columns":["value"],"rows":rows,"rowCount":rows.len(),"affectedRows":0})
                }
                _ => return None,
            };
            Some(SqlResponse::Json(200, result))
        }
    });
    let key = f
        .create_key(
            0,
            "local-outage-check",
            &["queries:execute", "files:read", "files:write"],
            &["db_live", "fs_live"],
        )
        .await?;
    let token = f.exchange(0, key["secret"].as_str().unwrap()).await?;
    let read = |f: &Workspaces| {
        f.agent(0, Method::POST, "/queries", Some(&token))
            .json(&json!({"resourceId":"db_live","sql":"SELECT value FROM outage_test"}))
    };
    let write = |f: &Workspaces| {
        f.agent(0, Method::POST, "/queries", Some(&token))
            .json(&json!({"resourceId":"db_live","sql":"INSERT INTO outage_test VALUES (7)"}))
    };
    let path = "/files/content?resourceId=fs_live&path=%2Foutage.bin";
    let upload = |f: &Workspaces, bytes: Vec<u8>| {
        f.agent(0, Method::PUT, path, Some(&token))
            .header("Content-Type", "application/octet-stream")
            .body(bytes)
    };
    let get = |f: &Workspaces| f.agent(0, Method::GET, path, Some(&token));
    expect(write(&f), 200).await?;
    f.crash_global_meta()?;
    assert!(!f.global_meta_running());
    assert_eq!(expect(read(&f), 200).await?["rows"], json!([{"value":7}]));
    expect(upload(&f, vec![0, 255, 42]), 200).await?;
    assert_eq!(
        get(&f)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?
            .as_ref(),
        [0, 255, 42]
    );
    f.restart(false).await?;
    assert_eq!(expect(read(&f), 200).await?["rows"], json!([{"value":7}]));
    assert_eq!(
        get(&f)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?
            .as_ref(),
        [0, 255, 42]
    );
    expect(write(&f), 200).await?;
    assert_eq!(expect(read(&f), 200).await?["rows"], json!([{"value":7}]));
    expect(upload(&f, b"after restart".to_vec()), 200).await?;
    assert_eq!(
        get(&f)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?
            .as_ref(),
        b"after restart"
    );
    assert!(!f.global_meta_running());
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn registration_rejects_missing_client_certificate_and_forged_regional_identity() -> Result<()>
{
    use rustls::{
        ClientConfig, ClientConnection, RootCertStore, StreamOwned, pki_types::ServerName,
    };
    use std::{
        fs::File,
        io::{BufReader, ErrorKind, Read, Write},
        net::TcpStream,
        sync::Arc,
        time::Duration,
    };
    let f = Workspaces::start(false, false).await?;
    let (ctrl, tls) = f.control(0);
    let mut roots = RootCertStore::empty();
    let certs = |p: &Value| -> Result<Vec<_>> {
        Ok(
            rustls_pemfile::certs(&mut BufReader::new(File::open(p.as_str().unwrap())?))
                .collect::<std::io::Result<Vec<_>>>()?,
        )
    };
    for cert in certs(&tls["caFile"])? {
        roots.add(cert)?;
    }
    let stream = |identified: bool| -> Result<StreamOwned<ClientConnection, TcpStream>> {
        let cfg =
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_protocol_versions(&[&rustls::version::TLS13])?
                .with_root_certificates(roots.clone());
        let cfg = if identified {
            let key = rustls_pemfile::private_key(&mut BufReader::new(File::open(
                tls["privateKeyFile"].as_str().unwrap(),
            )?))?
            .context("control key")?;
            cfg.with_client_auth_cert(certs(&tls["certificateFile"])?, key)?
        } else {
            cfg.with_no_client_auth()
        };
        let tcp = TcpStream::connect(ctrl["bind"].as_str().unwrap())?;
        tcp.set_read_timeout(Some(Duration::from_secs(3)))?;
        tcp.set_write_timeout(Some(Duration::from_secs(3)))?;
        Ok(StreamOwned::new(
            ClientConnection::new(Arc::new(cfg), ServerName::try_from("localhost")?)?,
            tcp,
        ))
    };
    let no_reply = |mut s: StreamOwned<ClientConnection, TcpStream>| -> Result<()> {
        let mut bytes = Vec::new();
        match s.read_to_end(&mut bytes) {
            Ok(_) => {}
            Err(e) => ensure!(
                matches!(
                    e.kind(),
                    ErrorKind::ConnectionReset
                        | ErrorKind::ConnectionAborted
                        | ErrorKind::UnexpectedEof
                        | ErrorKind::InvalidData
                ),
                "registration did not close: {e}"
            ),
        }
        ensure!(
            bytes.is_empty(),
            "untrusted registration received application bytes"
        );
        Ok(())
    };
    no_reply(stream(false)?)?;
    for (region, origin) in [
        ("region:forged", f.origin(0)),
        (workspaces::REGION, "https://untrusted.example"),
    ] {
        let mut s = stream(true)?;
        s.conn.complete_io(&mut s.sock)?;
        let frame = json!({"type":"register","region_id":region,"api_origin":origin,"api_path_prefix":"","instance_id":uuid::Uuid::new_v4().to_string()});
        writeln!(s, "{frame}")?;
        s.flush()?;
        no_reply(s)?;
    }
    let key = f
        .create_key(0, "still-connected", &["resources:read"], &["*"])
        .await?;
    let token = f.exchange(0, key["secret"].as_str().unwrap()).await?;
    expect(f.agent(0, Method::GET, "/resources", Some(&token)), 200).await?;
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn migrated_resource_placement_and_private_bindings_survive_restart() -> Result<()> {
    let mut f = Workspaces::start(false, false).await?;
    let keys = [
        "bindings/db9/db_live",
        "credentials/db9/db_live",
        "state/resources/db_retired_mysql",
        "bindings/zero/db_retired_mysql",
        "credentials/zero/db_retired_mysql",
    ];
    let before = f.records(0, &keys).await?;
    let stored = f.records(0, &["state/resources/db_live"]).await?;
    assert!(
        stored["state/resources/db_live"]["value"]["record"]
            .get("regionId")
            .is_none()
    );
    let boot = expect(f.owner(0, Method::GET, "/bootstrap"), 200).await?;
    assert_eq!(boot["workspace"]["defaultRegionId"], workspaces::REGION);
    let resources = boot["resources"].as_array().unwrap();
    let original = resources.iter().find(|v| v["id"] == "db_live").unwrap();
    assert!(!resources.iter().any(|v| v["id"] == "db_retired_mysql"));
    assert_eq!(original["regionId"], workspaces::REGION);
    assert_eq!(original["region"], "automatic");
    let detail = expect(f.owner(0, Method::GET, "/resources/fs_live"), 200).await?;
    assert_eq!(detail["data"]["regionId"], workspaces::REGION);
    assert_eq!(detail["data"]["region"], "aws-ap-southeast-1");
    let api: Value = serde_json::from_str(include_str!(
        "../../../tools/api-contract/portal-regional-openapi.json"
    ))?;
    for (path, value) in [
        ("/workspaces/{workspaceId}/bootstrap", &boot),
        ("/workspaces/{workspaceId}/resources/{resourceId}", &detail),
    ] {
        let mut schema =
            api["paths"][path]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
                .clone();
        schema["components"] = api["components"].clone();
        assert!(
            jsonschema::draft202012::options()
                .should_validate_formats(false)
                .build(&schema)?
                .is_valid(value)
        );
    }
    let key = f
        .create_key(
            0,
            "migration-reader",
            &["queries:execute", "files:read"],
            &["db_live", "fs_live"],
        )
        .await?;
    let token = f.exchange(0, key["secret"].as_str().unwrap()).await?;
    for restart in [false, true] {
        if restart {
            f.restart(false).await?;
        }
        expect(
            f.agent(0, Method::POST, "/queries", Some(&token))
                .json(&json!({"resourceId":"db_live","sql":"SELECT 1"})),
            200,
        )
        .await?;
        expect(
            f.agent(0, Method::GET, "/files?resourceId=fs_live", Some(&token)),
            200,
        )
        .await?;
    }
    let after = expect(f.owner(0, Method::GET, "/resources/db_live"), 200).await?;
    assert_eq!(after["data"]["id"], original["id"]);
    assert_eq!(after["data"]["regionId"], workspaces::REGION);
    assert_eq!(after["data"]["region"], original["region"]);
    assert_eq!(f.records(0, &keys).await?, before);
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn resource_pages_and_indexes_support_large_workspaces() -> Result<()> {
    use std::time::{Duration, Instant};
    let f = Workspaces::start(false, false).await?;
    expect(f.owner(0, Method::GET, "/resources?limit=1"), 200).await?;
    f.seed_scale("resources",4100,|n|json!({"id":format!("fs_scale_{n:08}"),"name":format!("scale-{n}"),"kind":"filesystem","region":"aws-ap-southeast-1","provider":"local","status":"active","createdAt":"2026-01-01T00:00:00Z"})).await?;
    for path in ["/api/health", "/api/portal/v1/workspaces"] {
        expect(f.at(0, Method::GET, path, true), 200).await?;
    }
    let boot = expect(f.owner(0, Method::GET, "/bootstrap"), 200).await?;
    assert!(boot["resources"].as_array().unwrap().len() <= 100);
    assert!(boot["resourceNextCursor"].is_string());
    expect(
        f.owner(0, Method::POST, "/queries")
            .json(&json!({"resourceId":"db_live","sql":"SELECT 1"})),
        200,
    )
    .await?;
    let usage = expect(f.owner(0, Method::GET, "/usage?limit=10"), 200).await?;
    assert!(usage["data"].as_array().unwrap().len() <= 10);
    assert!(usage["nextCursor"].is_string());
    expect(put(&f, "fs_shared", "/local-scale.txt", "file", "ok"), 200).await?;
    tokio::try_join!(
        expect(f.owner(0, Method::GET, "/resources/db_live"), 200),
        expect(f.owner(0, Method::GET, "/resources/db_pg"), 200)
    )?;
    expect(
        put(&f, "fs_live", "/large-workspace.txt", "file", "ok"),
        200,
    )
    .await?;
    let events = f
        .guarded("list", json!({"prefix":"state/events/","limit":512}))
        .await?;
    assert!(
        events["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| &v["value"]["record"])
            .any(|e| e["action"] == "file.saved" && e["resource"] == "/large-workspace.txt")
    );
    let key = f
        .create_key(0, "scale-key", &["resources:read"], &["fs_scale_00000000"])
        .await?;
    let token = f.exchange(0, key["secret"].as_str().unwrap()).await?;
    let allowed = expect(
        f.agent(0, Method::GET, "/resources?limit=1", Some(&token)),
        200,
    )
    .await?;
    assert_eq!(allowed["data"].as_array().unwrap().len(), 1);
    assert_eq!(allowed["data"][0]["id"], "fs_scale_00000000");
    expect(f.owner(0, Method::GET, "/keys"), 404).await?;
    expect(f.owner(0, Method::GET, "/events"), 200).await?;
    expect(
        f.owner(0, Method::PATCH, "/settings")
            .json(&json!({"workspaceName":"Scale workspace","name":"Developer"})),
        200,
    )
    .await?;
    f.revoke(0, &key["data"]).await?;
    expect(
        f.agent(0, Method::GET, "/resources?limit=1", Some(&token)),
        401,
    )
    .await?;
    let mut cursor = None::<String>;
    let mut count = 0;
    loop {
        let mut req = f.owner(0, Method::GET, "/resources?limit=512");
        if let Some(c) = &cursor {
            req = req.query(&[("cursor", c)]);
        }
        let page = expect(req, 200).await?;
        let rows = page["data"].as_array().unwrap();
        assert!(rows.len() <= 512);
        count += rows
            .iter()
            .filter(|e| e["id"].as_str().unwrap().starts_with("fs_scale_"))
            .count();
        cursor = page["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(count, 4100);
    let create = || create_pg(&f, "large-backfill", "large-backfill");
    assert_eq!(
        expect(create(), 503).await?["error"]["code"],
        "RESOURCE_INDEX_MIGRATING"
    );
    expect(f.owner(0, Method::GET, "/resources?limit=1"), 200).await?;
    let end = Instant::now() + Duration::from_secs(120);
    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let r = create().send().await?;
        let status = r.status();
        let body = r.json::<Value>().await?;
        if body["error"]["code"] != "RESOURCE_INDEX_MIGRATING" {
            assert_eq!(status, 201);
            break;
        }
        ensure!(Instant::now() < end, "resource index did not finish");
    }
    assert_eq!(
        create_pg(&f, "scale-1", "large-duplicate")
            .send()
            .await?
            .json::<Value>()
            .await?["error"]["code"],
        "NAME_EXISTS"
    );
    for method in [Method::DELETE, Method::GET] {
        assert_eq!(
            expect(f.owner(0, method, "/resources/fs_scale_00000000"), 200).await?["data"]["status"],
            "deleted"
        );
    }
    let page = expect(f.owner(0, Method::GET, "/resources"), 200).await?;
    assert!(page["data"].as_array().unwrap().len() <= 100);
    assert!(page["nextCursor"].is_string());
    Ok(())
}
