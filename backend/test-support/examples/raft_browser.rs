//! Console → native Global/Region/Meta, with only the external IdP replaced by a fixture.
#[allow(dead_code)]
#[path = "../tests/sso/site.rs"]
mod site;

use anyhow::{Result, ensure};
use serde_json::json;
use std::path::Path;
use workspace_test_support::{port, private_json, private_write};

#[tokio::main]
async fn main() -> Result<()> {
    let mut f = site::Site::prepare(site::Profile::Global, false, json!({})).await?;
    let server = uuid::Uuid::new_v4().to_string();
    let origin = format!("https://127.0.0.1:{}", port()?);
    let global_path = "/studio/api/global";
    let callback = format!("{origin}{global_path}/auth/raft/callback");
    let secret = f.fixture.directory().join("raft-secret");
    private_write(&secret, b"fixture-confidential-client")?;
    f.oidc.allow_redirect(&callback);
    f.oidc.raft_mode("fixture-confidential-client");
    let claims = |subject: &str, kind: &str| {
        json!({"sub":subject,"type":kind,"server_id":server,"client_id":"native-client",
            "scope":"openid profile","server_role":"admin"})
    };
    f.oidc.claims(claims("browser-agent", "agent"));
    let agent_code = f.oidc.agent_code(&callback);
    f.oidc.claims(claims("browser-human", "human"));
    f.browser.public_origin = origin.clone();
    f.config["publicOrigins"] = json!([origin, f.browser.origin]);
    f.config["consoleOrigins"] = json!([origin]);
    f.config["globalEntry"]["apiOrigin"] = json!(origin);
    f.config["sso"]["redirectUri"] = json!(format!("{origin}/studio/api/auth/tidbcloud/callback"));
    f.config["security"]["publicOrigin"] = json!(f.browser.origin);
    f.config["security"]["globalIssuer"] = json!(format!("{origin}{global_path}"));
    f.config["security"]["raft"] = json!({"issuer":f.oidc.issuer,"clientId":"native-client",
        "allowedServerIds":[server],"allowLoopbackHttp":true});
    let global = f.global_config.as_mut().unwrap();
    global["publicOrigin"] = json!(origin);
    global["consoleOrigins"] = json!([origin]);
    global["regions"][0]["apiOrigin"] = json!(f.browser.origin);
    global["raft"] = json!({"issuer":f.oidc.issuer,"clientId":"native-client",
        "clientSecretFile":secret,"redirectUri":callback,"postLoginUrl":format!("{origin}/studio/raft"),
        "allowedServerIds":[server],"allowLoopbackHttp":true});
    f.start().await?;
    let config = f.fixture.directory().join("browser-fixture.json");
    private_json(
        &config,
        &json!({"origin":origin,"backend":f.browser.origin,
        "issuer":f.oidc.issuer,"serverId":server,"agentCallback":format!("{callback}?code={agent_code}"),
        "certificateFile":f.fixture.directory().join("server.crt"),
        "privateKeyFile":f.fixture.directory().join("server.key")}),
    )?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut command = tokio::process::Command::new("node");
    command
        .arg(root.join("e2e/native-raft.mjs"))
        .arg(config)
        .current_dir(&root)
        .kill_on_drop(true);
    let output =
        tokio::time::timeout(std::time::Duration::from_secs(180), command.output()).await??;
    f.stop()?;
    ensure!(
        output.status.success(),
        "Native browser journey failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    println!("{}", String::from_utf8_lossy(&output.stdout));
    Ok(())
}
