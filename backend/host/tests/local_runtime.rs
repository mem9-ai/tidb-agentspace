use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::os::unix::process::CommandExt;
use std::{
    fs,
    net::TcpListener,
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};
use workspace_contracts::{MetaRequest, Metadata, Scope, WriterGuard};
use workspace_meta_client::{RemoteMetadata, private_file};

const BINARY: &str = env!("CARGO_BIN_EXE_workspace-backend");

fn local(directory: &Path, action: &str) -> Command {
    let mut command = Command::new(BINARY);
    command
        .args(["local", action, "--directory"])
        .arg(directory);
    command
}

fn config(path: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&private_file(path)?)?)
}

#[test]
fn launcher_requires_an_explicit_private_regional_deployment() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let no_config = Command::new(BINARY)
        .arg("serve-api")
        .env_remove("WORKSPACE_BACKEND_CONFIG")
        .output()?;
    assert!(!no_config.status.success());
    assert!(String::from_utf8_lossy(&no_config.stderr).contains("WORKSPACE_BACKEND_CONFIG"));
    let relative = Command::new(BINARY)
        .args(["serve-api", "--config", "deployment.json"])
        .output()?;
    assert!(!relative.status.success());
    assert!(String::from_utf8_lossy(&relative.stderr).contains("absolute"));
    let port = TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port();
    let installation = dir.path().join("runtime");
    assert!(
        local(&installation, "init")
            .args(["--api-port", &port.to_string()])
            .status()?
            .success()
    );
    assert!(!local(&installation, "init").output()?.status.success());
    let topology = config(&installation.join("topology.json"))?;
    let meta_plan = tempfile::NamedTempFile::new_in(dir.path())?;
    serde_json::to_writer(
        &meta_plan,
        &json!({"format":1,"services":[{"kind":"metadata","configFile":topology["services"][0]["configFile"]}]}),
    )?;
    let result = Command::new(BINARY)
        .args(["serve-api", "--config"])
        .arg(meta_plan.path())
        .output()?;
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("regional Workspace API role"));
    assert_eq!(
        String::from_utf8(local(&installation, "status").output()?.stdout)?.trim(),
        "stopped"
    );
    Ok(())
}

struct Running<'a> {
    child: Option<Child>,
    directory: &'a Path,
}

impl<'a> Running<'a> {
    fn start(directory: &'a Path) -> Result<Self> {
        Ok(Self {
            child: Some(
                local(directory, "serve")
                    .stdout(Stdio::null())
                    .process_group(0)
                    .spawn()?,
            ),
            directory,
        })
    }

    fn stop(&mut self) -> Result<()> {
        if let Some(mut child) = self.child.take() {
            // An assertion can unwind immediately after spawn, before the supervisor has created its lock.
            for _ in 0..300 {
                if self.directory.join("runtime.lock/owner.json").exists()
                    || child.try_wait()?.is_some()
                {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let stopped = local(self.directory, "stop").status()?;
            let exit = child.wait()?;
            ensure!(
                stopped.success() && exit.success(),
                "Unclean local shutdown"
            );
        }
        Ok(())
    }
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

async fn read_workspace(service: &Value) -> Result<Value> {
    let client =
        RemoteMetadata::connect(serde_json::from_value(service["client"].clone())?).await?;
    let scope = Scope {
        authority_id: service["authorityId"].as_str().unwrap().into(),
        owner_kind: "workspace".into(),
        owner_id: "ws_agentlab".into(),
        family: "workspace".into(),
        partition_id: "primary".into(),
    };
    let writer = client
        .execute(MetaRequest::Get {
            scope: scope.clone(),
            guard: None,
            keys: vec!["system/writer".into()],
        })
        .await?;
    let owner_id = writer["records"]["system/writer"]["value"]["ownerId"]
        .as_str()
        .context("Missing Workspace writer")?
        .to_owned();
    Ok(client
        .execute(MetaRequest::Get {
            scope,
            guard: Some(WriterGuard { owner_id }),
            keys: vec!["state/workspace".into()],
        })
        .await?)
}

async fn verify_ready(
    directory: &Path,
    origin: &str,
    http: &reqwest::Client,
) -> Result<(Value, Vec<String>)> {
    let topology = tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            let topology = config(&directory.join("topology.json"))?;
            if topology["workspaceInitialized"] == true
                && topology["services"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|s| s["initialized"] == true)
                && http
                    .get(format!("{origin}/api/health"))
                    .send()
                    .await
                    .is_ok_and(|r| r.status().is_success())
            {
                return Ok::<_, anyhow::Error>(topology);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .context("Local API and metadata did not start")??;
    let services = topology["services"].as_array().unwrap();
    assert_eq!(services.len(), 3);
    let mut owners = Vec::new();
    for service in services {
        let plan = config(Path::new(service["planFile"].as_str().unwrap()))?;
        assert_eq!(plan["memoryCache"], json!({"totalMiB":48, "instances":3}));
        assert!(!plan["services"][0]["initialize"].as_bool().unwrap_or(false));
        let client =
            RemoteMetadata::connect(serde_json::from_value(service["client"].clone())?).await?;
        owners.push(
            client.health().await?["ownerId"]
                .as_str()
                .context("Missing Meta owner")?
                .into(),
        );
    }
    let global =
        RemoteMetadata::connect(serde_json::from_value(services[0]["client"].clone())?).await?;
    for service in &services[1..] {
        let region = service["descriptor"]["regionId"].as_str().unwrap();
        tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                let response = global
                    .execute(MetaRequest::Get {
                        scope: Scope::system("global", "regions", "metadata-deployment", region),
                        guard: None,
                        keys: vec!["descriptor".into()],
                    })
                    .await?;
                if response["records"]["descriptor"]["value"] == service["descriptor"] {
                    return Ok::<(), anyhow::Error>(());
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .context("Global storage descriptor was not registered")??;
    }
    Ok((topology, owners))
}

#[tokio::test]
#[ignore = "requires a loopback listener and RustFS 1.0.4"]
async fn fresh_bootstrap_and_restart_persist_data_and_rotate_all_writers() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let directory = temp.path().join("runtime");
    let port = TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port();
    assert!(
        local(&directory, "init")
            .args(["--api-port", &port.to_string()])
            .status()?
            .success()
    );
    let topology_file = directory.join("topology.json");
    let mut topology = config(&topology_file)?;
    topology["memoryCache"] = json!({"totalMiB":48});
    fs::write(&topology_file, serde_json::to_vec(&topology)?)?;
    let origin = format!("http://127.0.0.1:{port}");
    let _ = rustls::crypto::ring::default_provider().install_default();
    let http = reqwest::Client::builder().no_proxy().build()?;
    let mut running = Running::start(&directory)?;
    let (topology, owners) = verify_ready(&directory, &origin, &http).await?;
    assert_eq!(
        String::from_utf8(local(&directory, "status").output()?.stdout)?.trim(),
        "running"
    );
    assert!(!local(&directory, "serve").output()?.status.success());
    let before = read_workspace(&topology["services"][1]).await?;
    assert!(before["records"]["state/workspace"].is_object());
    // A terminal sends Ctrl-C to the foreground group, including the supervisor.
    // Keys and Meta owners must still release in order for the restart below to succeed.
    let process_group = running.child.as_ref().unwrap().id();
    let interrupt = Command::new("/bin/kill")
        .args(["-INT", "--", &format!("-{process_group}")])
        .status()?;
    assert!(interrupt.success());
    assert!(running.child.take().unwrap().wait()?.success());
    assert!(!directory.join("runtime.lock").exists());
    let mut running = Running::start(&directory)?;
    let (topology, new_owners) = verify_ready(&directory, &origin, &http).await?;
    assert!(owners.iter().zip(&new_owners).all(|(old, new)| old != new));
    assert_eq!(read_workspace(&topology["services"][1]).await?, before);
    let session = http
        .post(format!("{origin}/api/session"))
        .json(&json!({}))
        .send()
        .await?
        .error_for_status()?;
    let cookie = session
        .headers()
        .get("set-cookie")
        .context("Missing regional session")?
        .to_str()?
        .split(';')
        .next()
        .unwrap();
    let boot: Value = http
        .get(format!(
            "{origin}/api/portal/v1/workspaces/ws_agentlab/bootstrap"
        ))
        .header("Cookie", cookie)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    for collection in ["resources", "keys", "files"] {
        assert_eq!(boot[collection], json!([]));
    }
    assert_eq!(
        config(Path::new(topology["apiConfigFile"].as_str().unwrap()))?["initializeWorkspace"],
        false
    );
    running.stop()?;
    assert_eq!(
        String::from_utf8(local(&directory, "status").output()?.stdout)?.trim(),
        "stopped"
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a loopback listener and RustFS 1.0.4"]
async fn a_foreign_health_endpoint_cannot_confirm_workspace_initialization() -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let foreign = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut request = [0u8; 1024];
            if stream.read(&mut request).await.is_ok() {
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK",
                    )
                    .await;
            }
        }
    });
    let temp = tempfile::tempdir()?;
    let dir = temp.path().join("runtime");
    assert!(
        local(&dir, "init")
            .args(["--api-port", &port.to_string()])
            .status()?
            .success()
    );
    let mut supervisor = Running::start(&dir)?;
    tokio::time::timeout(Duration::from_secs(40), async {
        loop {
            if fs::read_to_string(dir.join("rust-api.log"))
                .unwrap_or_default()
                .contains("No configured service could start")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .context("The port collision did not reach the regional role")?;
    supervisor.stop()?;
    foreign.abort();
    let _ = foreign.await;
    let topology = config(&dir.join("topology.json"))?;
    assert_eq!(topology["workspaceInitialized"], false);
    assert_eq!(
        config(Path::new(topology["apiConfigFile"].as_str().unwrap()))?["initializeWorkspace"],
        true
    );
    Ok(())
}
