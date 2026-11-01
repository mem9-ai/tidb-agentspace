//! Internal Global-to-Region policy transport. It acknowledges durable storage only;
//! a separate serving-node fence is required before reporting policy as applied. Recovery
//! also requires an independently protected policy anti-rollback checkpoint.
//! Region never calls Global. This is not a customer OpenAPI service.
use crate::policy_command::{PolicyCommandVerifier, PolicyReceipt};
use anyhow::{Result, bail, ensure};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
};
use reqwest::{Certificate, Client, Identity, Url, redirect, retry, tls};
use rustls::{
    DigitallySignedStruct, DistinguishedName, Error as TlsError, SignatureScheme,
    client::danger::HandshakeSignatureValid,
    pki_types::{CertificateDer, UnixTime},
    server::danger::{ClientCertVerified, ClientCertVerifier},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    future::Future,
    net::SocketAddr,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::Duration,
};
use tokio::sync::Semaphore;
use workspace_contracts::ServiceError;
use workspace_identity::regional_key_policy::KeyPolicies;
use workspace_meta_client::private_file;

const CONTROL_PATH: &str = "/internal/v1/region-key-policy-commands";
const MAX_BODY: usize = 24 * 1024;

/// An implementation must reject rollback and untrusted regional time. A plain wall clock
/// is not a production implementation of this contract.
pub trait TrustedRegionalClock: Send + Sync {
    fn now(&self) -> workspace_contracts::Result<i64>;
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerTls {
    pub bind: SocketAddr,
    pub certificate_file: PathBuf,
    pub private_key_file: PathBuf,
    pub client_ca_file: PathBuf,
    /// Exact authorized Global service leaf certificates; CA trust alone is insufficient.
    pub global_client_certificates: Vec<PathBuf>,
}

#[derive(Debug)]
struct PinnedClient {
    inner: Arc<dyn ClientCertVerifier>,
    fingerprints: Vec<[u8; 32]>,
}

impl ClientCertVerifier for PinnedClient {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        self.inner.root_hint_subjects()
    }
    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        now: UnixTime,
    ) -> std::result::Result<ClientCertVerified, TlsError> {
        let verified = self
            .inner
            .verify_client_cert(end_entity, intermediates, now)?;
        let hash: [u8; 32] = Sha256::digest(end_entity.as_ref()).into();
        if !self.fingerprints.contains(&hash) {
            return Err(TlsError::General("untrusted control client".into()));
        }
        Ok(verified)
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, TlsError> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, TlsError> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

fn certificates(path: &Path) -> Result<Vec<CertificateDer<'static>>> {
    ensure!(path.is_absolute(), "TLS certificate path must be absolute");
    let values = rustls_pemfile::certs(&mut std::io::Cursor::new(fs::read(path)?))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ensure!(!values.is_empty(), "TLS certificate is missing");
    Ok(values)
}

/// A Region application boundary drains local request leases, validates concrete ownership,
/// stores the signed policy and its security checkpoint before acknowledging application.
pub trait PolicyInstaller: Send + Sync {
    fn apply<'a>(
        &'a self,
        command: &'a str,
        now: i64,
    ) -> Pin<Box<dyn Future<Output = workspace_contracts::Result<PolicyReceipt>> + Send + 'a>>;
}

#[derive(Clone)]
struct StateData {
    verifier: Arc<PolicyCommandVerifier>,
    policies: Arc<KeyPolicies>,
    clock: Arc<dyn TrustedRegionalClock>,
    capacity: Arc<Semaphore>,
    installer: Option<Arc<dyn PolicyInstaller>>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CommandBody {
    command: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredResponse {
    status: String,
    receipt: PolicyReceipt,
}

async fn bounded_request(request: Request, next: Next) -> Response {
    match tokio::time::timeout(Duration::from_secs(15), next.run(request)).await {
        Ok(response) => response,
        Err(_) => StatusCode::REQUEST_TIMEOUT.into_response(),
    }
}

async fn receive(
    State(state): State<StateData>,
    Json(body): Json<CommandBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Ok(_permit) = state.capacity.try_acquire() else {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error":{"code":"CONTROL_BUSY"}})),
        );
    };
    let result = match state.clock.now() {
        Ok(now) => {
            if let Some(installer) = &state.installer {
                installer.apply(&body.command, now).await
            } else {
                state
                    .verifier
                    .apply(&body.command, now, &state.policies)
                    .await
            }
        }
        Err(e) => Err(e),
    };
    match result {
        Ok(receipt) => (
            StatusCode::ACCEPTED,
            Json(
                serde_json::json!({"status":if state.installer.is_some(){"applied"}else{"stored"},"receipt":receipt}),
            ),
        ),
        Err(e) => {
            let (status, code) = match e.status {
                400 => (StatusCode::BAD_REQUEST, "INVALID_POLICY_COMMAND"),
                401 => (StatusCode::UNAUTHORIZED, "INVALID_POLICY_COMMAND"),
                409 => (StatusCode::CONFLICT, "POLICY_CONFLICT"),
                429 => (StatusCode::TOO_MANY_REQUESTS, "CONTROL_BUSY"),
                _ => (StatusCode::SERVICE_UNAVAILABLE, "CONTROL_UNAVAILABLE"),
            };
            (status, Json(serde_json::json!({"error":{"code":code}})))
        }
    }
}

pub struct PolicyControlServer {
    tls: ServerTls,
    config: Arc<rustls::ServerConfig>,
    state: StateData,
}

impl PolicyControlServer {
    pub fn new(
        tls: ServerTls,
        verifier: Arc<PolicyCommandVerifier>,
        policies: Arc<KeyPolicies>,
        clock: Arc<dyn TrustedRegionalClock>,
    ) -> Result<Self> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        ensure!(
            (1..=8).contains(&tls.global_client_certificates.len()),
            "Authorized Global certificates are required"
        );
        ensure!(
            tls.private_key_file.is_absolute(),
            "TLS key path must be absolute"
        );
        let mut roots = rustls::RootCertStore::empty();
        for cert in certificates(&tls.client_ca_file)? {
            roots.add(cert)?;
        }
        let inner = rustls::server::WebPkiClientVerifier::builder(Arc::new(roots)).build()?;
        let mut fingerprints = Vec::new();
        for path in &tls.global_client_certificates {
            let certs = certificates(path)?;
            ensure!(
                certs.len() == 1,
                "Each Global pin must contain one leaf certificate"
            );
            fingerprints.push(Sha256::digest(certs[0].as_ref()).into());
        }
        let client_verifier = Arc::new(PinnedClient {
            inner,
            fingerprints,
        });
        let certs = certificates(&tls.certificate_file)?;
        let key = rustls_pemfile::private_key(&mut std::io::Cursor::new(private_file(
            &tls.private_key_file,
        )?))?
        .ok_or_else(|| anyhow::anyhow!("TLS private key missing"))?;
        let config =
            rustls::ServerConfig::builder_with_protocol_versions(&[&rustls::version::TLS13])
                .with_client_cert_verifier(client_verifier)
                .with_single_cert(certs, key)?;
        Ok(Self {
            tls,
            config: Arc::new(config),
            state: StateData {
                verifier,
                policies,
                clock,
                capacity: Arc::new(Semaphore::new(8)),
                installer: None,
            },
        })
    }

    pub fn with_installer(mut self, installer: Arc<dyn PolicyInstaller>) -> Self {
        self.state.installer = Some(installer);
        self
    }

    pub async fn serve(
        self,
        stop: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> Result<()> {
        let app = Router::new()
            .route(CONTROL_PATH, post(receive))
            .layer(DefaultBodyLimit::max(MAX_BODY))
            .layer(middleware::from_fn(bounded_request))
            .with_state(self.state);
        let handle = axum_server::Handle::new();
        let shutdown = handle.clone();
        tokio::spawn(async move {
            stop.await;
            shutdown.graceful_shutdown(Some(Duration::from_secs(20)));
        });
        axum_server::bind_rustls(
            self.tls.bind,
            axum_server::tls_rustls::RustlsConfig::from_config(self.config),
        )
        .handle(handle)
        .serve(app.into_make_service())
        .await?;
        Ok(())
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientTls {
    pub ca_file: PathBuf,
    pub certificate_file: PathBuf,
    pub private_key_file: PathBuf,
}

pub struct PolicyControlClient {
    client: Client,
    endpoint: Url,
    region_id: String,
}

impl PolicyControlClient {
    pub fn new(origin: &str, region_id: &str, tls: ClientTls) -> Result<Self> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let url = Url::parse(origin)?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || !region_id.starts_with("region:")
            || region_id.len() <= 7
            || region_id.len() > 107
            || !region_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
        {
            bail!("Invalid Region control origin or identity");
        }
        ensure!(
            tls.ca_file.is_absolute()
                && tls.certificate_file.is_absolute()
                && tls.private_key_file.is_absolute(),
            "TLS paths must be absolute"
        );
        let identity = Identity::from_pem(
            &[
                fs::read(&tls.certificate_file)?,
                b"\n".to_vec(),
                private_file(&tls.private_key_file)?,
            ]
            .concat(),
        )?;
        let client = Client::builder()
            .no_proxy()
            .redirect(redirect::Policy::none())
            .retry(retry::never())
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(5))
            .tls_version_min(tls::Version::TLS_1_3)
            .tls_version_max(tls::Version::TLS_1_3)
            .tls_certs_only(Certificate::from_pem_bundle(&fs::read(tls.ca_file)?)?)
            .identity(identity)
            .build()?;
        Ok(Self {
            client,
            endpoint: url.join(CONTROL_PATH)?,
            region_id: region_id.into(),
        })
    }

    /// An error after sending has an unknown outcome. Callers reconcile using the same
    /// immutable command ID; this method never automatically retries or reports applied.
    pub async fn store(
        &self,
        command: &str,
        expected: &PolicyReceipt,
    ) -> workspace_contracts::Result<PolicyReceipt> {
        self.send(command, expected, "stored").await
    }
    pub async fn apply(
        &self,
        command: &str,
        expected: &PolicyReceipt,
    ) -> workspace_contracts::Result<PolicyReceipt> {
        self.send(command, expected, "applied").await
    }
    async fn send(
        &self,
        command: &str,
        expected: &PolicyReceipt,
        status: &str,
    ) -> workspace_contracts::Result<PolicyReceipt> {
        if command.is_empty() || command.len() > 16 * 1024 || expected.region_id != self.region_id {
            return Err(ServiceError::new(400, "INVALID_POLICY_COMMAND"));
        }
        let uncertain = || ServiceError::new(503, "POLICY_DELIVERY_UNKNOWN");
        let mut response = self
            .client
            .post(self.endpoint.clone())
            .json(&CommandBody {
                command: command.into(),
            })
            .send()
            .await
            .map_err(|_| uncertain())?;
        if response.status() != StatusCode::ACCEPTED {
            return Err(uncertain());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| uncertain())? {
            if bytes.len() + chunk.len() > 4096 {
                return Err(uncertain());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: StoredResponse = serde_json::from_slice(&bytes).map_err(|_| uncertain())?;
        let mut observed = value.receipt.clone();
        observed.continuity = None;
        let mut baseline = expected.clone();
        baseline.continuity = None;
        if value.status != status
            || observed != baseline
            || expected.continuity.is_some() && expected.continuity != value.receipt.continuity
        {
            return Err(uncertain());
        }
        Ok(value.receipt)
    }
}
