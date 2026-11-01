//! Isolated Meta test helper. This is not an API, migration tool or operator command.
use serde::{Deserialize, Serialize};
use std::{io::Write, os::unix::fs::OpenOptionsExt, sync::Arc};
use workspace_identity::global_keys::{GlobalKeys, KeyView, NewKey};
use workspace_meta_client::{ClientConfig, RemoteMetadata};

#[derive(Deserialize, Serialize)]
struct FixtureKey {
    view: KeyView,
    secret: String,
}

fn save(path: &str, value: &FixtureKey) -> anyhow::Result<()> {
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    output.write_all(&serde_json::to_vec(value)?)?;
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(args.len() == 5, "expected isolated fixture arguments");
    let config: ClientConfig = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let keys = GlobalKeys::open(Arc::new(RemoteMetadata::connect(config).await?)).await?;
    if args[2] == "create" {
        let issued = keys
            .create(
                &NewKey {
                    name: "Probe key".into(),
                    workspace_id: "ws_agentlab".into(),
                    principal_id: "legacy-owner".into(),
                    grant_ref: "grant:existing".into(),
                    expires_at: 4_102_444_800,
                },
                &args[4],
            )
            .await?;
        save(
            &args[3],
            &FixtureKey {
                view: issued.view,
                secret: issued.secret,
            },
        )?;
        println!("{{\"created\":true}}");
        return Ok(());
    }
    let mut current: FixtureKey = serde_json::from_slice(&std::fs::read(&args[3])?)?;
    match args[2].as_str() {
        "check" => {
            let view = keys
                .authenticate(&current.view.workspace_id, &current.secret)
                .await?;
            println!("{}", serde_json::to_string(&view)?);
        }
        "renew" => {
            current.view = keys
                .renew(
                    &current.view.workspace_id,
                    &current.view.key_id,
                    current.view.key_version,
                    current.view.expires_at + 600,
                    &args[4],
                )
                .await?;
            save(&args[3], &current)?;
            println!("{{\"renewed\":true}}");
        }
        "rotate" => {
            let issued = keys
                .rotate(
                    &current.view.workspace_id,
                    &current.view.key_id,
                    current.view.key_version,
                    &args[4],
                )
                .await?;
            save(
                &args[3],
                &FixtureKey {
                    view: issued.view,
                    secret: issued.secret,
                },
            )?;
            println!("{{\"rotated\":true}}");
        }
        "revoke" => {
            current.view = keys
                .revoke(
                    &current.view.workspace_id,
                    &current.view.key_id,
                    current.view.key_version,
                    &args[4],
                )
                .await?;
            save(&args[3], &current)?;
            println!("{{\"revoked\":true}}");
        }
        _ => anyhow::bail!("unsupported fixture operation"),
    }
    Ok(())
}
