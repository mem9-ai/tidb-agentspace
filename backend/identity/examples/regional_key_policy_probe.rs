//! Isolated Meta integration fixture; this is not an HTTP authentication service.
use std::sync::Arc;
use workspace_identity::regional_key_policy::{KeyPolicies, KeyPolicy, VerifiedKeyBinding};
use workspace_meta_client::{ClientConfig, RemoteMetadata};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(args.len() == 5, "expected isolated fixture arguments");
    let config: ClientConfig = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let policy: KeyPolicy = serde_json::from_slice(&std::fs::read(&args[3])?)?;
    let authority = config.authority_id.clone();
    let metadata = Arc::new(RemoteMetadata::connect(config).await?);
    let service = KeyPolicies::open(metadata, &authority).await?;
    match args[2].as_str() {
        "install" => service.install(&policy, &args[4]).await?,
        "check" => {
            let now: i64 = args[4].parse()?;
            let grant = service
                .check_token_key_binding(
                    &VerifiedKeyBinding {
                        workspace_id: &policy.workspace_id,
                        region_id: &policy.region_id,
                        key_id: &policy.key_id,
                        principal_id: &policy.principal_id,
                        key_version: policy.key_version,
                        policy_generation: policy.policy_generation,
                        expires_at: policy.expires_at,
                        not_before: 1,
                    },
                    now,
                )
                .await?;
            println!("{}", serde_json::json!({"grantRef":grant}));
        }
        _ => anyhow::bail!("unsupported fixture operation"),
    }
    Ok(())
}
