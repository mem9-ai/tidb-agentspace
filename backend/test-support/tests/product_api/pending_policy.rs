// Pause the exact Global Meta operation that removes a durably delivered policy.
// All other traffic reaches the same real Meta. A prior blocked request always fails,
// so only a fresh reconciliation can remove its receipt after the host restarts.
use anyhow::{Context, Result};
use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::sync::{Arc, OnceLock};
use tokio::sync::{mpsc, watch};
use workspace_test_support::{http_client, workspaces::Workspaces};

struct Gate {
    upstream: OnceLock<String>,
    http: reqwest::Client,
    blocked: mpsc::UnboundedSender<(Value, String)>,
    release: watch::Receiver<bool>,
}

async fn forward(
    State(gate): State<Arc<Gate>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, StatusCode> {
    if !*gate.release.borrow()
        && let Ok(op) = serde_json::from_slice::<Value>(&body)
        && op["op"] == "commit"
        && op["scope"]["family"] == "policy-sync"
        && op["changes"][0]["delete"] == true
        && let Some(key) = op["changes"][0]["key"]
            .as_str()
            .filter(|s| s.starts_with("pending/"))
    {
        let _ = gate.blocked.send((op["scope"].clone(), key.to_owned()));
        let mut release = gate.release.clone();
        let _ = release.wait_for(|go| *go).await;
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    let upstream = gate.upstream.get().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let reply = gate
        .http
        .request(method, format!("{upstream}{uri}"))
        .headers(headers)
        .body(body)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok((
        reply.status(),
        reply.bytes().await.map_err(|_| StatusCode::BAD_GATEWAY)?,
    )
        .into_response())
}

#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn blocked_policy_reconciliation_drains_and_replays_after_restart() -> Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let (tx, mut blocked) = mpsc::unbounded_channel();
    let (release, wait) = watch::channel(false);
    let gate = Arc::new(Gate {
        upstream: OnceLock::new(),
        http: http_client()?,
        blocked: tx,
        release: wait,
    });
    let app = Router::new().fallback(forward).with_state(gate.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let mut f = Workspaces::with_global_meta_route(|meta| {
        gate.upstream
            .set(
                meta.client["origin"]
                    .as_str()
                    .context("global Meta origin")?
                    .into(),
            )
            .unwrap();
        Ok(origin)
    })
    .await?;
    let key = f
        .create_key(
            0,
            "pending-at-shutdown",
            &["resources:read"],
            &["fs_shared"],
        )
        .await?;
    assert_eq!(key["regionalStatus"], "applied");
    let (scope, pending) = tokio::time::timeout(std::time::Duration::from_secs(15), blocked.recv())
        .await?
        .context("missing reconciliation")?;
    let read = json!({"op":"get","scope":scope,"keys":[pending]});
    let record = f.global_meta().call(read.clone()).await?["records"][&pending].clone();
    assert_eq!(record["value"]["keyId"], key["data"]["keyId"]);
    assert_eq!(record["value"]["targetVersion"], key["data"]["keyVersion"]);
    // No customer request is outstanding. SIGTERM races only with the background worker.
    f.restart(false).await?;
    assert_eq!(
        f.global_meta().call(read.clone()).await?["records"][&pending],
        record
    );
    release.send_replace(true);
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            if f.global_meta().call(read.clone()).await?["records"][&pending].is_null() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    let token = f
        .exchange(0, key["secret"].as_str().context("Workspace Key")?)
        .await?;
    let list = super::check(f.agent(0, Method::GET, "/resources", Some(&token)), 200, "").await?;
    assert_eq!(list["data"].as_array().unwrap().len(), 1);
    assert_eq!(list["data"][0]["id"], "fs_shared");
    server.abort();
    Ok(())
}
