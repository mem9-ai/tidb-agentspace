use super::config::{self, Service, Topology, read, save};
use anyhow::{Context, Result, bail, ensure};
use futures::{StreamExt, stream::FuturesUnordered};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, ErrorKind},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::signal::unix::{SignalKind, signal};
use tokio::{
    process::{Child, Command},
    time::{sleep, timeout},
};
use uuid::Uuid;
use workspace_contracts::{MetaRequest, Metadata, Scope};
use workspace_meta_client::RemoteMetadata;
use workspace_meta_service::local_s3::LocalS3;

const POLL: Duration = Duration::from_millis(100);
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(45);

async fn retry<T>(mut action: impl AsyncFnMut() -> Result<T>) -> Result<T> {
    timeout(READY_TIMEOUT, async {
        loop {
            if let Ok(value) = action().await {
                return value;
            }
            sleep(POLL).await;
        }
    })
    .await
    .context("Local role unavailable; inspect its private log")
}

struct Children<'a> {
    directory: &'a Path,
    children: Vec<Child>,
}

impl Children<'_> {
    fn start(&mut self, command: &mut Command, name: &str) -> Result<()> {
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(self.directory.join(format!("{name}.log")))?;
        // Only the supervisor receives terminal interrupts. Writers must drain before storage.
        command
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(file.try_clone()?)
            .stderr(file);
        self.children.push(
            command
                .spawn()
                .with_context(|| format!("Could not start {name}"))?,
        );
        Ok(())
    }

    fn role(&mut self, binary: &Path, plan: &Path, name: &str) -> Result<()> {
        self.start(
            Command::new(binary).args(["serve", "--config"]).arg(plan),
            name,
        )
    }

    async fn drain(&mut self) -> Result<()> {
        for child in self.children.iter_mut().rev() {
            if child.try_wait()?.is_some() {
                continue;
            }
            // Only signal a child whose exit has not been reaped. Its PID cannot be recycled.
            let pid = child.id().context("Missing supervised process")?;
            let signalled = Command::new("/bin/kill")
                .args(["-TERM", &pid.to_string()])
                .status()
                .await?;
            ensure!(
                signalled.success() || child.try_wait()?.is_some(),
                "Could not stop a local role"
            );
            let exit = timeout(DRAIN_TIMEOUT, child.wait())
                .await
                .context("Drain incomplete; preserve local storage and ownership")??;
            ensure!(
                exit.success() || std::os::unix::process::ExitStatusExt::signal(&exit) == Some(15),
                "A local role failed to drain; preserve local storage and ownership"
            );
        }
        Ok(())
    }
}

fn service_plan(service: &Service, memory_cache: &Value) -> Result<()> {
    save(
        &service.plan_file,
        &json!({"format":1,"memoryCache":memory_cache,"services":[{
            "kind":"metadata", "configFile":service.config_file, "initialize":!service.initialized
        }]}),
    )
}

async fn register_descriptors(global: &RemoteMetadata, services: &[Service]) {
    for service in services {
        let result: Result<()> = async {
            let region = service.authority_id.strip_prefix("region:").context("Invalid region authority")?;
            let scope = Scope::system("global","regions","metadata-deployment",region);
            let found = global.execute(MetaRequest::Get {
                scope:scope.clone(), guard:None, keys:vec!["descriptor".into()],
            }).await?;
            if let Some(stored) = found["records"].get("descriptor").filter(|v| !v.is_null()) {
                ensure!(stored["value"] == service.descriptor, "Global storage descriptor differs");
            } else {
                global.execute(MetaRequest::Commit { scope,guard:None, mutation_id:Uuid::new_v4().to_string(),
                    changes:vec![json!({"key":"descriptor","expectedVersion":null,"value":service.descriptor})] }).await?;
            }
            Ok(())
        }.await;
        if let Err(err) = result {
            eprintln!(
                "Check the Global storage descriptor for {} ({err}).",
                service.authority_id
            );
        }
    }
}

async fn api_ready(child: &mut Child, directory: &Path, bind: &str) -> Result<()> {
    let marker = format!(" listening on {bind}.");
    let url = format!("http://{bind}/api/health");
    let http = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()?;
    let mut log = BufReader::new(fs::File::open(directory.join("rust-api.log"))?);
    let mut listening = false;
    timeout(READY_TIMEOUT, async {
        loop {
            ensure!(
                child.try_wait()?.is_none(),
                "Local API exited before readiness"
            );
            // A different process may already answer /api/health on this port. The
            // host emits its listening address only after acquiring the real socket.
            if !listening {
                for line in (&mut log).lines() {
                    let line = line?;
                    if line.starts_with("Rust ") && line.ends_with(&marker) {
                        listening = true;
                        break;
                    }
                }
            }
            if listening
                && http
                    .get(&url)
                    .send()
                    .await
                    .is_ok_and(|r| r.status().is_success())
            {
                return Ok::<(), anyhow::Error>(());
            }
            sleep(POLL).await;
        }
    })
    .await
    .context("Local API readiness timed out")?
}

async fn bootstrap(
    directory: &Path,
    topology: &mut Topology,
    children: &mut Children<'_>,
) -> Result<()> {
    let policy: workspace_cache_budget::Policy =
        serde_json::from_value(topology.memory_cache.clone().unwrap_or_else(|| json!({})))?;
    let budget = policy.resolve(topology.services.len())?;
    let memory_cache = json!({"totalMiB":budget.total_mi_b,"instances":budget.instances});
    let storage = &topology.storage;
    let rustfs = std::env::var_os("RUSTFS_BINARY").unwrap_or_else(|| "rustfs".into());
    let version = Command::new(&rustfs)
        .arg("--version")
        .output()
        .await
        .context("Install RustFS 1.0.4 or set RUSTFS_BINARY")?;
    ensure!(
        version.status.success()
            && String::from_utf8_lossy(&version.stdout)
                .split_whitespace()
                .take(2)
                .eq(["rustfs", "1.0.4"]),
        "RustFS 1.0.4 is required"
    );
    let s3 = LocalS3::new(
        &storage.endpoint,
        &storage.region,
        &storage.access_key_id,
        &storage.secret_access_key,
    )?;
    let endpoint = reqwest::Url::parse(&storage.endpoint)?;
    let address = format!(
        "{}:{}",
        endpoint.host_str().context("Missing local S3 host")?,
        endpoint
            .port_or_known_default()
            .context("Missing local S3 port")?
    );
    children.start(
        Command::new(&rustfs)
            .args(["server", "--address", &address, "--access-key-file"])
            .arg(&topology.access_key_file)
            .arg("--secret-key-file")
            .arg(&topology.secret_key_file)
            .args(["--region", &storage.region])
            .arg(directory.join("objects"))
            .env("RUSTFS_CONSOLE_ENABLE", "false"),
        "rustfs",
    )?;
    retry(async || {
        s3.request(reqwest::Method::GET, "/", Vec::new())
            .await?
            .error_for_status()?;
        Ok(())
    })
    .await?;
    let mut readiness = FuturesUnordered::new();
    for (index, service) in topology.services.iter().enumerate() {
        if !service.initialized {
            let config: Value = read(&service.config_file)?;
            let bucket = config["s3"]["bucket"]
                .as_str()
                .context("Missing metadata bucket")?;
            retry(async || s3.create_bucket(bucket).await).await?;
        }
        service_plan(service, &memory_cache)?;
        children.role(
            &topology.binary,
            &service.plan_file,
            &service.authority_id.replace(':', "-"),
        )?;
        let client = service.client.clone();
        readiness.push(async move {
            (
                index,
                retry(async || RemoteMetadata::connect(client.clone()).await).await,
            )
        });
    }
    let mut global = None;
    let mut available = 0;
    let mut api = None;
    while let Some((index, result)) = readiness.next().await {
        let service = &mut topology.services[index];
        let Ok(client) = result else {
            eprintln!(
                "{} unavailable. Inspect its private log.",
                service.authority_id
            );
            continue;
        };
        available += 1;
        service.initialized = true;
        service_plan(service, &memory_cache)?;
        println!("{} ready", service.authority_id);
        topology.save(directory)?;
        if index == 0 {
            global = Some(client);
        }
        if index == 1 {
            let mut config: Value = read(&topology.api_config_file)?;
            config["initializeWorkspace"] = json!(!topology.workspace_initialized);
            save(&topology.api_config_file, &config)?;
            children.role(&topology.binary, &topology.api_plan_file, "rust-api")?;
            api = Some((children.children.len() - 1, config));
        }
    }
    ensure!(available > 0, "No metadata authority could start");
    if let Some((index, mut config)) = api {
        let bind = config["bind"]
            .as_str()
            .context("Missing API address")?
            .to_owned();
        match api_ready(&mut children.children[index], directory, &bind).await {
            Ok(()) => {
                config["initializeWorkspace"] = json!(false);
                save(&topology.api_config_file, &config)?;
                topology.workspace_initialized = true;
                topology.save(directory)?;
                println!("Regional API ready at http://{bind}/api/health");
            }
            Err(_) => eprintln!("Regional API unavailable. Inspect rust-api.log."),
        }
    }
    if let Some(global) = global {
        register_descriptors(&global, &topology.services[1..]).await;
    }
    Ok(())
}

fn read_owner(directory: &Path) -> Result<Option<Uuid>> {
    let lock = directory.join("runtime.lock");
    if !lock.try_exists()? {
        return Ok(None);
    }
    let owner: Value = read(&lock.join("owner.json"))
        .context("Runtime lock has no verified owner; inspect local processes")?;
    Ok(Some(
        owner["id"]
            .as_str()
            .context("Runtime lock requires manual reconciliation")?
            .parse()?,
    ))
}

fn stop_file(directory: &Path, owner: Uuid) -> PathBuf {
    directory.join("runtime.lock").join(format!("stop-{owner}"))
}

pub(super) fn status(directory: &Path) -> Result<()> {
    Topology::load(directory)?;
    if read_owner(directory)?.is_some() {
        let owner_file = fs::File::open(directory.join("runtime.lock/owner.json"))?;
        match owner_file.try_lock() {
            Ok(()) => bail!(
                "Supervisor exited with an outstanding lock; reconcile local processes and ownership"
            ),
            Err(std::fs::TryLockError::WouldBlock) => println!("running"),
            Err(e) => return Err(e.into()),
        }
    } else {
        println!("stopped");
    }
    Ok(())
}

pub(super) async fn stop(directory: &Path) -> Result<()> {
    Topology::load(directory)?;
    let Some(owner) = read_owner(directory)? else {
        println!("stopped");
        return Ok(());
    };
    let file = fs::File::open(directory.join("runtime.lock/owner.json"))?;
    match file.try_lock() {
        Ok(()) => {
            bail!("Supervisor exited with an outstanding lock; reconcile ownership before restart")
        }
        Err(std::fs::TryLockError::WouldBlock) => (),
        Err(e) => return Err(e.into()),
    }
    match OpenOptions::new()
        .write(true)
        .mode(0o600)
        .create_new(true)
        .open(stop_file(directory, owner))
    {
        Ok(_) => (),
        Err(e) if matches!(e.kind(), ErrorKind::AlreadyExists | ErrorKind::NotFound) => (),
        Err(e) => return Err(e.into()),
    }
    timeout(Duration::from_secs(300), async {
        while read_owner(directory)? == Some(owner) {
            sleep(POLL).await;
        }
        Ok::<(), anyhow::Error>(())
    })
    .await
    .context("Local supervisor did not confirm shutdown; inspect private logs")??;
    println!("stopped");
    Ok(())
}

pub(super) async fn serve(directory: &Path, mut topology: Topology) -> Result<()> {
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let lock = directory.join("runtime.lock");
    config::mkdir(&lock, false)
        .context("Local runtime is already locked. Use local status or inspect ownership")?;
    let owner = Uuid::new_v4();
    let owner_path = lock.join("owner.json");
    // Hold an OS lock while running. A crash leaves evidence and cannot silently start new writers.
    let owner_file = (|| -> Result<fs::File> {
        let mut owner_file = tempfile::NamedTempFile::new_in(&lock)?;
        owner_file.as_file().lock()?;
        serde_json::to_writer(
            &mut owner_file,
            &json!({"id":owner.to_string(),"pid":std::process::id()}),
        )?;
        owner_file.as_file().sync_all()?;
        Ok(owner_file.persist(owner_path)?)
    })();
    let _owner_file = match owner_file {
        Ok(file) => file,
        Err(err) => {
            fs::remove_dir_all(&lock)?;
            return Err(err);
        }
    };
    let stop_request = stop_file(directory, owner);
    let shutdown = tokio::spawn(async move {
        tokio::select! {
            _ = terminate.recv() => Ok(()),
            _ = interrupt.recv() => Ok(()),
            res = async {
                while !stop_request.try_exists()? { sleep(POLL).await; }
                Ok::<(), std::io::Error>(())
            } => res,
        }
    });
    let mut children = Children {
        directory,
        children: Vec::new(),
    };
    let result = bootstrap(directory, &mut topology, &mut children).await;
    // Finish opening writers before draining so a signal during startup cannot strand their leases.
    let stopped = if result.is_ok() {
        shutdown
            .await
            .map_err(anyhow::Error::from)
            .and_then(|event| Ok(event?))
    } else {
        shutdown.abort();
        Ok(())
    };
    children.drain().await?;
    fs::remove_dir_all(lock)?;
    result.and(stopped)
}
