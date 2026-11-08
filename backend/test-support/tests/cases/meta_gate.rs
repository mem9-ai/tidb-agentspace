//! Delay real S3 operations at the HTTP boundary, preserving the signed Host and request body.
use super::*;
use axum::{
    Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, Uri},
    response::{IntoResponse, Response},
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst},
    },
    time::Duration,
};
use tokio::sync::watch;

struct StateData {
    upstream: String,
    client: reqwest::Client,
    owner_reads: AtomicUsize,
    blocked: AtomicUsize,
    next_owner: AtomicBool,
    owner_release: watch::Sender<bool>,
    wal_release: watch::Sender<bool>,
}
async fn forward(
    State(state): State<Arc<StateData>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let owner = method == Method::GET && uri.path().ends_with("/control/owner.json");
    let gate = if owner {
        state.owner_reads.fetch_add(1, SeqCst);
        state
            .next_owner
            .swap(false, SeqCst)
            .then(|| state.owner_release.subscribe())
    } else if method == Method::PUT && uri.path().contains("/slatedb/wal/") {
        Some(state.wal_release.subscribe())
    } else {
        None
    };
    if let Some(mut gate) = gate
        && !*gate.borrow()
    {
        state.blocked.fetch_add(1, SeqCst);
        let _ = gate.wait_for(|open| *open).await;
        state.blocked.fetch_sub(1, SeqCst);
    }
    match state
        .client
        .request(method, format!("{}{uri}", state.upstream))
        .headers(headers)
        .body(body)
        .send()
        .await
    {
        Ok(reply) => {
            let mut response = Response::builder().status(reply.status());
            *response.headers_mut().unwrap() = reply.headers().clone();
            response
                .body(Body::from_stream(reply.bytes_stream()))
                .unwrap()
        }
        Err(_) => axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}
struct Gate {
    state: Arc<StateData>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Gate {
    fn drop(&mut self) {
        self.state.wal_release.send_replace(true);
        self.state.owner_release.send_replace(true);
        self.server.abort();
    }
}
impl Gate {
    async fn start(f: &Fixture, name: &str) -> Result<(Self, Meta)> {
        let mut local = f.meta(name).await?;
        local.process.stop()?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let state = Arc::new(StateData {
            upstream: local.server["s3"]["endpoint"]
                .as_str()
                .context("endpoint")?
                .into(),
            client: http_client()?,
            owner_reads: 0.into(),
            blocked: 0.into(),
            next_owner: false.into(),
            owner_release: watch::channel(true).0,
            wal_release: watch::channel(true).0,
        });
        let app = Router::new()
            .fallback(forward)
            .layer(DefaultBodyLimit::max(128 * 1024 * 1024))
            .with_state(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let gate = Self { state, server };
        let mut config = local.server.clone();
        config["s3"]["endpoint"] = json!(format!("http://{addr}"));
        Ok((gate, f.start_meta(config, false, None).await?))
    }
}
async fn until(predicate: impl Fn() -> bool) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    Ok(())
}
#[tokio::test]
#[ignore = "requires native Meta and gated RustFS"]
async fn stalled_ownership_read_allows_independent_progress() -> Result<()> {
    let f = Fixture::start().await?;
    let (gate, a) = Gate::start(&f, "progress").await?;
    let s = scope(&a.server["authorityId"]);
    gate.state.owner_release.send_replace(false);
    gate.state.next_owner.store(true, SeqCst);
    let slow = a.call(get(&s, &["slow"]));
    tokio::pin!(slow);
    tokio::select! {
        result=&mut slow=>anyhow::bail!("expected a stalled ownership read, got {result:?}"),
        ready=until(||gate.state.blocked.load(SeqCst)==1)=>ready?,
    }
    tokio::time::timeout(
        Duration::from_secs(5),
        a.call(commit(
            &s,
            vec![change("independent", json!(true), &Value::Null)],
        )),
    )
    .await??;
    assert_eq!(gate.state.blocked.load(SeqCst), 1);
    gate.state.owner_release.send_replace(true);
    slow.await?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires native Meta and gated RustFS"]
async fn mutations_reads_and_receipts_wait_for_durability_and_shutdown_drains() -> Result<()> {
    let f = Fixture::start().await?;
    let (gate, a) = Gate::start(&f, "durable").await?;
    let s = scope(&a.server["authorityId"]);
    let input = commit(
        &s,
        vec![
            change("grant", json!(true), &Value::Null),
            change("matching", json!(true), &Value::Null),
        ],
    );
    gate.state.wal_release.send_replace(false);
    let lookup = get(&s, &["grant", "matching"]);
    let config = a.server.clone();
    let a = Arc::new(a);
    let write = tokio::spawn({
        let a = a.clone();
        let input = input.clone();
        async move { a.call(input).await }
    });
    until(|| gate.state.blocked.load(SeqCst) > 0).await?;
    assert!(!write.is_finished());
    let count = gate.state.owner_reads.load(SeqCst);
    let read = tokio::spawn({
        let a = a.clone();
        let lookup = lookup.clone();
        async move { a.call(lookup).await }
    });
    let receipt = tokio::spawn({
        let a = a.clone();
        async move {
            a.call(json!({"op":"resolve","scope":s,"mutationId":input["mutationId"]}))
                .await
        }
    });
    a.health().await?;
    until(|| gate.state.owner_reads.load(SeqCst) >= count + 3).await?;
    assert!(!read.is_finished() && !receipt.is_finished() && !write.is_finished());
    a.process.terminate()?;
    gate.state.wal_release.send_replace(true);
    let (written, records, resolved) = tokio::try_join!(write, read, receipt)?;
    let (written, records, resolved) = (written?, records?, resolved?);
    for key in ["grant", "matching"] {
        assert_eq!(records["records"][key]["version"], written["version"]);
        assert_eq!(records["records"][key]["value"], true);
    }
    assert_eq!(resolved["version"], written["version"]);
    let mut a = Arc::try_unwrap(a).map_err(|_| anyhow::anyhow!("outstanding Meta client"))?;
    tokio::task::spawn_blocking(move || a.process.wait_success()).await??;
    let reopened = f.start_meta(config, false, None).await?;
    assert_eq!(reopened.call(lookup).await?, records);
    Ok(())
}
