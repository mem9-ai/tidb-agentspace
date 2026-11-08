use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    fs::{self, DirBuilder, File},
    io::Write,
    net::TcpListener,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
};
use workspace_meta_client::{ClientConfig, private_file};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Storage {
    pub endpoint: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Service {
    pub authority_id: String,
    pub config_file: PathBuf,
    pub plan_file: PathBuf,
    pub initialized: bool,
    pub client: ClientConfig,
    pub descriptor: Value,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Topology {
    pub format: usize,
    pub binary: PathBuf,
    pub access_key_file: PathBuf,
    pub secret_key_file: PathBuf,
    pub storage: Storage,
    pub services: Vec<Service>,
    pub api_config_file: PathBuf,
    pub api_plan_file: PathBuf,
    pub workspace_initialized: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_cache: Option<Value>,
}

pub(super) fn read<T: DeserializeOwned>(path: &Path) -> Result<T> {
    serde_json::from_slice(&private_file(path)?).context("Invalid private runtime configuration")
}

fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("Missing runtime directory")?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

pub(super) fn save(path: &Path, value: &impl Serialize) -> Result<()> {
    write(path, &serde_json::to_vec_pretty(value)?)
}

pub(super) fn mkdir(path: &Path, recursive: bool) -> std::io::Result<()> {
    DirBuilder::new()
        .mode(0o700)
        .recursive(recursive)
        .create(path)
}

fn random_hex<const N: usize>() -> Result<String> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|_| anyhow::anyhow!("Random key generation failed"))?;
    Ok(hex::encode(bytes))
}

impl Topology {
    pub fn load(directory: &Path) -> Result<Self> {
        let topology: Self = read(&directory.join("topology.json"))
            .context("Run local init for a fresh private directory")?;
        ensure!(
            topology.format == 2
                && topology.services.len() >= 2
                && topology.services[0].authority_id == "global",
            "Invalid local topology"
        );
        Ok(topology)
    }

    pub fn save(&self, directory: &Path) -> Result<()> {
        save(&directory.join("topology.json"), self)
    }
}

pub(super) fn init(directory: &Path, port: u16, workspace: &str, binary: &Path) -> Result<()> {
    ensure!(
        port != 0
            && workspace.strip_prefix("ws_").is_some_and(|s| !s.is_empty()
                && s.len() <= 60
                && s.bytes().all(|b| b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || matches!(b, b'_' | b'-'))),
        "Use a valid API port and Workspace identity"
    );
    let directory = std::path::absolute(directory)?;
    mkdir(
        directory
            .parent()
            .context("Missing runtime directory parent")?,
        true,
    )?;
    mkdir(&directory, false).context("Local initialization requires a new directory")?;
    let result = init_fresh(&directory, port, workspace, binary);
    if result.is_err() {
        fs::remove_dir_all(&directory).context("Failed to clean up incomplete initialization")?;
    }
    result
}

fn init_fresh(directory: &Path, port: u16, workspace: &str, binary: &Path) -> Result<()> {
    mkdir(&directory.join("objects"), false)?;
    // Reserve every listener together so ephemeral ports cannot collide inside this topology.
    let mut reserved = Vec::new();
    let mut address = || -> Result<std::net::SocketAddr> {
        loop {
            let listener = TcpListener::bind(("127.0.0.1", 0))?;
            let addr = listener.local_addr()?;
            reserved.push(listener);
            if addr.port() != port {
                return Ok(addr);
            }
        }
    };
    let storage = Storage {
        endpoint: format!("http://{}", address()?),
        region: "us-east-1".into(),
        access_key_id: format!("local{}", random_hex::<10>()?),
        secret_access_key: random_hex::<32>()?,
    };
    let access_key_file = directory.join("s3-access");
    let secret_key_file = directory.join("s3-secret");
    write(&access_key_file, storage.access_key_id.as_bytes())?;
    write(&secret_key_file, storage.secret_access_key.as_bytes())?;
    let mut services = Vec::new();
    for authority in ["global", "region:local-compat", "region:local-secondary"] {
        let name = authority.replace(':', "-");
        let installation = format!("meta-{name}-{}", random_hex::<6>()?);
        let key_id = format!("{installation}-key-v1");
        let token = directory.join(format!("{name}-token"));
        let key = directory.join(format!("{name}-key"));
        write(&token, random_hex::<32>()?.as_bytes())?;
        write(&key, random_hex::<32>()?.as_bytes())?;
        let bind = address()?;
        let config_file = directory.join(format!("{name}.json"));
        let mut s3 = serde_json::to_value(&storage)?;
        s3["prefix"] = json!("metadata");
        s3["bucket"] = json!(installation);
        save(
            &config_file,
            &json!({"authorityId":authority,"installationId":installation,
            "environment":"local","bind":bind,"s3":s3,"tokenFile":token,
            "encryptionKeyFile":key,"encryptionKeyId":key_id,"insecureLoopback":true}),
        )?;
        let client = ClientConfig {
            origin: format!("http://{bind}"),
            authority_id: authority.into(),
            installation_id: installation.clone(),
            token_file: token,
            insecure_loopback: true,
            tls: None,
        };
        let descriptor = json!({"regionId":authority.strip_prefix("region:").unwrap_or(authority),
            "metaDeploymentId":installation,"engine":"slatedb","engineRelease":"0.18.0","formatVersion":2,
            "mainStorage":{"provider":"rustfs","endpoint":storage.endpoint,"region":"local","signingRegion":storage.region,"bucket":installation,"prefix":"metadata"},
            "encryptionKeyRef":key_id});
        services.push(Service {
            authority_id: authority.into(),
            config_file,
            plan_file: directory.join(format!("{name}-plan.json")),
            initialized: false,
            client,
            descriptor,
        });
    }
    let api_config_file = directory.join("rust-api.json");
    let api_plan_file = directory.join("rust-api-plan.json");
    save(
        &api_config_file,
        &json!({"bind":format!("127.0.0.1:{port}"),"workspaceId":workspace,
        "authorityId":services[1].authority_id, "initializeWorkspace":true,"metadata":{"transport":"remote","client":services[1].client},
        "insecureLoopback":true, "consoleOrigins":["http://127.0.0.1:5173","http://localhost:5173","http://127.0.0.1:4173","http://localhost:4173"],
        "product":{}}),
    )?;
    save(
        &api_plan_file,
        &json!({"format":1,"services":[{"kind":"workspace","configFile":api_config_file}]}),
    )?;
    Topology {
        format: 2,
        binary: std::path::absolute(binary)?,
        storage,
        access_key_file,
        secret_key_file,
        services,
        api_config_file,
        api_plan_file,
        workspace_initialized: false,
        memory_cache: None,
    }
    .save(directory)?;
    println!(
        "Initialized {}. The local API will listen on http://127.0.0.1:{port}",
        directory.display()
    );
    Ok(())
}
