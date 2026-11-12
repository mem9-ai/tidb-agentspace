use anyhow::{Result, bail};
use reqwest::{Certificate, Client, Identity, Url, redirect, retry, tls};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use workspace_contracts::{Call, MetaRequest, Metadata, ServiceError};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientConfig {
    pub origin: String,
    pub authority_id: String,
    pub installation_id: String,
    pub token_file: PathBuf,
    #[serde(default)]
    pub insecure_loopback: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tls: Option<ClientTls>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientTls {
    pub ca_file: PathBuf,
    pub certificate_file: PathBuf,
    pub private_key_file: PathBuf,
}
pub fn private_file(path: &Path) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("Use an owner-only ordinary file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            bail!("Use an owner-only ordinary file");
        }
    }
    Ok(fs::read(path)?)
}
pub struct RemoteMetadata {
    config: ClientConfig,
    client: Client,
    token: String,
    origin: Url,
}
impl RemoteMetadata {
    pub async fn connect(config: ClientConfig) -> Result<Self> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let origin = Url::parse(&config.origin)?;
        if !origin.username().is_empty()
            || origin.password().is_some()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
        {
            bail!("Use an explicit metadata origin");
        }
        let local =
            ["127.0.0.1", "localhost", "[::1]"].contains(&origin.host_str().unwrap_or_default());
        if origin.scheme() != "https"
            && !(origin.scheme() == "http" && local && config.insecure_loopback)
        {
            bail!("Metadata transport requires HTTPS outside loopback tests");
        }
        if origin.scheme() == "http" && config.tls.is_some() {
            bail!("Ambiguous transport configuration");
        }
        let token = String::from_utf8(private_file(&config.token_file)?)?
            .trim()
            .to_owned();
        if token.len() < 32 || config.authority_id.is_empty() || config.installation_id.is_empty() {
            bail!("Incomplete metadata identity");
        }
        let mut client = Client::builder()
            .no_proxy()
            .redirect(redirect::Policy::none())
            .retry(retry::never())
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(5));
        if origin.scheme() == "https" {
            let tls = config
                .tls
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Metadata requires mutual TLS"))?;
            client = client
                .tls_version_min(tls::Version::TLS_1_3)
                .tls_version_max(tls::Version::TLS_1_3)
                .tls_certs_only(Certificate::from_pem_bundle(&fs::read(&tls.ca_file)?)?)
                .identity(Identity::from_pem(
                    &[
                        fs::read(&tls.certificate_file)?,
                        b"\n".to_vec(),
                        private_file(&tls.private_key_file)?,
                    ]
                    .concat(),
                )?);
        }
        let result = Self {
            config,
            client: client.build()?,
            token,
            origin,
        };
        result.health().await?;
        Ok(result)
    }
    async fn call(&self, request: Option<MetaRequest>) -> workspace_contracts::Result<Value> {
        let write = matches!(request, Some(MetaRequest::Commit { .. }));
        // A transport failure can arrive after Meta made a write durable. Preserve that
        // distinction so the caller can resolve the original mutation ID.
        let failure = || {
            ServiceError::new(
                503,
                if write {
                    "META_COMMIT_UNKNOWN"
                } else {
                    "META_UNAVAILABLE"
                },
            )
        };
        let url = self
            .origin
            .join(if request.is_some() {
                "/v1/meta"
            } else {
                "/health"
            })
            .map_err(|_| failure())?;
        let mut call = if request.is_some() {
            self.client.post(url)
        } else {
            self.client.get(url)
        };
        call = call
            .bearer_auth(&self.token)
            .header("X-Meta-Authority", &self.config.authority_id)
            .header("X-Meta-Installation", &self.config.installation_id);
        if let Some(input) = request {
            call = call.json(&input);
        }
        let mut response = call.send().await.map_err(|_| failure())?;
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| failure())? {
            if bytes.len() + chunk.len() > 25 * 1024 * 1024 {
                return Err(ServiceError::new(503, "META_RESPONSE_TOO_LARGE"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| failure())?;
        if status != 200 {
            let code = value["error"]["code"]
                .as_str()
                .filter(|v| v.len() <= 80 && v.bytes().all(|b| b.is_ascii_uppercase() || b == b'_'))
                .unwrap_or("META_UNAVAILABLE");
            return Err(ServiceError::new(status, code));
        }
        Ok(value)
    }
}
impl Metadata for RemoteMetadata {
    fn execute(&self, request: MetaRequest) -> Call<'_> {
        Box::pin(self.call(Some(request)))
    }
    fn health(&self) -> Call<'_> {
        Box::pin(async {
            let health = self.call(None).await?;
            if health["authorityId"] != self.config.authority_id
                || health["installationId"] != self.config.installation_id
            {
                return Err(ServiceError::new(503, "META_INSTALLATION_MISMATCH"));
            }
            Ok(health)
        })
    }
}
