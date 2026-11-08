use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{fs, path::Path};
use tokio::process::Command;
use workspace_test_support::{Fixture, Meta, binary, private_json, private_write};

#[path = "identity/directory.rs"]
mod directory;
#[path = "identity/global.rs"]
mod global;
#[path = "identity/keys.rs"]
mod keys;
#[path = "identity/login.rs"]
mod login;
#[path = "identity/region.rs"]
mod region;
#[path = "identity/transport.rs"]
mod transport;

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn field<'a>(object: &'a Value, key: &str) -> &'a str {
    object[key].as_str().expect("required string")
}
fn file(f: &Fixture, name: &str) -> String {
    f.directory().join(name).to_str().unwrap().into()
}

async fn output(dir: &Path, name: &str, args: &[&str]) -> Result<std::process::Output> {
    let mut cmd = Command::new(binary("examples").join(name));
    cmd.current_dir(dir).args(args).kill_on_drop(true);
    Ok(
        tokio::time::timeout(std::time::Duration::from_secs(45), cmd.output())
            .await
            .with_context(|| format!("{name} timed out"))??,
    )
}
async fn run(dir: &Path, name: &str, args: &[&str]) -> Result<Value> {
    let out = output(dir, name, args).await?;
    ensure!(
        out.status.success(),
        "{name} failed ({}) {}",
        out.status,
        String::from_utf8_lossy(&out.stderr)
    );
    if out.stdout.is_empty() {
        Ok(Value::Null)
    } else {
        Ok(serde_json::from_slice(&out.stdout)?)
    }
}
async fn reject(dir: &Path, name: &str, args: &[&str]) -> Result<()> {
    ensure!(
        !output(dir, name, args).await?.status.success(),
        "{name} accepted a rejected operation"
    );
    Ok(())
}
async fn restart(f: &Fixture, meta: &mut Meta) -> Result<()> {
    let health = meta.health().await?;
    meta.process.crash()?;
    *meta = f
        .start_meta(meta.server.clone(), false, Some(field(&health, "ownerId")))
        .await?;
    Ok(())
}
fn policy() -> Value {
    json!({"workspaceId":"ws_agentlab","regionId":"region:other","keyId":id(),"principalId":"legacy-owner","keyVersion":1,"policyGeneration":1,"grantRef":"grant:existing","expiresAt":4000000000_u64,"revoked":false})
}
