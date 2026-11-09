use anyhow::{Context, Result, ensure};
use reqwest::Method;
use serde_json::{Value, json};
use std::{fs, process::Command};
use uuid::Uuid;
use workspace_test_support::{Fixture, Meta, binary, http_client, port, private_json};

#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn repeated_meta_close_confirms_the_durable_owner_release() -> Result<()> {
    use workspace_meta_service::{config::Config, engine::Engine, local_s3::LocalS3};
    let fixture = Fixture::start().await?;
    let mut meta = fixture.meta("release").await?;
    meta.process.stop_cleanly().await?;
    let cfg: Config = serde_json::from_value(meta.server.clone())?;
    let s3 = LocalS3::new(
        &cfg.s3.endpoint,
        &cfg.s3.region,
        cfg.s3.access_key_id.as_deref().unwrap(),
        cfg.s3.secret_access_key.as_deref().unwrap(),
    )?;
    let path = format!("/{}/{}/control/owner.json", cfg.s3.bucket, cfg.s3.prefix);
    let engine = Engine::open(cfg.clone(), false, None).await?;
    let original = fixture
        .s3(Method::GET, &path)
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    s3.request(Method::PUT, &path, b"invalid owner record".to_vec())
        .await?
        .error_for_status()?;
    assert!(engine.close().await.is_err());
    assert!(engine.close().await.is_err());
    assert!(engine.check_health().await.is_err());
    // Restore the original fixture record, then require the positive CAS confirmation.
    s3.request(Method::PUT, &path, original.to_vec())
        .await?
        .error_for_status()?;
    engine.close().await?;
    let owner = fixture
        .s3(Method::GET, &path)
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    assert_eq!(owner["id"], engine.health()["ownerId"]);
    assert_eq!(owner["released"], true);
    let next = Engine::open(cfg, false, None).await?;
    engine.close().await?;
    assert_ne!(
        next.check_health()
            .await
            .map_err(|e| anyhow::anyhow!(e.1))?["ownerId"],
        owner["id"]
    );
    next.close().await?;
    Ok(())
}

fn scope(authority: &Value) -> Value {
    json!({"authorityId":authority,"ownerKind":"workspace","ownerId":"ws_test","family":"workspace","partitionId":"primary"})
}
fn change(key: &str, value: Value, version: &Value) -> Value {
    json!({"key":key,"value":value,"expectedVersion":version})
}
fn commit(s: &Value, changes: Vec<Value>) -> Value {
    json!({"op":"commit","scope":s,"mutationId":Uuid::new_v4().to_string(),"changes":changes})
}
fn get(s: &Value, keys: &[&str]) -> Value {
    json!({"op":"get","scope":s,"keys":keys})
}
async fn rejects(m: &Meta, request: Value, expected: &str) -> Result<()> {
    let (status, result) = m.request(request).await?;
    assert!(status >= 400);
    assert_eq!(result["error"]["code"], expected);
    Ok(())
}
fn probe(name: &str, path: &std::path::Path, stage: Option<&str>) -> Result<()> {
    let status = Command::new(binary("examples").join(name))
        .arg(path)
        .args(stage)
        .status()?;
    ensure!(status.success(), "{name} exited with {status}");
    Ok(())
}

#[tokio::test]
#[ignore = "requires RustFS and native examples"]
async fn embedded_workspace_snapshot() -> Result<()> {
    let f = Fixture::start().await?;
    let mut m = f.meta("snapshot").await?;
    let path = f.directory().join("snapshot.json");
    private_json(&path, &m.server)?;
    m.process.stop()?;
    probe("workspace_read_snapshot", &path, None)
}

#[tokio::test]
#[ignore = "requires RustFS and native examples"]
async fn inactive_history_remains_isolated_across_restart() -> Result<()> {
    let f = Fixture::start().await?;
    let mut m = f.meta("history").await?;
    let path = f.directory().join("history.json");
    private_json(&path, &m.client)?;
    probe("history_fixture", &path, Some("write"))?;
    m.process.stop()?;
    let reopened = f.start_meta(m.server.clone(), false, None).await?;
    private_json(&path, &reopened.client)?;
    probe("history_fixture", &path, Some("verify"))
}

#[tokio::test]
#[ignore = "requires RustFS and native Meta"]
async fn metadata_isolates_records_replays_receipts_and_fences_crashed_owners() -> Result<()> {
    let f = Fixture::start().await?;
    let mut global = f.meta("global").await?;
    let mut a = f.meta("a").await?;
    let b = f.meta("b").await?;
    let s = scope(&a.server["authorityId"]);
    let system = json!({"authorityId":"region:a","ownerKind":"system","ownerId":"control-plane","family":"runtime-state","partitionId":"security-clock"});
    a.call(commit(
        &system,
        vec![change("time-floor", json!({"floor":123}), &Value::Null)],
    ))
    .await?;
    assert_eq!(
        a.call(get(&s, &["time-floor"])).await?["records"]["time-floor"],
        Value::Null
    );
    rejects(&b, get(&system, &["time-floor"]), "META_AUTHORITY_MISMATCH").await?;
    let http = http_client()?;
    for (token_file, installation, expected) in [
        (
            &b.client["tokenFile"],
            &a.client["installationId"],
            "META_UNAUTHORIZED",
        ),
        (
            &a.client["tokenFile"],
            &json!("wrong"),
            "META_INSTALLATION_MISMATCH",
        ),
    ] {
        let body = http
            .get(format!("{}/health", a.client["origin"].as_str().unwrap()))
            .bearer_auth(fs::read_to_string(token_file.as_str().unwrap())?.trim())
            .header("X-Meta-Authority", "region:a")
            .header("X-Meta-Installation", installation.as_str().unwrap())
            .send()
            .await?;
        assert!(body.status().is_client_error());
        assert_eq!(body.json::<Value>().await?["error"]["code"], expected);
    }
    let input = commit(
        &s,
        vec![
            change("resources/one", json!({"n":1}), &Value::Null),
            change("resources/two", Value::Null, &Value::Null),
        ],
    );
    let version = a.call(input.clone()).await?["version"].clone();
    assert_eq!(a.call(input.clone()).await?["replayed"], true);
    let mut mismatch = input.clone();
    mismatch["changes"] = json!([change("resources/one", json!(99), &Value::Null)]);
    rejects(&a, mismatch, "META_MUTATION_MISMATCH").await?;
    let update = |n| commit(&s, vec![change("resources/one", json!({"n":n}), &version)]);
    let (one, two) = tokio::try_join!(a.request(update(2)), a.request(update(3)))?;
    let (ok, conflict) = if one.0 == 200 { (one, two) } else { (two, one) };
    assert_eq!(ok.0, 200);
    assert_eq!(conflict.1["error"]["code"], "META_CONFLICT");
    tokio::try_join!(
        a.call(commit(
            &s,
            vec![change("resources/independent-a", json!(1), &Value::Null)]
        )),
        a.call(commit(
            &s,
            vec![change("resources/independent-b", json!(2), &Value::Null)]
        ))
    )?;
    rejects(&b, get(&s, &["resources/one"]), "META_AUTHORITY_MISMATCH").await?;
    let mut other = s.clone();
    other["ownerId"] = json!("ws_other");
    assert_eq!(
        a.call(get(&other, &["resources/one"])).await?["records"]["resources/one"],
        Value::Null
    );
    let lookup = get(&s, &["resources/one", "resources/two"]);
    let before = a.call(lookup.clone()).await?;
    let owner = a.health().await?["ownerId"].clone();
    global.process.stop()?;
    a.process.crash()?;
    let mut stale = f
        .start_meta(
            a.server.clone(),
            false,
            Some(owner.as_str().context("owner")?),
        )
        .await?;
    assert_eq!(stale.call(lookup.clone()).await?, before);
    assert_eq!(
        stale.call(get(&system, &["time-floor"])).await?["records"]["time-floor"]["value"],
        json!({"floor":123})
    );
    assert_eq!(
        stale
            .call(json!({"op":"resolve","scope":s,"mutationId":input["mutationId"]}))
            .await?["outcome"],
        "committed"
    );
    let mut takeover = stale.server.clone();
    takeover["bind"] = json!(format!("127.0.0.1:{}", port()?));
    let owner = stale.health().await?["ownerId"].clone();
    let current = f
        .start_meta(takeover, false, Some(owner.as_str().context("owner")?))
        .await?;
    rejects(&stale, get(&s, &["resources/one"]), "META_OWNER_FENCED").await?;
    stale.process.stop()?;
    assert_eq!(current.call(lookup).await?, before);
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated RustFS"]
async fn record_pagination_is_ordered_bounded_and_encrypted() -> Result<()> {
    let f = Fixture::start().await?;
    let a = f.meta("paging").await?;
    let s = scope(&a.server["authorityId"]);
    for i in (0..600).step_by(100) {
        a.call(commit(
            &s,
            (i..i + 100)
                .map(|n| change(&format!("resources/{n:05}"), json!({"n":n}), &Value::Null))
                .collect(),
        ))
        .await?;
    }
    const MARKER: &str = "private-test-credential";
    a.call(commit(
        &s,
        vec![
            change(
                "credentials/private",
                json!({"password":MARKER}),
                &Value::Null,
            ),
            change("resource-other", json!(true), &Value::Null),
        ],
    ))
    .await?;
    let list = |after: &Value, limit| json!({"op":"list","scope":s,"prefix":"resources/","after":after,"limit":limit});
    let mut keys = Vec::new();
    let mut cursor = Value::Null;
    loop {
        let page = a.call(list(&cursor, 17)).await?;
        let rows = page["records"].as_array().context("records")?;
        assert!(rows.len() <= 17);
        keys.extend(rows.iter().map(|r| r["key"].as_str().unwrap().to_owned()));
        assert!(keys.len() <= 600);
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(
        keys,
        (0..600)
            .map(|i| format!("resources/{i:05}"))
            .collect::<Vec<_>>()
    );
    for invalid in [
        list(&Value::Null, 0),
        list(&Value::Null, 513),
        list(&json!("credentials/private"), 17),
    ] {
        rejects(&a, invalid, "META_INVALID_REQUEST").await?;
    }
    let lookup = get(&s, &["resources/00000"]);
    let unchanged = a.call(lookup.clone()).await?;
    let target = a.call(get(&s, &["resources/00599"])).await?;
    a.call(commit(
        &s,
        vec![change(
            "resources/00599",
            json!({"n":999}),
            &target["records"]["resources/00599"]["version"],
        )],
    ))
    .await?;
    assert_eq!(a.call(lookup).await?, unchanged);
    let bucket = a.server["s3"]["bucket"].as_str().unwrap();
    let listing = f
        .s3(Method::GET, &format!("/{bucket}?list-type=2"))
        .await?
        .error_for_status()?
        .text()
        .await?;
    assert!(listing.contains("<Key>"));
    assert!(!listing.contains("<IsTruncated>true</IsTruncated>"));
    for entry in listing.split("<Key>").skip(1) {
        let key = entry.split_once("</Key>").context("object list")?.0;
        let bytes = f
            .s3(Method::GET, &format!("/{bucket}/{key}"))
            .await?
            .error_for_status()?
            .bytes()
            .await?;
        assert!(
            !bytes
                .windows(MARKER.len())
                .any(|part| part == MARKER.as_bytes())
        );
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires RustFS and native Meta"]
async fn workspace_writer_fences_cached_reads_and_mutations() -> Result<()> {
    let f = Fixture::start().await?;
    let a = f.meta("writers").await?;
    let s = scope(&a.server["authorityId"]);
    let set_writer = |owner, version: &Value| {
        commit(
            &s,
            vec![change("system/writer", json!({"ownerId":owner}), version)],
        )
    };
    let first = a.call(set_writer("first", &Value::Null)).await?;
    let guarded = |mut input: Value, owner: &str| {
        input["guard"] = json!({"ownerId":owner});
        input
    };
    a.call(guarded(
        commit(
            &s,
            vec![change(
                "state/workspace",
                json!({"id":"ws_test"}),
                &Value::Null,
            )],
        ),
        "first",
    ))
    .await?;
    let lookup = get(&s, &["state/workspace"]);
    rejects(&a, lookup.clone(), "META_WRITER_REQUIRED").await?;
    a.call(set_writer("second", &first["version"])).await?;
    rejects(&a, guarded(lookup.clone(), "first"), "META_WRITER_FENCED").await?;
    rejects(
        &a,
        guarded(
            commit(&s, vec![change("resource", json!(true), &Value::Null)]),
            "first",
        ),
        "META_WRITER_FENCED",
    )
    .await?;
    assert_eq!(
        a.call(guarded(lookup, "second")).await?["records"]["state/workspace"]["value"]["id"],
        "ws_test"
    );
    Ok(())
}

#[path = "cases/meta_gate.rs"]
mod gate;
#[path = "cases/meta_tls.rs"]
mod tls;
