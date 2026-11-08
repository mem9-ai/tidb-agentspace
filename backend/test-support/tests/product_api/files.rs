use super::*;
pub async fn verify(f: &Workspaces, token: &str) -> Result<()> {
    let put = |body: Value| agent(f, Method::PUT, "/files", token).json(&body);
    check(
        put(json!({"resourceId":"fs_shared","path":"/notes","type":"directory"})),
        200,
        "",
    )
    .await?;
    let text = "first\n😀\0end";
    let stored=check(put(json!({"resourceId":"fs_shared","path":"/notes//测试.txt","type":"file","content":text})),200,"").await?;
    assert_eq!(stored["data"]["path"], "/notes/测试.txt");
    assert_eq!(stored["data"]["size"], text.len());
    check(put(json!({"resourceId":"fs_shared","path":"/notes/测试.txt","type":"file","content":"updated\r\n😀"})),200,"").await?;
    let listing = "/files?resourceId=fs_shared&path=/notes";
    assert_eq!(
        check(agent(f, Method::GET, listing, token), 200, "").await?["data"][0]["content"],
        "updated\r\n😀"
    );
    check(
        agent(
            f,
            Method::DELETE,
            "/files/entry?resourceId=fs_shared&path=/notes",
            token,
        ),
        409,
        "DIRECTORY_NOT_EMPTY",
    )
    .await?;
    check(
        put(json!({"resourceId":"fs_shared","path":"/notes/测试.txt","type":"directory"})),
        409,
        "TYPE_CONFLICT",
    )
    .await?;
    check(put(json!({"resourceId":"fs_shared","path":"/missing/file.txt","type":"file","content":"x"})),404,"PARENT_MISSING").await?;
    let before = calls(f);
    for path in ["relative", "/a/../b", "/a/./b", "/a\\b", "/nul\0file"] {
        check(
            put(json!({"resourceId":"fs_live","path":path,"type":"file","content":"x"})),
            400,
            "INVALID_PATH",
        )
        .await?;
    }
    assert_eq!(calls(f), before);
    let entry = "/files/entry?resourceId=fs_shared&path=/notes/测试.txt";
    check(agent(f, Method::DELETE, entry, token), 200, "").await?;
    check(agent(f, Method::DELETE, entry, token), 404, "NOT_FOUND").await?;
    assert_eq!(
        check(agent(f, Method::GET, listing, token), 200, "").await?["data"],
        json!([])
    );
    let bytes = vec![0, 255, 13, 10, 128, 34];
    let path = "/files/content?resourceId=fs_live&path=/二进制.bin";
    let upload =
        || agent(f, Method::PUT, path, token).header("Content-Type", "application/octet-stream");
    let sent = check(
        upload().header("If-None-Match", "*").body(bytes.clone()),
        200,
        "",
    )
    .await?;
    assert_eq!(sent["size"], bytes.len());
    check(
        upload().header("If-None-Match", "*").body("replacement"),
        412,
        "PRECONDITION_FAILED",
    )
    .await?;
    let download = agent(f, Method::GET, path, token)
        .send()
        .await?
        .error_for_status()?;
    assert_eq!(
        download.headers()["content-type"],
        "application/octet-stream"
    );
    assert_eq!(
        download.headers()["content-length"],
        bytes.len().to_string()
    );
    assert_eq!(
        download.headers()["content-disposition"],
        "attachment; filename*=UTF-8''%E4%BA%8C%E8%BF%9B%E5%88%B6%2Ebin"
    );
    assert_eq!(download.bytes().await?, bytes);
    check(upload().body("updated"), 200, "").await?;
    assert_eq!(
        agent(f, Method::GET, path, token)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?,
        "updated"
    );
    check(
        agent(
            f,
            Method::DELETE,
            "/files/entry?resourceId=fs_live&path=/二进制.bin",
            token,
        ),
        200,
        "",
    )
    .await?;
    check(agent(f, Method::GET, path, token), 404, "NOT_FOUND").await?;
    Ok(())
}

pub async fn exports(f: &Workspaces, token: &str) -> Result<()> {
    let result = json!({"columns":["z","a","blank"],"rows":[{"z":"9007199254740993","a":"\"quoted\"\nline","blank":null},{"z":"=SUM(A1)","a":"😀","blank":""}]});
    let csv = "\"z\",\"a\",\"blank\"\r\n\"9007199254740993\",\"\"\"quoted\"\"\nline\",\r\n\"'=SUM(A1)\",\"😀\",\"\"\r\n";
    let first = r#"{"z":"9007199254740993","a":"\"quoted\"\nline","blank":null}"#;
    let second = r#"{"z":"=SUM(A1)","a":"😀","blank":""}"#;
    for (format, expected) in [
        ("csv", csv.into()),
        ("json", format!("[{first},\n{second}]\n")),
        ("jsonl", format!("{first}\n{second}\n")),
    ] {
        let r=check(agent(f,Method::POST,"/result-exports",token).json(&json!({"sourceResourceId":"db_live","result":result,"target":{"kind":"download","format":format}})),200,"").await?;
        assert_eq!(r["content"], expected);
        assert_eq!(r["bytes"], expected.len());
    }
    let numeric=check(agent(f,Method::POST,"/result-exports",token).header("Content-Type","application/json").body(r#"{"sourceResourceId":"db_live","result":{"columns":["n"],"rows":[{"n":9007199254740993}]},"target":{"kind":"download","format":"csv"}}"#),200,"").await?;
    assert_eq!(numeric["content"], "\"n\"\r\n\"9007199254740993\"\r\n");
    let mut target = json!({"kind":"filesystem","resourceId":"fs_live","path":"/coverage-export.csv","format":"csv"});
    check(
        agent(f, Method::POST, "/result-exports", token)
            .json(&json!({"sourceResourceId":"db_live","result":result,"target":target})),
        200,
        "",
    )
    .await?;
    check(agent(f,Method::POST,"/result-exports",token).json(&json!({"sourceResourceId":"db_live","result":{"columns":["n"],"rows":[{"n":2}]},"target":target})),409,"EXPORT_TARGET_EXISTS").await?;
    assert_eq!(
        agent(
            f,
            Method::GET,
            "/files/content?resourceId=fs_live&path=/coverage-export.csv",
            token
        )
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?,
        csv
    );
    let (_, readonly) = key(
        f,
        0,
        "coverage-export-readonly",
        &["queries:execute", "files:read"],
        RESOURCES,
    )
    .await?;
    let before = calls(f);
    target["path"] = json!("/denied-export.csv");
    check(
        agent(f, Method::POST, "/result-exports", &readonly)
            .json(&json!({"sourceResourceId":"db_live","result":result,"target":target})),
        403,
        "INSUFFICIENT_SCOPE",
    )
    .await?;
    assert_eq!(calls(f), before);
    Ok(())
}
