//! Measure how many regional request-history records an isolated Workspace retains during a burst.
use anyhow::{Result, ensure};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};
use workspace_test_support::workspaces::{Workspaces, expect};

async fn read(f: &Workspaces) -> Result<(String, Duration)> {
    let start = Instant::now();
    let response = f.owner(0, Method::GET, "/resources").send().await?;
    ensure!(response.status() == 200, "resource listing failed");
    let id = response.headers()["x-request-id"].to_str()?.to_owned();
    response.bytes().await?;
    Ok((id, start.elapsed()))
}
#[tokio::main]
async fn main() -> Result<()> {
    let f = Workspaces::start(false, false).await?;
    let mut requested = BTreeSet::from([read(&f).await?.0]);
    let started = Instant::now();
    let groups = futures::future::try_join_all((0..4).map(|_| async {
        let mut results = Vec::with_capacity(25);
        for _ in 0..25 {
            results.push(read(&f).await?);
        }
        Ok::<_, anyhow::Error>(results)
    }))
    .await?;
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    let mut latencies = Vec::with_capacity(100);
    for (id, duration) in groups.into_iter().flatten() {
        requested.insert(id);
        latencies.push(duration);
    }
    latencies.sort();
    let end = Instant::now() + Duration::from_secs(3);
    let (recorded, matched, health) = loop {
        let mut cursor = None::<String>;
        let mut observed = Vec::new();
        let health = loop {
            let mut page = f.owner(0, Method::GET, "/request-history?limit=100");
            if let Some(c) = &cursor {
                page = page.query(&[("cursor", c)]);
            }
            let v = expect(page, 200).await?;
            observed.extend(
                v["data"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|row| row["requestId"].as_str().map(str::to_owned)),
            );
            cursor = v["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() || observed.len() >= 1000 {
                break v["health"].clone();
            }
        };
        let recorded = observed.len();
        let matched = observed.iter().filter(|id| requested.contains(*id)).count();
        let unique: BTreeSet<_> = observed.into_iter().collect();
        if requested.is_subset(&unique) || Instant::now() >= end {
            break (recorded, matched, health);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let report: Value = json!({"requests":100,"concurrency":4,"elapsedMs":elapsed.round(),"requestsPerSecond":100000.0/elapsed,"p50Ms":latencies[49].as_secs_f64()*1000.0,"p95Ms":latencies[94].as_secs_f64()*1000.0,"recorded":recorded,"matched":matched,"health":health});
    println!("{report}");
    Ok(())
}
