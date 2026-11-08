use anyhow::Result;
use reqwest::{Method, RequestBuilder};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use uuid::Uuid;
use workspace_test_support::workspaces::{Workspaces, expect};

const CSV: &str = include_str!("../../../specs/gh-150/fixtures/us-sales.csv");
const ATTEMPTS: &str = "/sales-sample-attempts";
const LIST: &str = "/sales-sample-attempts?fixture=us-sales-v1";
fn nonce() -> String {
    Uuid::new_v4().to_string()
}
fn sample(req: RequestBuilder, key: &str, id: Option<&str>) -> RequestBuilder {
    let mut body = json!({"fixture":"us-sales-v1"});
    if let Some(id) = id {
        body["resourceId"] = json!(id);
    }
    req.header("Idempotency-Key", key).json(&body)
}
fn start(f: &Workspaces, key: &str) -> RequestBuilder {
    sample(f.owner(0, Method::POST, ATTEMPTS), key, None)
}
fn default_fs(f: &Workspaces, key: &str) -> RequestBuilder {
    f.owner(0,Method::POST,"/resources").header("Idempotency-Key",key).json(&json!({"name":"my-files","kind":"filesystem","region":"aws-ap-southeast-1","onlyIfNew":true}))
}
async fn token(f: &Workspaces, name: &str, scopes: &[&str], ids: &[&str]) -> Result<String> {
    let key = f.create_key(0, name, scopes, ids).await?;
    f.exchange(0, key["secret"].as_str().unwrap()).await
}
async fn content(f: &Workspaces, resource: &str) -> Result<String> {
    let files = expect(
        f.owner(0, Method::GET, "/files")
            .query(&[("resourceId", resource), ("path", "/")]),
        200,
    )
    .await?;
    Ok(files["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["path"] == "/us-sales.csv")
        .unwrap()["content"]
        .as_str()
        .unwrap()
        .into())
}
async fn resource_count(f: &Workspaces) -> Result<usize> {
    Ok(
        expect(f.owner(0, Method::GET, "/resources"), 200).await?["data"]
            .as_array()
            .unwrap()
            .len(),
    )
}
#[test]
fn public_sales_fixture_matches_order_count_sales_by_state_and_top_product() -> Result<()> {
    let expected: Value =
        serde_json::from_str(include_str!("../../../specs/gh-150/fixtures/expected.json"))?;
    let mut lines = CSV.lines();
    assert_eq!(
        lines.next().unwrap(),
        "order_id,order_date,state,product,quantity,sales_usd"
    );
    let mut states = BTreeMap::new();
    let mut california = BTreeMap::new();
    let mut count = 0;
    for line in lines {
        let row: Vec<_> = line.split(',').collect();
        let amount: i64 = row[5].parse()?;
        *states.entry(row[2]).or_insert(0_i64) += amount;
        if row[2] == "California" {
            *california.entry(row[3]).or_insert(0_i64) += amount;
        }
        count += 1;
    }
    assert_eq!(expected["orderCount"], count);
    assert_eq!(json!(states), expected["salesByState"]);
    assert_eq!(expected["totalSales"], states.values().sum::<i64>());
    let (product, sales) = california.into_iter().max_by_key(|(_, sum)| *sum).unwrap();
    assert_eq!(expected["californiaTopProduct"]["product"], product);
    assert_eq!(expected["californiaTopProduct"]["sales"], sales);
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn default_file_system_is_created_once_and_stays_deleted() -> Result<()> {
    let f = Workspaces::local_files(true, true).await?;
    let key = "workspace-default-files-v1";
    let (a, b) = tokio::try_join!(
        expect(default_fs(&f, key), 201),
        expect(default_fs(&f, key), 201)
    )?;
    let id = a["data"]["id"].as_str().unwrap();
    assert_eq!(b["data"]["id"], id);
    assert_eq!(a["data"]["isDefault"], true);
    assert_eq!(resource_count(&f).await?, 1);
    let agent = token(&f, "no-default", &["resources:write"], &["*"]).await?;
    expect(f.agent(0,Method::POST,"/resources",Some(&agent)).header("Idempotency-Key",nonce()).json(&json!({"name":"another-default","kind":"filesystem","region":"aws-ap-southeast-1","onlyIfNew":true})),403).await?;
    let writer = token(&f, "sample-files", &["files:read", "files:write"], &[id]).await?;
    expect(
        sample(
            f.agent(0, Method::POST, ATTEMPTS, Some(&writer)),
            &nonce(),
            Some("fs_ungranted"),
        ),
        403,
    )
    .await?;
    assert_eq!(
        expect(f.owner(0, Method::GET, LIST), 200).await?["data"],
        json!([])
    );
    let sample_key = nonce();
    let req = || {
        sample(
            f.agent(0, Method::POST, ATTEMPTS, Some(&writer)),
            &sample_key,
            Some(id),
        )
    };
    let applied = expect(req(), 201).await?;
    assert_eq!(applied["data"]["status"], "ready");
    assert_eq!(applied["data"]["resourceId"], id);
    assert_eq!(
        expect(req(), 200).await?["data"]["id"],
        applied["data"]["id"]
    );
    assert_eq!(resource_count(&f).await?, 1);
    expect(f.owner(0, Method::DELETE, &format!("/resources/{id}")), 200).await?;
    let replay = expect(default_fs(&f, key), 201).await?;
    assert_eq!(replay["data"]["id"], id);
    assert_eq!(replay["data"]["status"], "deleted");
    assert_eq!(resource_count(&f).await?, 0);
    assert_eq!(
        expect(default_fs(&f, &nonce()), 409).await?["error"]["code"],
        "WORKSPACE_NOT_NEW"
    );
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn sample_reuses_filesystem_without_overwriting_customer_file() -> Result<()> {
    let f = Workspaces::local_files(true, true).await?;
    let fs = expect(default_fs(&f, "workspace-default-files-v1"), 201).await?;
    let id = fs["data"]["id"].as_str().unwrap();
    expect(f.owner(0,Method::PUT,"/files").header("If-None-Match","*").json(&json!({"resourceId":id,"path":"/us-sales.csv","type":"file","content":"customer data"})),200).await?;
    let result = expect(
        sample(f.owner(0, Method::POST, ATTEMPTS), &nonce(), Some(id)),
        201,
    )
    .await?;
    assert_eq!(result["data"]["status"], "outcome_unknown");
    assert_eq!(content(&f, id).await?, "customer data");
    assert_eq!(resource_count(&f).await?, 1);
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn sample_attempt_is_scoped_idempotent_and_preserves_edits_after_crash() -> Result<()> {
    let mut f = Workspaces::local_files(true, true).await?;
    assert_eq!(
        expect(f.owner(0, Method::GET, LIST), 200).await?["data"],
        json!([])
    );
    let limited = token(
        &f,
        "no-sample-write",
        &["resources:write", "files:read"],
        &["*"],
    )
    .await?;
    expect(
        sample(
            f.agent(0, Method::POST, ATTEMPTS, Some(&limited)),
            &nonce(),
            None,
        ),
        403,
    )
    .await?;
    assert_eq!(
        expect(f.owner(0, Method::GET, LIST), 200).await?["data"],
        json!([])
    );
    let key = nonce();
    let first = start(&f, &key).send().await?;
    assert_eq!(first.status(), 201);
    let loc = first.headers()["location"].to_str()?.to_owned();
    let first = first.json::<Value>().await?;
    let d = &first["data"];
    assert_eq!(d["status"], "ready");
    let id = d["id"].as_str().unwrap();
    let resource = d["resourceId"].as_str().unwrap();
    let etag = d["fileVersion"].as_str().unwrap();
    assert_eq!(loc, format!("sales-sample-attempts/{id}"));
    let value = etag
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap();
    assert!(
        !value.is_empty()
            && value
                .bytes()
                .all(|x| x == b'-' || x.is_ascii_alphanumeric())
    );
    let replay = start(&f, &key).send().await?;
    assert_eq!(replay.status(), 200);
    assert_eq!(replay.headers()["location"].to_str()?, loc);
    assert_eq!(replay.json::<Value>().await?["data"]["id"], id);
    assert_eq!(
        expect(
            f.owner(0, Method::POST, ATTEMPTS)
                .header("Idempotency-Key", key.as_str())
                .json(&json!({"fixture":"different"})),
            409
        )
        .await?["error"]["code"],
        "IDEMPOTENCY_CONFLICT"
    );
    expect(start(&f, &nonce()), 409).await?;
    let attempt = format!("{ATTEMPTS}/{id}");
    expect(f.owner(1, Method::GET, &attempt), 404).await?;
    assert_eq!(
        expect(f.owner(1, Method::GET, LIST), 200).await?["data"],
        json!([])
    );
    let resources = expect(f.owner(0, Method::GET, "/resources"), 200).await?;
    assert_eq!(resources["data"].as_array().unwrap().len(), 1);
    assert_eq!(resources["data"][0]["kind"], "filesystem");
    assert_eq!(content(&f, resource).await?, CSV);
    let reader = token(&f, "sample-reader", &["files:read"], &[resource]).await?;
    expect(f.agent(0, Method::GET, &attempt, Some(&reader)), 200).await?;
    let other = expect(
        f.owner(0, Method::POST, "/resources")
            .json(&json!({"name":"other-files","kind":"filesystem","region":"aws-us-west-2"})),
        201,
    )
    .await?;
    let denied = token(
        &f,
        "other-reader",
        &["files:read"],
        &[other["data"]["id"].as_str().unwrap()],
    )
    .await?;
    expect(f.agent(0, Method::GET, &attempt, Some(&denied)), 404).await?;
    expect(f.owner(0,Method::PUT,"/files").header("If-Match",etag).json(&json!({"resourceId":resource,"path":"/us-sales.csv","type":"file","content":"user changes"})),200).await?;
    f.restart(true).await?;
    assert_eq!(expect(start(&f, &key), 200).await?["data"]["id"], id);
    assert_eq!(content(&f, resource).await?, "user changes");
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn concurrent_sample_starts_have_one_durable_slot_per_workspace() -> Result<()> {
    for same in [true, false] {
        let f = Workspaces::local_files(true, true).await?;
        expect(f.owner(0, Method::GET, "/resources"), 200).await?;
        let a = nonce();
        let b = if same { a.clone() } else { nonce() };
        let (x, y) = tokio::try_join!(start(&f, &a).send(), start(&f, &b).send())?;
        let mut status = [x.status().as_u16(), y.status().as_u16()];
        status.sort();
        if same {
            assert_eq!(status, [200, 201]);
            assert_eq!(
                x.json::<Value>().await?["data"]["id"],
                y.json::<Value>().await?["data"]["id"]
            );
        } else {
            assert_eq!(status, [201, 409]);
            let created = if x.status() == 201 { x } else { y };
            assert_eq!(created.json::<Value>().await?["data"]["status"], "ready");
        }
        assert_eq!(resource_count(&f).await?, 1);
    }
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn live_sample_handles_confirmed_lost_and_uncertain_provider_responses() -> Result<()> {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    for scenario in ["confirmed", "lost", "uncertain", "existing"] {
        let f = Workspaces::start(true, true).await?;
        let writes = Arc::new(AtomicUsize::new(0));
        {
            let mut p = f.provider.state.lock().unwrap();
            match scenario {
                "lost" => p.lost = true,
                "uncertain" => {
                    let count = writes.clone();
                    p.write_race = Some(Box::new(move |path, files| {
                        count.fetch_add(1, Ordering::SeqCst);
                        files.insert(path.into(), CSV.as_bytes().into());
                        Some((503, json!({})))
                    }));
                }
                "existing" => {
                    p.files
                        .insert("/us-sales.csv".into(), b"existing customer data".to_vec());
                }
                _ => {}
            }
        }
        let key = nonce();
        let applied = expect(start(&f, &key), 201).await?;
        assert_eq!(
            applied["data"]["status"],
            if scenario == "confirmed" {
                "ready"
            } else {
                "outcome_unknown"
            }
        );
        assert_eq!(f.provider.state.lock().unwrap().creates, 1);
        let id = applied["data"]["resourceId"].as_str();
        let preview = || {
            f.owner(0, Method::GET, "/files/content").query(&[
                ("resourceId", id.unwrap()),
                ("path", "/us-sales.csv"),
                ("preview", "1"),
            ])
        };
        let expected = if scenario == "existing" {
            "existing customer data"
        } else {
            CSV
        };
        if scenario != "lost" {
            assert_eq!(expect(preview(), 200).await?["content"], expected);
        }
        assert_eq!(
            expect(start(&f, &key), 200).await?["data"]["id"],
            applied["data"]["id"]
        );
        assert_eq!(f.provider.state.lock().unwrap().creates, 1);
        if scenario == "uncertain" {
            assert_eq!(writes.load(Ordering::SeqCst), 1);
        }
        if scenario == "existing" {
            assert_eq!(expect(preview(), 200).await?["content"], expected);
        }
    }
    Ok(())
}
