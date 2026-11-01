//! Region-initiated private control connection. Customer data and credentials never flow here.
use crate::{
    global_api::RegionDescriptor,
    policy_command::PolicyReceipt,
    policy_transport::{ClientTls, PolicyInstaller},
};
use anyhow::{Context, Result, bail, ensure};
use rustls::{RootCertStore, pki_types::ServerName};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::{Mutex, mpsc, oneshot},
};
use tokio_rustls::{TlsAcceptor, TlsConnector};
use uuid::Uuid;
use workspace_contracts::ServiceError;
use workspace_identity::onboarding::{Acknowledgement, Command, RegionControl};
use workspace_meta_client::private_file;

const MAX_FRAME: usize = 32 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AllowedRegion {
    pub region_id: String,
    pub certificate_file: PathBuf,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HubConfig {
    pub bind: SocketAddr,
    pub certificate_file: PathBuf,
    pub private_key_file: PathBuf,
    pub client_ca_file: PathBuf,
    pub allowed_regions: Vec<AllowedRegion>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorConfig {
    pub origin: String,
    pub tls: ClientTls,
}
pub struct Connector {
    pub config: ConnectorConfig,
    pub descriptor: RegionDescriptor,
    pub installer: Arc<dyn PolicyInstaller>,
    pub initializer: Arc<dyn RegionControl>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Frame {
    Register {
        region_id: String,
        api_origin: String,
        api_path_prefix: String,
        instance_id: String,
    },
    Registered,
    Policy {
        request_id: String,
        command: String,
    },
    Result {
        request_id: String,
        receipt: Option<PolicyReceipt>,
    },
    Initialize {
        request_id: String,
        command: Command,
    },
    Initialized {
        request_id: String,
        acknowledgement: Option<Acknowledgement>,
    },
    Ping,
    Pong,
}

enum Request {
    Policy {
        command: String,
        expected: PolicyReceipt,
        reply: oneshot::Sender<workspace_contracts::Result<PolicyReceipt>>,
    },
    Initialize {
        command: Command,
        reply: oneshot::Sender<workspace_contracts::Result<Acknowledgement>>,
    },
}
struct Connected {
    generation: Uuid,
    sender: mpsc::Sender<Request>,
}

#[derive(Default)]
pub struct Hub {
    connections: Mutex<BTreeMap<String, Connected>>,
    registered: Mutex<BTreeMap<String, RegionDescriptor>>,
    changed: tokio::sync::Notify,
}

fn unavailable() -> ServiceError {
    ServiceError::new(503, "POLICY_DELIVERY_UNKNOWN")
}

impl Hub {
    pub async fn connected(&self, region: &str) -> bool {
        self.connections.lock().await.contains_key(region)
    }
    pub async fn descriptor(&self, region: &str) -> Option<RegionDescriptor> {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let changed = self.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if let Some(value) = self.registered.lock().await.get(region).cloned() {
                    return value;
                }
                changed.await;
            }
        })
        .await
        .ok()
    }
    async fn sender(&self, region: &str) -> workspace_contracts::Result<mpsc::Sender<Request>> {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let changed = self.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if let Some(value) = self
                    .connections
                    .lock()
                    .await
                    .get(region)
                    .map(|c| c.sender.clone())
                {
                    return value;
                }
                changed.await;
            }
        })
        .await
        .map_err(|_| unavailable())
    }
    pub async fn apply(
        &self,
        region: &str,
        command: &str,
        expected: &PolicyReceipt,
    ) -> workspace_contracts::Result<PolicyReceipt> {
        if command.is_empty() || command.len() > 16 * 1024 || expected.region_id != region {
            return Err(ServiceError::new(400, "INVALID_POLICY_COMMAND"));
        }
        let sender = self.sender(region).await?;
        let (reply, result) = oneshot::channel();
        sender
            .try_send(Request::Policy {
                command: command.into(),
                expected: expected.clone(),
                reply,
            })
            .map_err(|_| unavailable())?;
        tokio::time::timeout(Duration::from_secs(15), result)
            .await
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())?
    }
    pub async fn initialize(
        &self,
        command: &Command,
    ) -> workspace_contracts::Result<Acknowledgement> {
        let sender = self.sender(&command.registration.region_id).await?;
        let (reply, result) = oneshot::channel();
        sender
            .try_send(Request::Initialize {
                command: command.clone(),
                reply,
            })
            .map_err(|_| unavailable())?;
        tokio::time::timeout(Duration::from_secs(15), result)
            .await
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())?
    }
}

pub struct RemoteRegion(pub Arc<Hub>);
impl RegionControl for RemoteRegion {
    fn initialize<'a>(
        &'a self,
        command: &'a Command,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = workspace_contracts::Result<Acknowledgement>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(self.0.initialize(command))
    }
}

fn certs(path: &Path) -> Result<Vec<rustls::pki_types::CertificateDer<'static>>> {
    ensure!(path.is_absolute(), "absolute certificate path required");
    let certs = rustls_pemfile::certs(&mut std::io::Cursor::new(fs::read(path)?))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ensure!(!certs.is_empty(), "certificate required");
    Ok(certs)
}
fn key(path: &Path) -> Result<rustls::pki_types::PrivateKeyDer<'static>> {
    ensure!(path.is_absolute(), "absolute private key path required");
    rustls_pemfile::private_key(&mut std::io::Cursor::new(private_file(path)?))?
        .context("private key required")
}
fn roots(path: &Path) -> Result<RootCertStore> {
    let mut roots = RootCertStore::empty();
    for cert in certs(path)? {
        roots.add(cert)?;
    }
    Ok(roots)
}
async fn read_frame<R: AsyncRead + Unpin>(reader: &mut BufReader<R>) -> Result<Frame> {
    let mut bytes = Vec::new();
    let n = tokio::io::AsyncReadExt::take(reader, (MAX_FRAME + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .await?;
    ensure!(
        n > 0 && n <= MAX_FRAME && bytes.last() == Some(&b'\n'),
        "invalid control frame"
    );
    Ok(serde_json::from_slice(&bytes)?)
}
async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, value: &Frame) -> Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    ensure!(bytes.len() < MAX_FRAME, "control frame too large");
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}

pub async fn serve(
    hub: Arc<Hub>,
    config: HubConfig,
    catalog: Vec<RegionDescriptor>,
    stop: impl std::future::Future<Output = ()>,
) -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    ensure!(
        !config.allowed_regions.is_empty() && config.allowed_regions.len() <= 64,
        "Region identity pins required"
    );
    let mut pins = BTreeMap::new();
    for item in &config.allowed_regions {
        let certificate = certs(&item.certificate_file)?;
        ensure!(
            certificate.len() == 1 && catalog.iter().any(|r| r.region_id == item.region_id),
            "invalid Region identity"
        );
        let digest: [u8; 32] = Sha256::digest(certificate[0].as_ref()).into();
        ensure!(
            pins.insert(digest, item.region_id.clone()).is_none(),
            "duplicate Region certificate"
        );
    }
    let verifier =
        rustls::server::WebPkiClientVerifier::builder(Arc::new(roots(&config.client_ca_file)?))
            .build()?;
    let tls = rustls::ServerConfig::builder_with_protocol_versions(&[&rustls::version::TLS13])
        .with_client_cert_verifier(verifier)
        .with_single_cert(
            certs(&config.certificate_file)?,
            key(&config.private_key_file)?,
        )?;
    let acceptor = TlsAcceptor::from(Arc::new(tls));
    let listener = TcpListener::bind(config.bind).await?;
    let capacity = Arc::new(tokio::sync::Semaphore::new(64));
    tokio::pin!(stop);
    loop {
        tokio::select! {
            _ = &mut stop => return Ok(()),
            connection = listener.accept() => {
                let (socket, _) = connection?;
                let Ok(permit) = capacity.clone().try_acquire_owned() else { continue };
                let acceptor = acceptor.clone(); let pins = pins.clone(); let catalog = catalog.clone(); let hub = hub.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let Ok(Ok(stream)) = tokio::time::timeout(Duration::from_secs(5), acceptor.accept(socket)).await else { return };
                    let Some(peer) = stream.get_ref().1.peer_certificates().and_then(|v| v.first()) else { return };
                    let digest: [u8; 32] = Sha256::digest(peer.as_ref()).into();
                    let Some(region) = pins.get(&digest).cloned() else { return };
                    let _ = serve_region(hub, stream, region, catalog).await;
                });
            }
        }
    }
}

async fn serve_region<S: AsyncRead + AsyncWrite + Unpin>(
    hub: Arc<Hub>,
    stream: S,
    authenticated: String,
    catalog: Vec<RegionDescriptor>,
) -> Result<()> {
    let (reader, mut writer) = tokio::io::split(stream);
    let mut reader = BufReader::new(reader);
    let registration =
        tokio::time::timeout(Duration::from_secs(5), read_frame(&mut reader)).await??;
    let Frame::Register {
        region_id,
        api_origin,
        api_path_prefix,
        instance_id,
    } = registration
    else {
        bail!("registration required")
    };
    ensure!(
        region_id == authenticated && Uuid::parse_str(&instance_id).is_ok(),
        "invalid Region identity"
    );
    ensure!(
        catalog.iter().any(|r| r.region_id == region_id
            && r.api_origin == api_origin
            && r.api_path_prefix == api_path_prefix),
        "unapproved Region endpoint"
    );
    let generation = Uuid::new_v4();
    let (sender, mut receiver) = mpsc::channel::<Request>(8);
    write_frame(&mut writer, &Frame::Registered).await?;
    hub.connections
        .lock()
        .await
        .insert(region_id.clone(), Connected { generation, sender });
    hub.registered.lock().await.insert(
        region_id.clone(),
        RegionDescriptor {
            region_id: region_id.clone(),
            api_origin,
            api_path_prefix,
        },
    );
    hub.changed.notify_waiters();
    let result = async {
        loop {
            let request = tokio::select! {
                item = receiver.recv() => match item { Some(item) => item, None => return Ok(()) },
                _ = tokio::time::sleep(Duration::from_secs(20)) => {
                    write_frame(&mut writer, &Frame::Ping).await?;
                    ensure!(matches!(tokio::time::timeout(Duration::from_secs(10), read_frame(&mut reader)).await??, Frame::Pong), "invalid heartbeat");
                    continue;
                }
            };
            if !hub.connections.lock().await.get(&region_id).is_some_and(|c| c.generation == generation) { break; }
            let request_id = Uuid::new_v4().to_string();
            let failed = match request {
                Request::Policy { command, expected, reply } => {
                    let result = async {
                        write_frame(&mut writer, &Frame::Policy { request_id: request_id.clone(), command }).await?;
                        let Frame::Result { request_id: observed, receipt: Some(receipt) } = tokio::time::timeout(Duration::from_secs(12), read_frame(&mut reader)).await?? else { bail!("policy rejected") };
                        let mut actual = receipt.clone(); actual.continuity = None;
                        let mut expected = expected; expected.continuity = None;
                        ensure!(observed == request_id && actual == expected, "policy receipt mismatch");
                        Ok::<_, anyhow::Error>(receipt)
                    }.await;
                    let failed = result.is_err(); let _ = reply.send(result.map_err(|_| unavailable())); failed
                }
                Request::Initialize { command, reply } => {
                    let result = async {
                        let expected = command.registration.clone();
                        ensure!(expected.region_id == region_id, "wrong Region");
                        write_frame(&mut writer, &Frame::Initialize { request_id: request_id.clone(), command }).await?;
                        let Frame::Initialized { request_id: observed, acknowledgement: Some(ack) } = tokio::time::timeout(Duration::from_secs(12), read_frame(&mut reader)).await?? else { bail!("initialization rejected") };
                        ensure!(observed == request_id && ack.registration == expected && ack.policy_generation == 1, "initialization receipt mismatch");
                        Ok::<_, anyhow::Error>(ack)
                    }.await;
                    let failed = result.is_err(); let _ = reply.send(result.map_err(|_| unavailable())); failed
                }
            };
            if failed { break; }
        }
        Ok(())
    }.await;
    let mut connections = hub.connections.lock().await;
    if connections
        .get(&region_id)
        .is_some_and(|c| c.generation == generation)
    {
        connections.remove(&region_id);
    }
    result
}

pub async fn connect(
    config: ConnectorConfig,
    descriptor: RegionDescriptor,
    installer: Arc<dyn PolicyInstaller>,
    initializer: Arc<dyn RegionControl>,
    stop: tokio_util::sync::CancellationToken,
) -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let url = reqwest::Url::parse(&config.origin)?;
    ensure!(
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none(),
        "invalid Global control origin"
    );
    let host = url.host_str().context("control host required")?.to_owned();
    let port = url
        .port_or_known_default()
        .context("control port required")?;
    let server = ServerName::try_from(host.clone())?;
    let tls = rustls::ClientConfig::builder_with_protocol_versions(&[&rustls::version::TLS13])
        .with_root_certificates(roots(&config.tls.ca_file)?)
        .with_client_auth_cert(
            certs(&config.tls.certificate_file)?,
            key(&config.tls.private_key_file)?,
        )?;
    let connector = TlsConnector::from(Arc::new(tls));
    loop {
        let attempt = async {
            let socket = tokio::time::timeout(
                Duration::from_secs(5),
                TcpStream::connect((host.as_str(), port)),
            )
            .await??;
            let stream = tokio::time::timeout(
                Duration::from_secs(5),
                connector.connect(server.clone(), socket),
            )
            .await??;
            let (reader, mut writer) = tokio::io::split(stream);
            let mut reader = BufReader::new(reader);
            write_frame(
                &mut writer,
                &Frame::Register {
                    region_id: descriptor.region_id.clone(),
                    api_origin: descriptor.api_origin.clone(),
                    api_path_prefix: descriptor.api_path_prefix.clone(),
                    instance_id: Uuid::new_v4().to_string(),
                },
            )
            .await?;
            ensure!(
                matches!(
                    tokio::time::timeout(Duration::from_secs(5), read_frame(&mut reader)).await??,
                    Frame::Registered
                ),
                "registration rejected"
            );
            loop {
                match tokio::time::timeout(Duration::from_secs(40), read_frame(&mut reader))
                    .await??
                {
                    Frame::Ping => write_frame(&mut writer, &Frame::Pong).await?,
                    Frame::Policy {
                        request_id,
                        command,
                    } if Uuid::parse_str(&request_id).is_ok() && command.len() <= 16 * 1024 => {
                        let receipt = installer.apply(&command, 0).await.ok();
                        write_frame(
                            &mut writer,
                            &Frame::Result {
                                request_id,
                                receipt,
                            },
                        )
                        .await?;
                    }
                    Frame::Initialize {
                        request_id,
                        command,
                    } if Uuid::parse_str(&request_id).is_ok() => {
                        let acknowledgement = initializer.initialize(&command).await.ok();
                        write_frame(
                            &mut writer,
                            &Frame::Initialized {
                                request_id,
                                acknowledgement,
                            },
                        )
                        .await?;
                    }
                    _ => bail!("invalid control frame"),
                }
            }
            #[allow(unreachable_code)]
            Ok::<(), anyhow::Error>(())
        };
        tokio::select! { _ = stop.cancelled() => return Ok(()), _ = attempt => {} }
        tokio::select! { _ = stop.cancelled() => return Ok(()), _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
    }
}
