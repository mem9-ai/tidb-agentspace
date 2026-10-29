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
    if args.as_slice() == ["worker"] {
        workspace_compute::worker_entry().await?;
        return Ok(());
    }
    if args.len() != 3 || args[0] != "serve" || args[1] != "--config" {
        bail!("Use workspace-backend serve --config <private-deployment.json>");
    }
    let plan = plan::Plan::load(Path::new(&args[2]))?;
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
                "workspace-keys-only migration profile"
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
                    "Workspace startup unavailable for {authority}; inspect import and gateway ownership. Other roles continue."
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
