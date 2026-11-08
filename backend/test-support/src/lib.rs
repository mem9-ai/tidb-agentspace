//! Isolated native HTTP acceptance fixtures. A fixture owns all of its processes and data.
pub mod global;
pub mod oidc;
pub mod provider;
pub mod session;
pub mod tls;
pub mod workspaces;
use anyhow::{Context, Result, bail, ensure};
use reqwest::{Client, Method, Response};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    net::TcpListener,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tempfile::TempDir;
use workspace_meta_service::local_s3::LocalS3;

pub fn port() -> Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// Cargo places integration tests in target/<profile>/deps.
pub fn binary(name: &str) -> PathBuf {
    let exe = std::env::current_exe().expect("test executable");
    let directory = exe.parent().expect("target directory");
    let profile = match directory.file_name().and_then(|name| name.to_str()) {
        Some("deps" | "examples") => directory.parent().expect("profile directory"),
        _ => directory,
    };
    profile.join(name)
}

pub fn private_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut f = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)?;
    Ok(())
}
pub fn private_json(path: &Path, value: &Value) -> Result<()> {
    private_write(path, &serde_json::to_vec(value)?)
}

pub struct Process(Child);
impl Process {
    pub fn spawn(cmd: &mut Command, log: &Path) -> Result<Self> {
        let output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(log)?;
        Ok(Self(
            cmd.stdin(Stdio::null())
                .stdout(output.try_clone()?)
                .stderr(output)
                .spawn()
                .with_context(|| format!("starting {:?}", cmd.get_program()))?,
        ))
    }
    pub fn terminate(&self) -> Result<()> {
        // This process belongs to an unreaped Child, so its PID cannot be reused.
        if unsafe { libc::kill(self.0.id() as libc::pid_t, libc::SIGTERM) } == -1 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    pub fn wait_success(&mut self) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.0.try_wait()? {
                ensure!(status.success(), "fixture exited with {status}");
                return Ok(());
            }
            ensure!(Instant::now() < deadline, "fixture did not exit cleanly");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    /// A restart without a recovery owner is valid only after the old process drained.
    /// Keep async providers and open HTTP requests progressing while the child exits.
    pub async fn stop_cleanly(&mut self) -> Result<()> {
        self.ensure_running()?;
        self.terminate()?;
        let status = self
            .wait_for_exit(Duration::from_secs(10))
            .await
            .context("graceful shutdown did not finish; cannot restart as a clean writer")?;
        ensure!(
            status.success(),
            "graceful shutdown exited with {status}; cannot restart as a clean writer"
        );
        Ok(())
    }
    pub fn stop(&mut self) -> Result<()> {
        if self.0.try_wait()?.is_some() {
            return Ok(());
        }
        // This PID belongs to our unreaped Child, so it cannot have been recycled.
        unsafe {
            libc::kill(self.0.id() as libc::pid_t, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.0.try_wait()?.is_none() {
            if Instant::now() >= deadline {
                return self.crash();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(())
    }
    pub fn crash(&mut self) -> Result<()> {
        if self.0.try_wait()?.is_none() {
            self.0.kill()?;
            self.0.wait()?;
        }
        Ok(())
    }
    pub async fn wait_for_exit(&mut self, timeout: Duration) -> Result<std::process::ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.0.try_wait()? {
                return Ok(status);
            }
            ensure!(Instant::now() < deadline, "process did not exit");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    pub fn ensure_running(&mut self) -> Result<()> {
        if let Some(status) = self.0.try_wait()? {
            bail!("fixture process exited with {status}")
        }
        Ok(())
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

pub fn http_client() -> Result<Client> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    Ok(Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(30))
        .build()?)
}
fn secret() -> Result<String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| anyhow::anyhow!("randomness unavailable"))?;
    Ok(hex::encode(bytes))
}

pub struct Fixture {
    pub storage: Process,
    pub storage_config: Value,
    directory: TempDir,
    s3: LocalS3,
}
impl Fixture {
    pub async fn start() -> Result<Self> {
        let directory = tempfile::Builder::new()
            .prefix("native-workspace-test-")
            .tempdir()?;
        let listen = format!("127.0.0.1:{}", port()?);
        let origin = format!("http://{listen}");
        let access = format!("test{}", &secret()?[..16]);
        let password = secret()?;
        let bin = std::env::var_os("RUSTFS_BINARY").unwrap_or_else(|| "rustfs".into());
        fs::create_dir(directory.path().join("objects"))?;
        let mut storage = Process::spawn(
            Command::new(bin)
                .args(["server", "--address", &listen, "--region", "us-east-1"])
                .arg(directory.path().join("objects"))
                .env("RUSTFS_ACCESS_KEY", &access)
                .env("RUSTFS_SECRET_KEY", &password)
                .env("RUSTFS_CONSOLE_ENABLE", "false"),
            &directory.path().join("rustfs.log"),
        )?;
        let s3 = LocalS3::new(&origin, "us-east-1", &access, &password)?;
        let client = http_client()?;
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            storage.ensure_running()?;
            if client
                .get(&origin)
                .timeout(Duration::from_millis(500))
                .send()
                .await
                .is_ok()
            {
                break;
            }
            ensure!(Instant::now() < end, "RustFS did not start");
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
        let storage_config = json!({"endpoint":origin,"region":"us-east-1","accessKeyId":access,"secretAccessKey":password});
        Ok(Self {
            storage,
            directory,
            s3,
            storage_config,
        })
    }
    pub fn directory(&self) -> &Path {
        self.directory.path()
    }
    pub async fn s3(&self, method: Method, path: &str) -> Result<Response> {
        self.s3.request(method, path, Vec::new()).await
    }
    pub async fn meta(&self, name: &str) -> Result<Meta> {
        let listen = format!("127.0.0.1:{}", port()?);
        let bucket = format!("meta-{}", uuid::Uuid::new_v4().simple());
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            match self.s3.create_bucket(&bucket).await {
                Ok(()) => break,
                Err(e) if Instant::now() >= end => return Err(e),
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
        let authority = if name == "global" {
            "global".into()
        } else {
            format!("region:{name}")
        };
        let token_file = self.directory().join(format!("{name}-token"));
        let encryption_key_file = self.directory().join(format!("{name}-key"));
        private_write(&token_file, secret()?.as_bytes())?;
        private_write(&encryption_key_file, secret()?.as_bytes())?;
        let mut s3 = self.storage_config.clone();
        s3["bucket"] = json!(bucket);
        s3["prefix"] = json!("metadata");
        let config = json!({"authorityId":authority,"installationId":format!("meta-{name}"),"environment":"test",
            "bind":listen,"s3":s3,"tokenFile":token_file,"encryptionKeyFile":encryption_key_file,
            "encryptionKeyId":"test-key-v1","insecureLoopback":true});
        self.start_meta(config, true, None).await
    }
    pub async fn start_meta(
        &self,
        server: Value,
        initialize: bool,
        recover_owner: Option<&str>,
    ) -> Result<Meta> {
        let id = uuid::Uuid::new_v4();
        let cfg = self.directory().join(format!("meta-{id}.json"));
        private_json(&cfg, &server)?;
        let mut cmd = Command::new(binary("workspace-meta-service"));
        cmd.arg("--config").arg(&cfg);
        if initialize {
            cmd.arg("--initialize");
        }
        if let Some(owner) = recover_owner {
            cmd.args(["--recover-owner", owner]);
        }
        let process = Process::spawn(&mut cmd, &self.directory().join(format!("meta-{id}.log")))?;
        let origin = format!("http://{}", server["bind"].as_str().context("meta bind")?);
        let auth = fs::read_to_string(server["tokenFile"].as_str().context("meta tokenFile")?)?;
        let client = json!({"authorityId":server["authorityId"],"installationId":server["installationId"],
            "origin":origin,"tokenFile":server["tokenFile"],"insecureLoopback":true});
        let mut meta = Meta {
            process,
            server,
            client,
            auth,
            http: http_client()?,
        };
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            meta.process.ensure_running()?;
            let r = meta
                .request_builder(Method::GET, "/health")?
                .timeout(Duration::from_secs(1))
                .send()
                .await;
            if let Ok(r) = r
                && r.status().is_success()
            {
                let v: Value = r.json().await?;
                ensure!(
                    v["authorityId"] == meta.client["authorityId"]
                        && v["installationId"] == meta.client["installationId"],
                    "incorrect Meta identity"
                );
                break;
            }
            ensure!(Instant::now() < end, "Meta startup timed out");
            tokio::time::sleep(Duration::from_millis(100)).await
        }
        Ok(meta)
    }
}
pub struct Meta {
    pub process: Process,
    pub server: Value,
    pub client: Value,
    auth: String,
    http: Client,
}
impl Meta {
    fn request_builder(&self, method: Method, path: &str) -> Result<reqwest::RequestBuilder> {
        Ok(self
            .http
            .request(
                method,
                format!(
                    "{}{path}",
                    self.client["origin"].as_str().context("origin")?
                ),
            )
            .bearer_auth(self.auth.trim())
            .header(
                "X-Meta-Authority",
                self.client["authorityId"].as_str().context("authority")?,
            )
            .header(
                "X-Meta-Installation",
                self.client["installationId"]
                    .as_str()
                    .context("installation")?,
            ))
    }
    pub async fn health(&self) -> Result<Value> {
        Ok(self
            .request_builder(Method::GET, "/health")?
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }
    pub async fn request(&self, input: Value) -> Result<(u16, Value)> {
        let r = self
            .request_builder(Method::POST, "/v1/meta")?
            .json(&input)
            .send()
            .await?;
        Ok((r.status().as_u16(), r.json().await?))
    }
    pub async fn call(&self, input: Value) -> Result<Value> {
        let (status, v) = self.request(input).await?;
        ensure!(
            status == 200,
            "Meta request failed: HTTP {status} {}",
            v["error"]["code"]
        );
        Ok(v)
    }
}
