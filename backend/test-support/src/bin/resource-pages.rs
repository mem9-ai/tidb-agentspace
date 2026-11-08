//! Time page reads against synthetic records in isolated RustFS-backed metadata.
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures::{StreamExt, TryStreamExt, stream};
use reqwest::Method;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use workspace_test_support::workspaces::{Workspaces, expect};

fn size(name: &str, default: usize, range: std::ops::RangeInclusive<usize>) -> Result<usize> {
    let value = std::env::var(name)
        .ok()
        .map(|v| v.parse())
        .transpose()?
        .unwrap_or(default);
    ensure!(range.contains(&value), "{name} must be in {range:?}");
    Ok(value)
}
async fn backfill(f: &Workspaces) -> Result<Value> {
    let create = async |name: &str, key: &str| {
        let r = f
            .owner(0, Method::POST, "/resources")
            .header("Idempotency-Key", key)
            .json(&json!({"kind":"postgresql","name":name,"region":"automatic"}))
            .send()
            .await?;
        Ok::<_, anyhow::Error>((r.status().as_u16(), r.json::<Value>().await?))
    };
    let start = Instant::now();
    let mut result = create("scale-index-backfill", "scale-backfill").await?;
    let first = start.elapsed();
    let mut retries = 0;
    while result.1["error"]["code"] == "RESOURCE_INDEX_MIGRATING"
        && start.elapsed() < Duration::from_secs(180)
    {
        retries += 1;
        tokio::time::sleep(Duration::from_millis(100)).await;
        result = create("scale-index-backfill", "scale-backfill").await?;
    }
    ensure!(result.0 == 201, "index backfill did not complete");
    let elapsed = start.elapsed();
    let replay = create("scale-index-backfill", "scale-backfill").await?;
    ensure!(
        replay.0 == 201 && replay.1["data"]["id"] == result.1["data"]["id"],
        "idempotent replay"
    );
    let duplicate = create("scale-1", "scale-duplicate").await?;
    ensure!(
        duplicate.0 == 409 && duplicate.1["error"]["code"] == "NAME_EXISTS",
        "duplicate name"
    );
    Ok(
        json!({"seconds":elapsed.as_secs_f64(),"firstResponseSeconds":first.as_secs_f64(),"retries":retries,"replay":"same resource","duplicate":"NAME_EXISTS"}),
    )
}
#[tokio::main]
async fn main() -> Result<()> {
    let count = size("SCALE_RESOURCES", 10000, 100..=1000000)?;
    let requests = size("SCALE_REQUESTS", 100, 1..=10000)?;
    let f = Workspaces::start(false, false).await?;
    expect(f.owner(0, Method::GET, "/resources?limit=1"), 200).await?;
    let start = Instant::now();
    f.seed_scale("resources",count,|n|json!({"id":format!("fs_scale_{n:08}"),"name":format!("scale-{n}"),"kind":"filesystem","region":"aws-ap-southeast-1","provider":"local","status":"active","createdAt":"2026-01-01T00:00:00Z"})).await?;
    let seed = start.elapsed();
    expect(f.at(0, Method::GET, "/api/health", false), 200).await?;
    let start = Instant::now();
    let mut times: Vec<_> = stream::iter(0..requests)
        .map(async |n| {
            let index = if n % 5 != 0 {
                (n * 7919) % 100
            } else {
                (n * 104729) % count
            };
            let id = format!("fs_scale_{index:08}");
            let cursor = URL_SAFE_NO_PAD.encode(&id);
            let t = Instant::now();
            let page = expect(
                f.owner(
                    0,
                    Method::GET,
                    &format!("/resources?limit=100&cursor={cursor}"),
                ),
                200,
            )
            .await?;
            let time = t.elapsed().as_secs_f64() * 1000.0;
            let rows = page["data"].as_array().context("page")?;
            ensure!(
                rows.len() <= 100
                    && rows
                        .iter()
                        .all(|r| r["id"].as_str().is_some_and(|s| s > id.as_str())),
                "invalid resource page"
            );
            Ok::<_, anyhow::Error>(time)
        })
        .buffer_unordered(4)
        .try_collect()
        .await?;
    let elapsed = start.elapsed();
    times.sort_by(f64::total_cmp);
    let percentile = |p: usize| times[(p * times.len()).div_ceil(100) - 1];
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // getrusage fills the supplied struct on success.
    ensure!(
        unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } == 0,
        "getrusage failed"
    );
    let rss =
        unsafe { usage.assume_init() }.ru_maxrss * if cfg!(target_os = "macos") { 1 } else { 1024 };
    let mut report = json!({"resources":count,"requests":requests,"concurrency":4,"pageSize":100,"mix":"80% within first 100 IDs; 20% spread across all IDs","seedSeconds":seed.as_secs_f64(),"workloadSeconds":elapsed.as_secs_f64(),"latencyMs":{"p50":percentile(50),"p95":percentile(95),"p99":percentile(99)},"benchmarkProcessPeakRssBytes":rss,"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"cpus":std::thread::available_parallelism()?.get(),"note":"Synthetic resources in a local RustFS-backed Workspace using remote Meta. Optional creation uses an isolated provider fixture."});
    if std::env::var("SCALE_INDEX_BACKFILL").as_deref() == Ok("1") {
        report["indexBackfill"] = backfill(&f).await?;
    }
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
