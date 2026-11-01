//! Isolated signing and S3-recovery fixture. This is not a control-plane endpoint.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use std::{collections::BTreeMap, io::Write, os::unix::fs::OpenOptionsExt, sync::Arc};
use workspace_api::policy_command::{
    PolicyCommandSigner, PolicyCommandVerifier, PolicySignerConfig, PolicyTrust,
};
use workspace_identity::regional_key_policy::{KeyPolicies, KeyPolicy};
use workspace_meta_client::{ClientConfig, RemoteMetadata};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fixture {
    policy: KeyPolicy,
    command_id: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(args.len() == 5, "expected isolated fixture arguments");
    match args[1].as_str() {
        "sign" => {
            let input: Fixture = serde_json::from_slice(&std::fs::read(&args[3])?)?;
            let private = URL_SAFE_NO_PAD
                .decode("MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v_VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g")?;
            let signer = PolicyCommandSigner::new(
                PolicySignerConfig {
                    issuer: "https://global.example".into(),
                    audience: "region:other/control".into(),
                    environment: "test".into(),
                    region_id: "region:other".into(),
                    key_id: "key-1".into(),
                },
                &private,
            )?;
            let command = signer.sign(&input.policy, &input.command_id, 1000)?;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&args[4])?;
            file.write_all(command.as_bytes())?;
        }
        "apply" => {
            let config: ClientConfig = serde_json::from_slice(&std::fs::read(&args[2])?)?;
            let authority = config.authority_id.clone();
            let metadata = Arc::new(RemoteMetadata::connect(config).await?);
            let policies = KeyPolicies::open(metadata, &authority).await?;
            let key: [u8; 32] = URL_SAFE_NO_PAD
                .decode("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo")?
                .try_into()
                .map_err(|_| anyhow::anyhow!("Invalid fixture key"))?;
            let verifier = PolicyCommandVerifier::new(PolicyTrust {
                issuer: "https://global.example".into(),
                audience: "region:other/control".into(),
                environment: "test".into(),
                region_id: authority,
                keys: BTreeMap::from([("key-1".into(), key)]),
            })?;
            let command = std::fs::read_to_string(&args[3])?;
            verifier.apply(&command, 1000, &policies).await?;
        }
        _ => anyhow::bail!("unsupported fixture operation"),
    }
    Ok(())
}
