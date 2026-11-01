//! Isolated mTLS integration fixture, not a production deployment role.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use std::{
    collections::BTreeMap, future::Future, net::SocketAddr, path::PathBuf, pin::Pin, sync::Arc,
};
use workspace_api::{
    policy_command::{PolicyCommandVerifier, PolicyReceipt, PolicyTrust},
    policy_transport::{
        ClientTls, PolicyControlClient, PolicyControlServer, ServerTls, TrustedRegionalClock,
    },
};
use workspace_identity::regional_key_policy::KeyPolicies;
use workspace_meta_client::{ClientConfig, RemoteMetadata};

struct TestClock;
impl TrustedRegionalClock for TestClock {
    fn now(&self) -> Pin<Box<dyn Future<Output = workspace_contracts::Result<i64>> + Send + '_>> {
        Box::pin(async { Ok(1000) })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServerInput {
    meta_file: PathBuf,
    bind: SocketAddr,
    certificate_file: PathBuf,
    private_key_file: PathBuf,
    client_ca_file: PathBuf,
    global_client_certificate: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientInput {
    origin: String,
    ca_file: PathBuf,
    certificate_file: PathBuf,
    private_key_file: PathBuf,
    command_file: PathBuf,
    receipt_file: PathBuf,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(
        args.len() == 3,
        "expected isolated fixture mode and configuration"
    );
    match args[1].as_str() {
        "serve" => {
            let input: ServerInput = serde_json::from_slice(&std::fs::read(&args[2])?)?;
            let config: ClientConfig = serde_json::from_slice(&std::fs::read(input.meta_file)?)?;
            let authority = config.authority_id.clone();
            let metadata = Arc::new(RemoteMetadata::connect(config).await?);
            let policies = Arc::new(KeyPolicies::open(metadata, &authority).await?);
            let key: [u8; 32] = URL_SAFE_NO_PAD
                .decode("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo")?
                .try_into()
                .map_err(|_| anyhow::anyhow!("invalid fixture key"))?;
            let verifier = Arc::new(PolicyCommandVerifier::new(PolicyTrust {
                issuer: "https://global.example".into(),
                audience: "region:other/control".into(),
                environment: "test".into(),
                region_id: authority,
                keys: BTreeMap::from([("key-1".into(), key)]),
            })?);
            let tls = ServerTls {
                bind: input.bind,
                certificate_file: input.certificate_file,
                private_key_file: input.private_key_file,
                client_ca_file: input.client_ca_file,
                global_client_certificates: vec![input.global_client_certificate],
            };
            PolicyControlServer::new(tls, verifier, policies, Arc::new(TestClock))?
                .serve(std::future::pending())
                .await?;
        }
        "send" => {
            let input: ClientInput = serde_json::from_slice(&std::fs::read(&args[2])?)?;
            let tls = ClientTls {
                ca_file: input.ca_file,
                certificate_file: input.certificate_file,
                private_key_file: input.private_key_file,
            };
            let client = PolicyControlClient::new(&input.origin, "region:other", tls)?;
            let command = std::fs::read_to_string(input.command_file)?;
            let receipt: PolicyReceipt =
                serde_json::from_slice(&std::fs::read(input.receipt_file)?)?;
            client.store(&command, &receipt).await?;
        }
        _ => anyhow::bail!("unsupported fixture mode"),
    }
    Ok(())
}
