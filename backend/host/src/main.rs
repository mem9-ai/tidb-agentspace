mod plan;
use anyhow::{Result, bail};
use std::{collections::BTreeMap, path::Path, sync::Arc};
use tokio::sync::watch;
use workspace_api::{MetaBinding, WorkspaceServer};
use workspace_contracts::Metadata;
use workspace_meta_client::RemoteMetadata;
use workspace_meta_service::server::{MetaService, shutdown_signal};

async fn stopped(mut receiver: watch::Receiver<bool>) {
    if !*receiver.borrow() {
        let _ = receiver.changed().await;
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.as_slice() == ["runtime-info"] {
        println!("{}", workspace_compute::runtime_info());
        return Ok(());
    }
    if args.as_slice() == ["worker"] {
        workspace_compute::worker_entry().await?;
        return Ok(());
    }
    if args.len() != 3
        || !["serve", "initialize"].contains(&args[0].as_str())
        || args[1] != "--config"
    {
        bail!("Use workspace-backend serve --config <private-deployment.json>");
    }
    let plan = plan::Plan::load(Path::new(&args[2]))?;
    if args[0] == "initialize" {
        return initialize(plan).await;
    }
    let (meta_stop, meta_receiver) = watch::channel(false);
    let (api_stop, api_receiver) = watch::channel(false);
    let mut metadata: BTreeMap<String, Arc<MetaService>> = BTreeMap::new();
    let mut meta_tasks = Vec::new();
    let mut api_tasks = Vec::new();
    let mut workspaces = Vec::new();
    for role in plan.metadata {
        let authority = role.config.authority_id.clone();
        match MetaService::open(role.config, role.initialize, role.recover_owner.as_deref()).await {
            Ok(service) => {
                let service = Arc::new(service);
                metadata.insert(authority.clone(), service.clone());
                let receiver = meta_receiver.clone();
                meta_tasks.push(tokio::spawn(async move {
                    if service.serve(stopped(receiver)).await.is_err() {
                        eprintln!(
                            "Metadata listener unavailable for {authority}; other roles continue."
                        );
                    }
                }));
            }
            Err(_) => eprintln!(
                "Metadata startup unavailable for {authority}; other roles continue. Inspect private deployment configuration and ownership."
            ),
        }
    }
    for config in plan.workspaces {
        let authority = config.authority_id.clone();
        let port: Option<Arc<dyn Metadata>> = match &config.metadata {
            MetaBinding::InProcess { authority_id } => metadata
                .get(authority_id)
                .cloned()
                .map(|v| v as Arc<dyn Metadata>),
            MetaBinding::Remote { client } => RemoteMetadata::connect(client.clone())
                .await
                .ok()
                .map(|v| Arc::new(v) as Arc<dyn Metadata>),
        };
        if let Some(port) = port {
            let bind = config.bind;
            let profile = if config.product.is_some() {
                "full regional API"
            } else {
                "workspace-keys-only profile"
            };
            match WorkspaceServer::open(config, port).await {
                Ok(server) => {
                    let workspace = server.workspace.clone();
                    workspaces.push(workspace.clone());
                    let receiver = api_receiver.clone();
                    api_tasks.push(tokio::spawn(async move {
                        if server.serve(stopped(receiver)).await.is_err() {eprintln!("Workspace listener unavailable for {authority}; other roles continue.");}
                        if workspace.close().await.is_err() {eprintln!("Workspace ownership release is uncertain; reconcile regionally before restart.");}
                    }));
                    println!("Rust {profile} listening on {bind}.");
                }
                Err(_) => eprintln!(
                    "Workspace startup unavailable for {authority}; inspect record metadata and Workspace writer ownership. Other roles continue."
                ),
            }
        } else {
            eprintln!("Regional dependency unavailable for {authority}; no fallback selected.");
        }
    }
    if metadata.is_empty() && workspaces.is_empty() {
        bail!("No configured service could start");
    }
    shutdown_signal().await;
    let _ = api_stop.send(true);
    for task in api_tasks {
        let _ = task.await;
    }
    for workspace in workspaces {
        let _ = workspace.close().await;
    }
    let _ = meta_stop.send(true);
    for task in meta_tasks {
        let _ = task.await;
    }
    for service in metadata.values() {
        if service.close().await.is_err() {
            eprintln!(
                "Metadata ownership release is uncertain; preserve private configuration for recovery."
            );
        }
    }
    Ok(())
}

// Explicit one-time bootstrap. No listeners are published and no old storage is imported.
async fn initialize(plan: plan::Plan) -> Result<()> {
    let mut metadata: BTreeMap<String, Arc<MetaService>> = BTreeMap::new();
    let result: Result<()> = async {
        for role in plan.metadata {
            if !role.initialize {
                bail!("Initialization plan must explicitly initialize every metadata role");
            }
            let authority = role.config.authority_id.clone();
            let service =
                MetaService::open(role.config, true, role.recover_owner.as_deref()).await?;
            metadata.insert(authority, Arc::new(service));
        }
        for config in plan.workspaces {
            if !config.initialize_workspace {
                bail!("Initialization plan must explicitly initialize the Workspace");
            }
            let port: Arc<dyn Metadata> = match &config.metadata {
                MetaBinding::InProcess { authority_id } => metadata
                    .get(authority_id)
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("Missing native metadata"))?,
                MetaBinding::Remote { .. } => {
                    bail!("Hosted bootstrap requires explicit in-process authority ownership")
                }
            };
            let repository = workspace_domain::Repository::open(
                port,
                &config.authority_id,
                &config.workspace_id,
                true,
                config.recover_writer_owner.as_deref(),
            )
            .await?;
            let workspace = workspace_domain::Workspace::new(repository);
            workspace.health().await?;
            workspace.close().await?;
        }
        Ok(())
    }
    .await;
    let mut close_error = false;
    for service in metadata.values() {
        if service.close().await.is_err() {
            close_error = true;
        }
    }
    result?;
    if close_error {
        bail!("Bootstrap ownership release was not confirmed");
    }
    println!("Fresh native metadata and Workspace initialized; ownership released.");
    Ok(())
}
