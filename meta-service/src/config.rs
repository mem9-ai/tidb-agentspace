use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
};
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub authority_id: String,
    pub installation_id: String,
    pub environment: String,
    pub bind: SocketAddr,
    pub s3: Storage,
    pub block_cache_mib: Option<u64>,
    pub token_file: PathBuf,
    pub encryption_key_file: PathBuf,
    pub encryption_key_id: String,
    #[serde(default)]
    pub insecure_loopback: bool,
    pub tls: Option<Tls>,
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
pub struct Tls {
    pub certificate_file: PathBuf,
    pub private_key_file: PathBuf,
    pub client_ca_file: PathBuf,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Installation {
    pub format: u32,
    pub authority_id: String,
    pub installation_id: String,
    pub environment: String,
    pub encryption_key_id: String,
    pub key_check: String,
}
pub fn private_file(path: &Path) -> Result<Vec<u8>> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        bail!("Private configuration requires an ordinary file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            bail!("Private configuration requires owner-only permissions");
        }
    }
    Ok(fs::read(path)?)
}
pub fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
        && s != "."
        && s != ".."
}
impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let c: Self = serde_json::from_slice(&private_file(path)?)
            .map_err(|_| anyhow::anyhow!("Invalid private service configuration"))?;
        c.validate()?;
        Ok(c)
    }
    pub fn validate(&self) -> Result<()> {
        let c = self;
        if c.block_cache_mib
            .is_some_and(|mib| mib.checked_mul(1024 * 1024).is_none())
        {
            bail!("blockCacheMib is too large");
        }
        if !valid_id(&c.installation_id)
            || !valid_id(&c.encryption_key_id)
            || !(c.authority_id == "global"
                || c.authority_id.strip_prefix("region:").is_some_and(valid_id))
            || !["local", "test", "production"].contains(&c.environment.as_str())
        {
            bail!("Invalid authority/environment identity");
        }
        if c.s3.prefix.split('/').any(|p| !valid_id(p)) {
            bail!("Use an explicit non-root storage prefix");
        }
        if c.insecure_loopback {
            if !c.bind.ip().is_loopback() || c.environment == "production" || c.tls.is_some() {
                bail!("Insecure transport is only permitted in explicit loopback tests");
            }
        } else if c.tls.is_none() {
            bail!("Hosted service requires mutual TLS");
        }
        if !c.s3.endpoint.starts_with("https://") {
            let local = ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"]
                .iter()
                .any(|p| {
                    c.s3.endpoint
                        .strip_prefix(p)
                        .is_some_and(|v| v.parse::<u16>().is_ok())
                });
            if !(c.insecure_loopback || c.s3.allow_loopback_http)
                || !local
                || c.environment == "production"
                || !c.bind.ip().is_loopback()
            {
                bail!("Object storage requires HTTPS outside loopback tests");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cache_budget_defaults_and_explicit_limits_validate_before_open() {
        let mut input = json!({
            "authorityId": "global", "installationId": "cache-config", "environment": "test",
            "bind": "127.0.0.1:7443", "insecureLoopback": true,
            "s3": {"endpoint": "http://127.0.0.1:9000", "region": "local", "bucket": "test", "prefix": "metadata"},
            "tokenFile": "/unused/token", "encryptionKeyFile": "/unused/key", "encryptionKeyId": "key-v1"
        });
        let config: Config = serde_json::from_value(input.clone()).unwrap();
        assert_eq!(config.block_cache_mib, None);
        config.validate().unwrap();
        for budget in [0, 1, 8, 1024] {
            input["blockCacheMib"] = json!(budget);
            let config: Config = serde_json::from_value(input.clone()).unwrap();
            assert_eq!(config.block_cache_mib, Some(budget));
            config.validate().unwrap();
        }
        for invalid in [json!(-1), json!(1.5), json!("32"), json!(u64::MAX)] {
            input["blockCacheMib"] = invalid;
            let valid = serde_json::from_value::<Config>(input.clone())
                .is_ok_and(|config| config.validate().is_ok());
            assert!(!valid, "Invalid cache budget accepted");
        }
    }
}
