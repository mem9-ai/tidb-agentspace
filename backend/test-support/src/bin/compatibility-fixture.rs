//! Exercise two reviewed API/Meta builds against the same isolated format-2 installations.
use anyhow::{Context, Result, ensure};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
};
use workspace_test_support::workspaces::{REGION, Workspaces, expect};

fn put(f: &Workspaces, workspace: usize, path: &str, content: &str) -> reqwest::RequestBuilder {
    f.owner(workspace, Method::PUT, "/files").json(&json!({
        "resourceId":"fs_shared","path":path,"type":"file","content":content
    }))
}

async fn version(f: &Workspaces) -> Result<String> {
    let result = expect(
        f.owner(0, Method::GET, "/files/metadata")
            .query(&[("resourceId", "fs_shared"), ("path", "/sdk.txt")]),
        200,
    )
    .await?;
    Ok(result["data"]["version"]
        .as_str()
        .context("missing version")?
        .to_owned())
}

fn prepare(f: &Workspaces, request_id: &str) -> reqwest::RequestBuilder {
    f.owner(0, Method::POST, "/sales-sample-attempts")
        .header("Idempotency-Key", request_id)
        .json(&json!({"fixture":"us-sales-v1","resourceId":"fs_shared"}))
}

async fn check_files(f: &Workspaces, workspace: usize, expected: &str) -> Result<()> {
    let entries = expect(
        f.owner(workspace, Method::GET, "/files")
            .query(&[("resourceId", "fs_shared"), ("path", "/")]),
        200,
    )
    .await?;
    let entries = entries["data"].as_array().context("file collection")?;
    for (path, content) in [("/sdk.txt", expected), ("/us-sales.csv", "customer edits")] {
        ensure!(
            entries
                .iter()
                .any(|row| row["path"] == path && row["content"] == content),
            "Workspace {workspace} did not retain {path}"
        );
    }
    Ok(())
}

struct History {
    read_key: Value,
    scoped_key: Value,
    revoked_key: Value,
    region_token: String,
    attempt: Value,
    request_id: String,
}

impl History {
    async fn seed(f: &Workspaces) -> Result<Self> {
        for (workspace, text) in ["old bytes", "other tenant"].into_iter().enumerate() {
            expect(
                put(f, workspace, "/sdk.txt", text).header("If-None-Match", "*"),
                200,
            )
            .await?;
            expect(
                put(f, workspace, "/us-sales.csv", "customer edits").header("If-None-Match", "*"),
                200,
            )
            .await?;
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let attempt = expect(prepare(f, &request_id), 201).await?["data"].clone();
        ensure!(
            attempt["status"] == "outcome_unknown",
            "expected a preserved file conflict"
        );
        let read_key = f
            .create_key(
                0,
                "historical-reader",
                &["resources:read", "files:read"],
                &["db_live", "fs_live"],
            )
            .await?;
        let scoped_key = f
            .create_key(
                0,
                "historical-client",
                &["resources:read", "files:read", "queries:execute"],
                &["db_pg", "fs_shared"],
            )
            .await?;
        let revoked_key = f
            .create_key(0, "historical-revoked", &["resources:read"], &["*"])
            .await?;
        f.revoke(0, &revoked_key["data"]).await?;
        let region_token = f
            .exchange(0, scoped_key["secret"].as_str().context("test key")?)
            .await?;
        Ok(Self {
            read_key,
            scoped_key,
            revoked_key,
            region_token,
            attempt,
            request_id,
        })
    }

    async fn verify(&self, f: &Workspaces, expected: &str) -> Result<()> {
        check_files(f, 0, expected).await?;
        check_files(f, 1, "other tenant").await?;
        let attempt = format!(
            "/sales-sample-attempts/{}",
            self.attempt["id"].as_str().context("attempt ID")?
        );
        ensure!(
            expect(f.owner(0, Method::GET, &attempt), 200).await?["data"] == self.attempt,
            "attempt changed"
        );
        ensure!(
            expect(prepare(f, &self.request_id), 200).await?["data"] == self.attempt,
            "idempotency replay changed"
        );
        expect(f.owner(1, Method::GET, &attempt), 404).await?;
        let revoked = f
            .global(
                0,
                Method::POST,
                "/token-issuances",
                self.revoked_key["secret"].as_str(),
            )
            .json(&json!({"audience":REGION}))
            .send()
            .await?;
        ensure!(
            revoked.status() == 401,
            "revoked key returned {}",
            revoked.status()
        );
        let token = Some(self.region_token.as_str());
        let result = expect(
            f.agent(0, Method::POST, "/queries", token)
                .json(&json!({"resourceId":"db_pg","sql":"SELECT 1 AS value"})),
            200,
        )
        .await?;
        ensure!(
            result["rows"] == json!([{"value":1}]),
            "unexpected database result"
        );
        let denied = f.agent(1, Method::GET, "/resources", token).send().await?;
        ensure!(
            matches!(denied.status().as_u16(), 401 | 403),
            "cross-workspace token returned {}",
            denied.status()
        );
        Ok(())
    }

    fn old_clients(&self, f: &Workspaces, sdk: &Path) -> Result<()> {
        let mut child = Command::new("node")
            .arg("tools/agent-client-tests/released-clients.mjs")
            .arg(sdk)
            .stdin(Stdio::piped())
            .spawn()?;
        let config = json!({"endpoint":format!("{}/api",f.origin(0)),"key": self.read_key["secret"],"sdkKey": self.scoped_key["secret"]});
        child
            .stdin
            .take()
            .context("client input")?
            .write_all(&serde_json::to_vec(&config)?)?;
        ensure!(child.wait()?.success(), "released clients failed");
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    ensure!(
        args.len() == 3,
        "usage: compatibility-fixture OLD_BIN_DIR NEW_BIN_DIR OLD_SDK_DIR"
    );
    let (old, new, sdk) = (
        Path::new(&args[0]),
        Path::new(&args[1]),
        Path::new(&args[2]),
    );
    let mut f = Workspaces::start_version(old).await?;
    let history = History::seed(&f).await?;
    let deadline = std::time::SystemTime::now() + std::time::Duration::from_secs(12);
    let expires = deadline.duration_since(std::time::UNIX_EPOCH)?.as_secs();
    let expiring = expect(f.global(0,Method::POST,"/keys",None)
        .header("Idempotency-Key", uuid::Uuid::new_v4().to_string())
        .json(&json!({"name":"expiring files","scopes":["resources:read"],"resourceTypes":["filesystem"],"expiresAt":expires})),201).await?;
    let secret = expiring["secret"]
        .as_str()
        .context("expiring fixture Key")?;
    let expiring_token = f.exchange(0, secret).await?;
    let allowed = expect(
        f.agent(0, Method::GET, "/resources", Some(&expiring_token)),
        200,
    )
    .await?;
    let rows = allowed["data"].as_array().context("type grant resources")?;
    ensure!(
        !rows.is_empty() && rows.iter().all(|r| r["kind"] == "filesystem"),
        "unexpected type grant"
    );

    history
        .verify(&f, "old bytes")
        .await
        .context("baseline observations")?;
    let original = version(&f).await?;
    f.change_version(new).await?;
    history
        .verify(&f, "old bytes")
        .await
        .context("candidate observations")?;
    if let Ok(remaining) = deadline.duration_since(std::time::SystemTime::now()) {
        tokio::time::sleep(remaining).await;
    }
    expect(
        f.global(0, Method::POST, "/token-issuances", Some(secret))
            .json(&json!({"audience":REGION})),
        401,
    )
    .await?;
    expect(
        f.agent(0, Method::GET, "/resources", Some(&expiring_token)),
        401,
    )
    .await?;
    history.old_clients(&f, sdk)?;
    println!("PREVIOUS_CLIENTS_PASSED");
    expect(
        put(&f, 0, "/sdk.txt", "candidate bytes").header("If-Match", &original),
        200,
    )
    .await?;
    expect(
        put(&f, 0, "/sdk.txt", "stale").header("If-Match", &original),
        412,
    )
    .await?;
    let latest = version(&f).await?;
    ensure!(latest != original, "write retained stale version");
    println!("DATA_UPGRADE_PASSED");
    f.change_version(old).await?;
    history
        .verify(&f, "candidate bytes")
        .await
        .context("rollback observations")?;
    expect(
        put(&f, 0, "/sdk.txt", "rollback write").header("If-Match", &latest),
        200,
    )
    .await?;
    check_files(&f, 0, "rollback write").await?;
    println!("ROLLBACK_AFTER_WRITE_PASSED");
    println!("Baseline SDKs, two-Workspace upgrade and rollback after a candidate write passed.");
    Ok(())
}
