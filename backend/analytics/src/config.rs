use anyhow::{Result, ensure};
use serde::Deserialize;
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientTls {
    pub ca_file: PathBuf,
    pub certificate_file: PathBuf,
    pub private_key_file: PathBuf,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientConfig {
    pub endpoint: String,
    pub token_file: PathBuf,
    #[serde(default)]
    pub insecure_loopback: bool,
    pub tls: Option<ClientTls>,
}
impl ClientConfig {
    pub fn validate(&self, local: bool) -> Result<()> {
        let url = reqwest::Url::parse(&self.endpoint)?;
        ensure!(
            url.origin().ascii_serialization() == self.endpoint
                && url.username().is_empty()
                && url.password().is_none()
                && self.token_file.is_absolute(),
            "Invalid analytics endpoint or private token"
        );
        if self.insecure_loopback {
            ensure!(
                local
                    && url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
                    && self.tls.is_none(),
                "Analytics plaintext requires explicit loopback development"
            );
        } else {
            ensure!(
                url.scheme() == "https" && self.tls.is_some(),
                "Analytics requires verified mutual TLS"
            );
        }
        Ok(())
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Storage {
    #[serde(default)]
    pub allow_loopback_http: bool,
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub prefix: String,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalStorage {
    pub directory: PathBuf,
    pub prefix: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerTls {
    pub certificate_file: PathBuf,
    pub private_key_file: PathBuf,
    pub client_ca_file: PathBuf,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub authority_id: String,
    pub installation_id: String,
    pub bind: SocketAddr,
    pub s3: Option<Storage>,
    pub local: Option<LocalStorage>,
    #[serde(default = "default_block_cache_mib")]
    pub block_cache_mib: u16,
    pub token_file: PathBuf,
    pub encryption_key_file: PathBuf,
    pub pseudonym_key_file: PathBuf,
    #[serde(default)]
    pub campaigns: Vec<String>,
    #[serde(default)]
    pub insecure_loopback: bool,
    pub tls: Option<ServerTls>,
}
fn default_block_cache_mib() -> u16 {
    8
}
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
}
pub(crate) fn token(path: &Path) -> Result<String> {
    let value = String::from_utf8(private_file(path)?)?;
    let value = value.trim();
    ensure!(
        value.len() >= 32
            && value.len() <= 128
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)),
        "Invalid private analytics token"
    );
    Ok(value.into())
}
impl Config {
    pub(crate) fn storage_prefix(&self) -> &str {
        match (&self.s3, &self.local) {
            (Some(storage), None) => &storage.prefix,
            (None, Some(storage)) => &storage.prefix,
            _ => "",
        }
    }
    pub fn load(path: &Path) -> Result<Self> {
        let config: Self = serde_json::from_slice(&private_file(path)?)
            .map_err(|_| anyhow::anyhow!("Invalid private analytics configuration"))?;
        config.validate()?;
        Ok(config)
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.block_cache_mib <= 1024,
            "blockCacheMib must be between 0 and 1024 MiB"
        );
        ensure!(
            (self.authority_id == "global"
                || self.authority_id.strip_prefix("region:").is_some_and(id))
                && id(&self.installation_id),
            "Invalid analytics authority or installation"
        );
        ensure!(
            self.storage_prefix().starts_with("analytics/")
                && self.storage_prefix().split('/').all(id),
            "Use a dedicated analytics storage root"
        );
        ensure!(
            self.encryption_key_file.is_absolute()
                && self.pseudonym_key_file.is_absolute()
                && self.token_file.is_absolute()
                && self.encryption_key_file != self.pseudonym_key_file
                && self.encryption_key_file != self.token_file
                && self.token_file != self.pseudonym_key_file,
            "Dedicated analytics secrets required"
        );
        ensure!(
            self.campaigns.len() <= 50
                && self.campaigns.iter().all(|s| !s.is_empty()
                    && s.len() <= 40
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))),
            "Invalid analytics campaigns"
        );
        if self.insecure_loopback {
            ensure!(
                self.bind.ip().is_loopback() && self.tls.is_none(),
                "Analytics plaintext requires explicit loopback development"
            );
        } else {
            ensure!(self.tls.is_some(), "Analytics requires mutual TLS");
        }
        if let Some(local) = &self.local {
            ensure!(
                self.s3.is_none()
                    && local.directory.is_absolute()
                    && local.directory.parent().is_some()
                    && local.directory.components().all(|part| !matches!(
                        part,
                        std::path::Component::ParentDir | std::path::Component::CurDir
                    )),
                "Use one explicit dedicated analytics storage directory"
            );
            return Ok(());
        }
        let s3 = self
            .s3
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Analytics storage required"))?;
        let endpoint = reqwest::Url::parse(&s3.endpoint)?;
        ensure!(
            endpoint.origin().ascii_serialization() == s3.endpoint
                && (endpoint.scheme() == "https"
                    || ((self.insecure_loopback
                        || (s3.allow_loopback_http && self.bind.ip().is_loopback()))
                        && endpoint.scheme() == "http"
                        && matches!(
                            endpoint.host_str(),
                            Some("127.0.0.1" | "localhost" | "[::1]")
                        ))),
            "Invalid analytics object storage endpoint"
        );
        ensure!(
            s3.access_key_id.is_some() == s3.secret_access_key.is_some(),
            "Configure analytics storage credentials together"
        );
        Ok(())
    }
}

pub(crate) fn private_file(path: &Path) -> Result<Vec<u8>> {
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "Analytics secrets require ordinary files"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "Analytics secrets require owner-only permissions"
        );
    }
    Ok(std::fs::read(path)?)
}
