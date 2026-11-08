use super::api::Api;
use anyhow::Result;
use reqwest::Method;
use serde_json::{Value, json};

pub async fn verify(api: &Api<'_>, token: &str) -> Result<()> {
    let copy = json!({"source":{"kind":"original","resourceId":"fs_shared","path":"/orders.csv"},"target":{"kind":"filesystem","resourceId":"fs_shared","path":"/copied.csv"}});
    api.post("/file-exports", &copy, 200).await?;
    api.post("/file-exports", &copy, 409).await?;
    let input = json!([{"value":"=SUM(A1)","n":1},{"value":"quote\"\nline","n":null},{"value":"\u{feff}=1","n":3}]);
    for format in ["csv", "json", "jsonl"] {
        let r=api.post("/result-exports",&json!({"sourceResourceId":"db_live","result":{"columns":["value","n"],"rows":input},"target":{"kind":"download","format":format}}),200).await?;
        assert_eq!(r["format"], format);
        assert_eq!(r["rowCount"], 3);
        let content = r["content"].as_str().unwrap();
        assert_eq!(r["bytes"], content.len());
        assert!(
            r["filename"]
                .as_str()
                .unwrap()
                .ends_with(&format!(".{format}"))
        );
        match format {
            "json" => assert_eq!(serde_json::from_str::<Value>(content)?, input),
            "jsonl" => assert_eq!(
                content
                    .lines()
                    .map(serde_json::from_str)
                    .collect::<Result<Vec<Value>, _>>()?,
                *input.as_array().unwrap()
            ),
            _ => assert!(content.contains("'=SUM")),
        }
    }
    for target in [
        json!({"kind":"filesystem","resourceId":"fs_live","path":"/result.csv","format":"csv"}),
        json!({"kind":"database","resourceId":"db_live","table":"export_probe"}),
    ] {
        api.post("/result-exports",&json!({"sourceResourceId":"db_live","result":{"columns":["name","n"],"rows":[{"name":"O'Reilly","n":42}]},"target":target}),200).await?;
    }
    let parsing = json!({"format":"csv","header":true,"delimiter":","});
    let prep=api.post("/file-export-preparations",&json!({"source":{"kind":"original","resourceId":"fs_shared","path":"/orders.csv"},"parsing":parsing}),201).await?;
    assert_eq!(prep["rowCount"], 2);
    assert_eq!(
        prep["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["TEXT", "BIGINT"]
    );
    let exported = |input: &Value, db: &str, table: &str| json!({"preparationId":input["id"],"confirmed":true,"fields":input["fields"],"target":{"kind":"database","resourceId":db,"table":table}});
    api.post("/file-exports", &exported(&prep, "db_pg", ""), 400)
        .await?;
    for status in [200, 409] {
        api.post(
            "/file-exports",
            &exported(&prep, "db_pg", "import_probe"),
            status,
        )
        .await?;
    }
    let import = api
        .token("local-import-only", &["queries:execute"], &["db_live"])
        .await?;
    let raw = "/database-import-preparations?resourceId=db_live&filename=local.csv&format=csv&header=true&delimiter=%2C";
    let upload = |path: &str, blob: Vec<u8>| {
        api.f
            .agent(0, Method::POST, path, Some(&import))
            .header("Content-Type", "application/octet-stream")
            .body(blob)
    };
    let review = api
        .json(
            Method::POST,
            upload(raw, b"id,value\n001,9007199254740993\n".to_vec()),
            201,
        )
        .await?;
    assert_eq!(
        review["rows"][0],
        json!({"id":"001","value":"9007199254740993"})
    );
    let imported = |input: &Value, db: &str, table: &str| json!({"resourceId":db,"preparationId":input["id"],"confirmed":true,"table":table,"fields":input["fields"]});
    let commit = imported(&review, "db_live", "direct_import");
    api.post("/database-imports", &commit, 409).await?;
    api.agent(
        Method::POST,
        "/database-imports",
        &import,
        Some(&imported(&review, "db_pg", "direct_import")),
        409,
    )
    .await?;
    api.agent(
        Method::POST,
        "/file-exports",
        &import,
        Some(&exported(&review, "db_pg", "bypass_import")),
        409,
    )
    .await?;
    let before = api.f.provider.state.lock().unwrap().calls;
    api.agent(Method::POST,"/database-import-preparations",&import,Some(&json!({"resourceId":"db_live","source":{"resourceId":"fs_live","path":"/live.csv"},"parsing":parsing})),403).await?;
    assert_eq!(api.f.provider.state.lock().unwrap().calls, before);
    for status in [200, 409] {
        api.agent(
            Method::POST,
            "/database-imports",
            &import,
            Some(&commit),
            status,
        )
        .await?;
    }
    api.json(Method::POST, upload(raw, vec![0; 1024 * 1024 + 1]), 413)
        .await?;
    let parquet=api.json(Method::POST,upload("/database-import-preparations?resourceId=db_live&filename=sample.parquet&format=parquet",include_bytes!("../cases/import.parquet").to_vec()),201).await?;
    assert_eq!(parquet["rowCount"], 25);
    assert_eq!(parquet["rows"].as_array().unwrap().len(), 20);
    assert_eq!(parquet["fields"][0]["type"], "BIGINT");
    api.agent(
        Method::POST,
        "/database-imports",
        &import,
        Some(&imported(&parquet, "db_live", "parquet_import")),
        200,
    )
    .await?;
    let file_import=api.post("/database-import-preparations",&json!({"resourceId":"db_pg","source":{"resourceId":"fs_shared","path":"/orders.csv"},"parsing":parsing}),201).await?;
    api.post(
        "/file-exports",
        &exported(&file_import, "db_live", "file_bypass"),
        409,
    )
    .await?;
    api.post(
        "/database-imports",
        &imported(&file_import, "db_pg", "file_import"),
        200,
    )
    .await?;
    api.post(
        "/database-imports",
        &imported(&prep, "db_pg", "legacy_ticket"),
        409,
    )
    .await?;
    api.post("/file-exports",&json!({"source":{"kind":"original","resourceId":"fs_live","path":"/binary.bin"},"target":{"kind":"filesystem","resourceId":"fs_live","path":"/binary-copy.bin"}}),200).await?;
    assert_eq!(
        api.f
            .owner(
                0,
                Method::GET,
                "/files/content?resourceId=fs_live&path=/binary-copy.bin"
            )
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?,
        &[0, 255, 13, 10][..]
    );
    let before = api.f.provider.state.lock().unwrap().calls;
    api.agent(
        Method::GET,
        "/files?resourceId=fs_live",
        "invalid",
        None,
        401,
    )
    .await?;
    api.json(
        Method::GET,
        api.f
            .at(0, Method::GET, "/api/v1/workspaces/other/resources", false)
            .bearer_auth(token),
        404,
    )
    .await?;
    assert_eq!(api.f.provider.state.lock().unwrap().calls, before);
    let readonly = api
        .token("read-only", &["files:read"], &["fs_shared"])
        .await?;
    api.agent(Method::POST,"/file-analyses",&readonly,Some(&json!({"resourceId":"fs_shared","path":"/orders.csv","engine":"bash","command":"cat \"$FILE\""})),403).await?;
    api.owner(
        Method::DELETE,
        "/files/entry?resourceId=fs_shared&path=/copied.csv",
        None,
        200,
    )
    .await?;
    api.get("/usage").await?;
    Ok(())
}
