use anyhow::{Context, Result};
use reqwest::{Method, RequestBuilder};
use serde_json::{Value, json};
use workspace_test_support::workspaces::{Workspaces, expect};

#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn progress_with_remote_metadata() -> Result<()> {
    progress(false).await
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn progress_with_embedded_metadata() -> Result<()> {
    progress(true).await
}

async fn code(req: RequestBuilder, status: u16, error: &str) -> Result<()> {
    assert_eq!(expect(req, status).await?["error"]["code"], error);
    Ok(())
}
async fn progress(embedded: bool) -> Result<()> {
    let mut f = Workspaces::start(embedded, false).await?;
    let input = json!({"sampleId":"a".repeat(32),"state":"attempted"});
    let path = "/tutorials/db_memory";
    let counters = |f: &Workspaces| {
        let s = f.provider.state.lock().unwrap();
        (s.calls, s.statements.len(), s.creates)
    };
    let before = counters(&f);
    assert_eq!(
        expect(f.owner(0, Method::GET, "/tutorials"), 200).await?,
        json!({"data":[],"nextCursor":null})
    );
    expect(f.owner(0, Method::GET, path), 404).await?;
    expect(f.agent(0, Method::GET, "/tutorials", None), 401).await?;
    expect(
        f.agent(0, Method::PUT, path, None)
            .json(&input)
            .header("If-None-Match", "*"),
        401,
    )
    .await?;
    code(
        f.owner(0, Method::PUT, path).json(&input),
        428,
        "PRECONDITION_REQUIRED",
    )
    .await?;
    let weak = format!("W/\"tutorial-{}\"", "a".repeat(32));
    let tag = format!("\"tutorial-{}\"", "a".repeat(32));
    for headers in [
        vec![("If-Match", "*")],
        vec![("If-Match", &weak)],
        vec![("If-None-Match", "other")],
        vec![("If-None-Match", "*"), ("If-Match", &tag)],
    ] {
        let mut req = f.owner(0, Method::PUT, path).json(&input);
        for (k, v) in headers {
            req = req.header(k, v);
        }
        code(req, 400, "INVALID_PRECONDITION").await?;
    }
    let create = |i, route: &str, body: &Value| {
        f.owner(i, Method::PUT, route)
            .header("If-None-Match", "*")
            .json(body)
    };
    for bad in [
        json!({"sampleId":"../other","state":"attempted"}),
        json!({"sampleId":input["sampleId"],"state":"unknown"}),
        json!({"sampleId":input["sampleId"],"state":"attempted","workspaceId":"ws_other"}),
        json!({"sampleId":input["sampleId"]}),
    ] {
        code(create(0, path, &bad), 400, "INVALID_TUTORIAL").await?;
    }
    code(create(0, path, &Value::Null), 400, "INVALID_BODY").await?;
    expect(create(0, "/tutorials/hidden-storage", &input), 404).await?;
    for suffix in ["limit=0", "limit=101", "cursor=../other", "unknown=true"] {
        expect(
            f.owner(0, Method::GET, &format!("/tutorials?{suffix}")),
            400,
        )
        .await?;
    }
    let first = create(0, path, &input).send().await?;
    assert_eq!(first.status(), 201);
    let tag = first.headers()["etag"].to_str()?.to_owned();
    let location = first.url().join(first.headers()["location"].to_str()?)?;
    assert_eq!(
        location.path(),
        "/api/portal/v1/workspaces/ws_agentlab/tutorials/db_memory"
    );
    let record = first.json::<Value>().await?["data"].clone();
    assert_eq!(record["version"], tag);
    let nonce = tag
        .strip_prefix("\"tutorial-")
        .and_then(|s| s.strip_suffix('"'))
        .context("quoted tutorial ETag")?;
    assert!(
        nonce.len() == 32
            && nonce
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    assert_eq!(record["resourceId"], "db_memory");
    assert_eq!(record["sampleId"], input["sampleId"]);
    assert_eq!(record["state"], "attempted");
    chrono::DateTime::parse_from_rfc3339(record["updatedAt"].as_str().unwrap())?;
    code(create(0, path, &input), 412, "PRECONDITION_FAILED").await?;
    let update = |etag: &str, state: &str| {
        f.owner(0, Method::PUT, path)
            .header("If-Match", etag)
            .json(&json!({"sampleId":input["sampleId"],"state":state}))
    };
    let ready = expect(update(&tag, "ready"), 200).await?;
    let ready_tag = ready["data"]["version"].as_str().unwrap();
    assert_ne!(ready_tag, tag);
    expect(update(&tag, "attempted"), 412).await?;
    let (first, second) = tokio::try_join!(
        update(ready_tag, "completed").send(),
        update(ready_tag, "pending").send()
    )?;
    let mut statuses = [first.status().as_u16(), second.status().as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 412]);
    let winner = if first.status() == 200 { first } else { second }
        .json::<Value>()
        .await?["data"]
        .clone();
    assert_eq!(
        expect(f.owner(0, Method::GET, path), 200).await?["data"],
        winner
    );
    expect(
        create(
            0,
            "/tutorials/fs_shared",
            &json!({"sampleId":"b".repeat(32),"state":"completed"}),
        ),
        201,
    )
    .await?;
    let page = expect(f.owner(0, Method::GET, "/tutorials?limit=1"), 200).await?;
    assert_eq!(page["data"].as_array().unwrap().len(), 1);
    assert_eq!(page["data"][0]["resourceId"], "db_memory");
    assert_eq!(page["nextCursor"], "db_memory");
    let last = expect(
        f.owner(0, Method::GET, "/tutorials").query(&[
            ("limit", "1"),
            ("cursor", page["nextCursor"].as_str().unwrap()),
        ]),
        200,
    )
    .await?;
    assert_eq!(last["data"].as_array().unwrap().len(), 1);
    assert_eq!(last["data"][0]["resourceId"], "fs_shared");
    assert!(last["nextCursor"].is_null());
    expect(f.owner(1, Method::GET, path), 404).await?;
    expect(
        f.at(
            0,
            Method::GET,
            "/api/portal/v1/workspaces/ws_other/tutorials",
            true,
        ),
        404,
    )
    .await?;
    expect(
        create(1, path, &json!({"sampleId":"c".repeat(32),"state":"ready"})),
        201,
    )
    .await?;
    assert_eq!(
        expect(f.owner(1, Method::GET, "/tutorials"), 200).await?["data"][0]["sampleId"],
        "c".repeat(32)
    );
    let key = f
        .create_key(
            0,
            "tutorial-denial",
            &["resources:read", "queries:execute"],
            &["*"],
        )
        .await?;
    let token = f.exchange(0, key["secret"].as_str().unwrap()).await?;
    for p in ["/tutorials", path] {
        code(
            f.agent(0, Method::GET, p, Some(&token)),
            403,
            "OWNER_REQUIRED",
        )
        .await?;
    }
    code(
        f.agent(0, Method::PUT, path, Some(&token))
            .json(&input)
            .header("If-None-Match", "*"),
        403,
        "OWNER_REQUIRED",
    )
    .await?;
    f.revoke(0, &key["data"]).await?;
    for t in [
        &token,
        "expired-coverage-key",
        "revoked-coverage-key",
        "invalid",
    ] {
        expect(f.agent(0, Method::GET, "/tutorials", Some(t)), 401).await?;
        expect(
            f.agent(0, Method::PUT, path, Some(t))
                .json(&input)
                .header("If-None-Match", "*"),
            401,
        )
        .await?;
    }
    let retained = expect(f.owner(0, Method::GET, "/tutorials"), 200).await?;
    let record_key = "tutorials/progress/db_memory";
    assert_eq!(
        f.records(0, &[record_key]).await?[record_key]["value"],
        winner
    );
    f.restart(true).await?;
    assert_eq!(
        expect(f.owner(0, Method::GET, "/tutorials"), 200).await?,
        retained
    );
    assert_eq!(
        expect(f.owner(0, Method::GET, path), 200).await?["data"],
        winner
    );
    assert_eq!(
        expect(f.owner(1, Method::GET, "/tutorials"), 200).await?["data"][0]["sampleId"],
        "c".repeat(32)
    );
    assert_eq!(counters(&f), before);
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn portal_sample_imports_and_analyzes_the_same_orders_after_crash() -> Result<()> {
    let sample: Value = serde_json::from_str(include_str!("cases/tutorial-orders.json"))?;
    let csv = sample["csv"].as_str().unwrap();
    let path = sample["path"].as_str().unwrap();
    let table = sample["table"].as_str().unwrap();
    let mut f = Workspaces::start(true, false).await?;
    let prep = expect(
        f.owner(0, Method::POST, "/database-import-preparations")
            .query(&[
                ("resourceId", "db_live"),
                ("filename", "tutorial.csv"),
                ("format", "csv"),
                ("header", "true"),
                ("delimiter", ","),
            ])
            .header("Content-Type", "application/octet-stream")
            .body(csv.to_owned()),
        201,
    )
    .await?;
    assert_eq!(
        prep["rowCount"].as_u64().unwrap() as usize,
        sample["rows"].as_array().unwrap().len()
    );
    let numeric = |v: &Value| {
        v.as_i64()
            .unwrap_or_else(|| v.as_str().unwrap().parse().unwrap())
    };
    let rows: Vec<_> = prep["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(
            |r| json!({"id":numeric(&r["id"]),"region":r["region"],"amount":numeric(&r["amount"])}),
        )
        .collect();
    assert_eq!(json!(rows), sample["rows"]);
    let before = f.provider.state.lock().unwrap().statements.len();
    let commit = || {
        f.owner(0,Method::POST,"/database-imports").json(&json!({"resourceId":"db_live","preparationId":prep["id"],"confirmed":true,"table":table,"fields":prep["fields"]}))
    };
    expect(commit(), 200).await?;
    {
        let s = f.provider.state.lock().unwrap();
        let new = &s.statements[before..];
        assert_eq!(new.len(), 2);
        assert!(new.iter().all(|sql| sql.contains(table)));
    }
    expect(commit(), 409).await?;
    assert_eq!(
        f.provider.state.lock().unwrap().statements.len(),
        before + 2
    );
    expect(
        f.owner(0, Method::PUT, "/files")
            .json(&json!({"resourceId":"fs_shared","path":path,"type":"file","content":csv})),
        200,
    )
    .await?;
    let analysis =
        json!({"resourceId":"fs_shared","path":path,"engine":"duckdb","sql":sample["query"]});
    for restarted in [false, true] {
        if restarted {
            let key = f
                .create_key(0, "tutorial-read-only", &["files:read"], &["fs_shared"])
                .await?;
            let token = f.exchange(0, key["secret"].as_str().unwrap()).await?;
            expect(
                f.agent(0, Method::POST, "/file-analyses", Some(&token))
                    .json(&analysis),
                403,
            )
            .await?;
            f.restart(true).await?;
        }
        let r = expect(
            f.owner(0, Method::POST, "/file-analyses").json(&analysis),
            200,
        )
        .await?;
        assert_eq!(r["readOnly"], true);
        let rows: Vec<_> = r["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| json!({"region":v["region"],"total":numeric(&v["total"])}))
            .collect();
        assert_eq!(json!(rows), sample["totals"]);
    }
    let files = expect(
        f.owner(0, Method::GET, "/files?resourceId=fs_shared&path=%2F"),
        200,
    )
    .await?;
    assert_eq!(
        files["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["path"] == path)
            .unwrap()["content"],
        csv
    );
    Ok(())
}
