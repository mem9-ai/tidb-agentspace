use super::*;
use std::time::{Duration, Instant};
pub fn commit(review: &Value, table: &str, id: &str) -> Value {
    json!({"resourceId":id,"preparationId":review["id"],"confirmed":true,"table":table,"fields":review["fields"]})
}
pub async fn upload(
    f: &Workspaces,
    id: &str,
    token: &str,
    text: &str,
    status: u16,
    code: &str,
) -> Result<Value> {
    check(agent(f,Method::POST,&format!("/database-import-preparations?resourceId={id}&filename=source.csv&format=csv&header=true&delimiter=%2C"),token)
        .header("Content-Type","application/octet-stream").body(text.to_owned()),status,code).await
}

pub async fn verify(f: &Workspaces, token: &str) -> Result<()> {
    let review = upload(f, "db_live", token, SOURCE, 201, "").await?;
    assert_eq!(
        review["rows"],
        json!([{"id":"001","value":"9007199254740993"}])
    );
    let (_, other) = key(f, 0, "coverage-second-actor", SCOPES, RESOURCES).await?;
    let (_, other_ws) = key(f, 1, "coverage-other-workspace", SCOPES, RESOURCES).await?;
    let route = "/database-imports";
    let body = commit(&review, "coverage_import", "db_live");
    let before = calls(f);
    for (i, actor) in [(0, &other), (1, &other_ws)] {
        check(
            f.agent(i, Method::POST, route, Some(actor)).json(&body),
            409,
            "IMPORT_PREPARATION_UNAVAILABLE",
        )
        .await?;
    }
    let send = |b: &Value| agent(f, Method::POST, route, token).json(b);
    let mut wrong = body.clone();
    wrong["resourceId"] = json!("db_pg");
    check(send(&wrong), 409, "IMPORT_TARGET_MISMATCH").await?;
    let mut unconfirmed = body.clone();
    unconfirmed["confirmed"] = json!(false);
    check(send(&unconfirmed), 400, "INVALID_IMPORT").await?;
    let mut duplicate = body.clone();
    for field in duplicate["fields"].as_array_mut().unwrap() {
        field["name"] = json!("duplicate");
    }
    check(send(&duplicate), 400, "INVALID_IMPORT_FIELDS").await?;
    assert_eq!(calls(f), before);
    let sql = statements(f).len();
    let (first, second) = tokio::try_join!(send(&body).send(), send(&body).send())?;
    let mut outcomes = vec![first, second];
    outcomes.sort_by_key(|r| r.status().as_u16());
    assert_eq!(outcomes[0].status(), 200);
    assert_eq!(outcomes[1].status(), 409);
    assert_eq!(
        outcomes.pop().unwrap().json::<Value>().await?["error"]["code"],
        "IMPORT_ALREADY_COMMITTED"
    );
    assert_eq!(statements(f).len() - sql, 2);
    for fs in ["fs_shared", "fs_live"] {
        let put = |content: &str| {
            agent(f, Method::PUT, "/files", token).json(
                &json!({"resourceId":fs,"path":"/mutable.csv","type":"file","content":content}),
            )
        };
        check(put("n\n1\n"), 200, "").await?;
        let from_file=check(agent(f,Method::POST,"/database-import-preparations",token)
            .json(&json!({"resourceId":"db_live","source":{"resourceId":fs,"path":"/mutable.csv"},"parsing":{"format":"csv","header":true,"delimiter":","}})),201,"").await?;
        check(put("n\n2\n"), 200, "").await?;
        let sql = statements(f).len();
        check(
            send(&commit(&from_file, "changed_source", "db_live")),
            409,
            "FILE_CHANGED",
        )
        .await?;
        assert_eq!(statements(f).len(), sql);
    }
    let before = calls(f);
    upload(
        f,
        "db_live",
        token,
        &format!("n\n{}", "1\n".repeat(1001)),
        413,
        "IMPORT_ROW_LIMIT",
    )
    .await?;
    assert_eq!(calls(f), before);
    for id in ["db_live", "db_pg"] {
        let review = upload(
            f,
            id,
            token,
            "text,precise,flag\n\"Robert'); DROP TABLE victims;--\",9007199254740993,true\n",
            201,
            "",
        )
        .await?;
        let mut body = commit(&review, "quoted\"`table", id);
        for field in body["fields"].as_array_mut().unwrap() {
            if field["source"] == "text" {
                field["name"] = json!("quoted\"`field");
            }
        }
        let before = statements(f).len();
        check(send(&body), 200, "").await?;
        let sql = statements(f);
        assert_eq!(sql.len() - before, 2);
        assert!(sql[before].starts_with("CREATE TABLE \"quoted\"\"`table\" ("));
        assert!(sql[before + 1].contains("9007199254740993") && sql[before + 1].contains("TRUE"));
        assert!(
            !sql[before..]
                .iter()
                .any(|s| s.contains("DROP TABLE victims"))
        );
        assert!(sql[before + 1].contains(&hex::encode("Robert'); DROP TABLE victims;--")));
    }
    let prepared = upload(f, "db_live", token, SOURCE, 201, "").await?;
    let partial = commit(&prepared, "partial_import", "db_live");
    f.provider.set_sql_hook(|v| async move {
        v["sql"]
            .as_str()?
            .starts_with("INSERT INTO")
            .then_some(SqlResponse::Disconnect)
    });
    let before = statements(f).len();
    check(send(&partial), 502, "EXPORT_INCOMPLETE").await?;
    assert_eq!(statements(f).len(), before + 2);
    check(send(&partial), 409, "IMPORT_ALREADY_COMMITTED").await?;
    assert_eq!(statements(f).len(), before + 2);
    let conflict = upload(f, "db_live", token, SOURCE, 201, "").await?;
    f.provider.set_sql_hook(|v| async move {
        v["sql"]
            .as_str()?
            .starts_with("CREATE TABLE")
            .then_some(SqlResponse::Json(
                409,
                json!({"error":{"code":"SQL_TABLE_EXISTS"}}),
            ))
    });
    check(
        send(&commit(&conflict, "occupied", "db_live")),
        409,
        "SQL_TABLE_EXISTS",
    )
    .await?;
    f.provider.set_sql_hook(|_| async { None });
    check(send(&commit(&conflict, "fresh_name", "db_live")), 200, "").await?;
    let (revoked, stale) = key(f, 0, "coverage-revoked-mid-import", SCOPES, RESOURCES).await?;
    let prep = upload(f, "db_live", &stale, SOURCE, 201, "").await?;
    let id = revoked["data"]["keyId"].as_str().unwrap();
    let version = revoked["data"]["keyVersion"].as_u64().unwrap();
    let revoke = f
        .global(0, Method::DELETE, &format!("/keys/{id}"), None)
        .header("Idempotency-Key", Uuid::new_v4().to_string())
        .header("If-Match", format!("\"{version}\""));
    f.provider.set_sql_hook(move |input| {
        let request = revoke.try_clone().unwrap();
        async move {
            if input["sql"].as_str()?.starts_with("CREATE TABLE") {
                let r = check(request, 202, "").await.unwrap();
                assert_eq!(r["regionalStatus"], "pending");
            }
            None
        }
    });
    let before = statements(f).len();
    check(
        agent(f, Method::POST, route, &stale).json(&commit(&prep, "revoked_import", "db_live")),
        200,
        "",
    )
    .await?;
    assert_eq!(statements(f).len(), before + 2);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let delivered = check(
            f.global(0, Method::POST, "/key-policy-deliveries", None)
                .header("Idempotency-Key", Uuid::new_v4().to_string())
                .json(&json!({"keyId":id,"keyVersion":version+1})),
            201,
            "",
        )
        .await?;
        if delivered["data"]["regionalStatus"] == "applied" {
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "Regional revocation did not converge"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    check(
        agent(f, Method::POST, "/queries", &stale)
            .json(&json!({"resourceId":"db_live","sql":"SELECT 1"})),
        401,
        "INVALID_CREDENTIAL",
    )
    .await?;
    Ok(())
}
