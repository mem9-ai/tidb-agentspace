use anyhow::{Result, bail};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};
use workspace_meta_client::private_file;
use workspace_meta_service::config::Config as MetaConfig;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Deployment {
    format: u32,
    services: Vec<Role>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Role {
    Metadata {
        #[serde(rename = "configFile")]
        config_file: PathBuf,
        #[serde(default)]
        initialize: bool,
        #[serde(rename = "recoverOwner")]
        recover_owner: Option<String>,
    },
    Workspace {
        #[serde(rename = "configFile")]
        config_file: PathBuf,
    },
}
pub struct MetadataPlan {
    pub config: MetaConfig,
    pub initialize: bool,
    pub recover_owner: Option<String>,
}
pub struct Plan {
    pub metadata: Vec<MetadataPlan>,
    pub workspaces: Vec<workspace_api::Config>,
}
impl Plan {
    pub fn load(path: &Path) -> Result<Self> {
        let deployment: Deployment = serde_json::from_slice(&private_file(path)?)
            .map_err(|_| anyhow::anyhow!("Invalid private deployment configuration"))?;
        if deployment.format != 1
            || deployment.services.is_empty()
            || deployment.services.len() > 64
        {
            bail!("Use deployment format 1 with 1–64 real service roles");
        }
        let mut result = Self {
            metadata: Vec::new(),
            workspaces: Vec::new(),
        };
        let mut authorities = BTreeSet::new();
        let mut installations = BTreeSet::new();
        let mut keys = BTreeSet::new();
        let mut tokens = BTreeSet::new();
        let mut binds = BTreeSet::new();
        let mut roots: Vec<(String, String, String)> = Vec::new();
        let mut workspace_authorities = BTreeSet::new();
        for service in deployment.services {
            match service {
                Role::Metadata {
                    config_file,
                    initialize,
                    recover_owner,
                } => {
                    if !config_file.is_absolute() {
                        bail!("Use absolute private configuration references");
                    }
                    let config = MetaConfig::load(&config_file)?;
                    let endpoint = reqwest::Url::parse(&config.s3.endpoint)?
                        .to_string()
                        .trim_end_matches('/')
                        .to_owned();
                    let key_text = String::from_utf8(private_file(&config.encryption_key_file)?)?;
                    let key_material = hex::decode(key_text.trim())?;
                    if key_material.len() != 32 {
                        bail!("Use a 32-byte metadata encryption key");
                    }
                    let token_text = String::from_utf8(private_file(&config.token_file)?)?;
                    if !authorities.insert(config.authority_id.clone())
                        || !installations.insert(config.installation_id.clone())
                        || !keys.insert(hex::encode(Sha256::digest(&key_material)))
                        || !tokens.insert(hex::encode(Sha256::digest(token_text.trim().as_bytes())))
                        || !binds.insert(config.bind)
                    {
                        bail!("Metadata authority, identity, key, token or listener is shared");
                    }
                    let prefix = &config.s3.prefix;
                    if roots.iter().any(|(e, b, p)| {
                        e == &endpoint
                            && b == &config.s3.bucket
                            && (p == prefix
                                || p.starts_with(&(prefix.clone() + "/"))
                                || prefix.starts_with(&(p.clone() + "/")))
                    }) {
                        bail!("Metadata storage roots overlap");
                    }
                    roots.push((endpoint, config.s3.bucket.clone(), prefix.clone()));
                    result.metadata.push(MetadataPlan {
                        config,
                        initialize,
                        recover_owner,
                    });
                }
                Role::Workspace { config_file } => {
                    if !config_file.is_absolute() {
                        bail!("Use absolute private configuration references");
                    }
                    let config = workspace_api::Config::load(&config_file)?;
                    if !binds.insert(config.bind)
                        || !workspace_authorities.insert(config.authority_id.clone())
                    {
                        bail!("Workspace authority or listener is duplicated");
                    }
                    result.workspaces.push(config);
                }
            }
        }
        for config in &result.workspaces {
            if let workspace_api::MetaBinding::InProcess { authority_id } = &config.metadata
                && !authorities.contains(authority_id)
            {
                bail!("An in-process dependency must be explicitly hosted");
            }
        }
        Ok(result)
    }
}
