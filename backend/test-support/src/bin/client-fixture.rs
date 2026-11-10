//! Give external SDKs temporary, loopback-only resources. EOF releases the fixture.
use anyhow::{Result, ensure};
use reqwest::Method;
use serde_json::json;
use std::io::Write;
use tokio::io::{AsyncBufReadExt, BufReader};
use uuid::Uuid;
use workspace_test_support::workspaces::{Workspaces, expect};

#[tokio::main]
async fn main() -> Result<()> {
    let (mut f, clock) = Workspaces::with_expiry_clock().await?;
    let key = f
        .create_key(
            0,
            "documented-examples",
            &["resources:read", "queries:read", "files:read"],
            &["db_live", "fs_live"],
        )
        .await?;
    let expiry = clock.now() + 300;
    let create=f.global(0,Method::POST,"/keys",None).header("Idempotency-Key",Uuid::new_v4().to_string()).json(&json!({"name":"client-renewal","scopes":["resources:read","queries:execute","files:read","files:write"],"resourceIds":["db_pg","fs_shared"],"expiresAt":expiry}));
    let sdk = expect(create, 201).await?;
    ensure!(
        sdk["regionalStatus"] == "applied",
        "SDK regional grant pending"
    );
    println!(
        "{}",
        json!({"endpoint":format!("{}/api",f.origin(0)),"region":format!("{}/api/v1",f.origin(0)),"key":key["secret"],"sdkKey":sdk["secret"],"expiresAt":expiry,"workspace":"ws_agentlab"})
    );
    std::io::stdout().flush()?;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(action) = lines.next_line().await? {
        let reply = match action.as_str() {
            "extend" => {
                let new_expiry = clock.now() + 3600;
                let path = format!("/keys/{}", sdk["data"]["keyId"].as_str().unwrap());
                expect(
                    f.global(0, Method::PATCH, &path, None)
                        .header("Idempotency-Key", Uuid::new_v4().to_string())
                        .header("If-Match", "\"1\"")
                        .json(&json!({"expiresAt":new_expiry})),
                    200,
                )
                .await?
            }
            "offline" => {
                f.crash_global_meta()?;
                json!({"ok":true})
            }
            "expire" => {
                clock.advance_past(expiry)?;
                json!({"offsetSeconds":clock.offset_seconds()})
            }
            "restart" => {
                f.restart(false).await?;
                json!({"ok":true})
            }
            "stop" => break,
            _ => anyhow::bail!("Unknown fixture action"),
        };
        println!("{reply}");
        std::io::stdout().flush()?;
    }
    Ok(())
}
