mod plan;
use anyhow::{Result, bail};
use std::time::Duration;
use std::{collections::BTreeMap, path::Path, sync::Arc};
use tokio::sync::watch;
use workspace_api::{
    GuestRuntime, MetaBinding, WorkspaceServer, global_login::GlobalGuest,
    guest_cleanup::GuestCleanup, guest_entry::GuestEntry, managed_workspaces::ManagedWorkspaces,
    regional_account::RegionalAccount, regional_guest::RegionalGuest,
};
use workspace_contracts::Metadata;
use workspace_identity::{
    Directory, cleanup::Queue, embedded_region::EmbeddedRegion, scheduler::Scheduler,
};
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
        // Image/package verification must work without loading a private deployment plan.
        println!("{}", workspace_execute::runtime_info());
        return Ok(());
    }
    if args.as_slice() == ["execute"] {
        workspace_execute::execute_entry().await?;
        return Ok(());
    }
    if args.len() == 5
        && args[0] == "purge-legacy"
        && args[1] == "--config"
        && args[3] == "--workspace"
        && args[4] == "ws_agentlab"
    {
        return purge_legacy(plan::Plan::load(Path::new(&args[2]))?).await;
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
    let retire_legacy = match std::env::var("WORKSPACE_RETIRE_LEGACY") {
        Err(std::env::VarError::NotPresent) => false,
        Ok(value)
            if value == "ws_agentlab"
                && plan.workspaces.len() == 1
                && plan.workspaces[0].workspace_id == value =>
        {
            true
        }
        _ => bail!("Invalid legacy retirement selection"),
    };
    let (meta_stop, meta_receiver) = watch::channel(false);
    let (api_stop, api_receiver) = watch::channel(false);
    let mut metadata: BTreeMap<String, Arc<MetaService>> = BTreeMap::new();
    let mut meta_tasks = Vec::new();
    let mut api_tasks = Vec::new();
    let mut cleanup_tasks = Vec::new();
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
    let mut global_started = false;
    let mut shared_globals = BTreeMap::new();
    let global_entries = plan
        .globals
        .iter()
        .filter(|g| g.shared_listener)
        .map(|g| {
            (
                g.bind,
                workspace_api::GlobalEntry {
                    api_origin: g.public_origin.clone(),
                    api_path_prefix: g.public_path.clone(),
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    for config in plan.globals {
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
            let shared = config.shared_listener;
            let bind = config.bind;
            match workspace_api::global_api::GlobalServer::open(config, port).await {
                Ok(server) => {
                    global_started = true;
                    if shared {
                        shared_globals.insert(bind, server);
                        continue;
                    }
                    let receiver = api_receiver.clone();
                    api_tasks.push(tokio::spawn(async move {
                        if server.serve(stopped(receiver)).await.is_err() {
                            eprintln!(
                                "Global public API listener unavailable; other roles continue."
                            );
                        }
                    }));
                    println!("Rust Global public API started.");
                }
                Err(_) => eprintln!(
                    "Global public API could not start; inspect private configuration and checkpoint ownership."
                ),
            }
        }
    }
    for mut config in plan.workspaces {
        if let Some(entry) = global_entries.get(&config.bind) {
            config.global_entry = Some(entry.clone());
        }
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
            let guest_setup: Result<_> = async {
                let settings = config
                    .guest
                    .clone()
                    .or_else(|| {
                        config
                            .managed_workspace_limit
                            .map(|limit| workspace_api::GuestConfig {
                                global_authority_id: "global".into(),
                                workspace_limit: limit,
                            })
                    })
                    .or_else(|| {
                        (config.sso.is_some()
                            && matches!(&config.metadata, MetaBinding::InProcess { .. }))
                        .then(|| workspace_api::GuestConfig {
                            global_authority_id: "global".into(),
                            workspace_limit: 128,
                        })
                    });
                if let Some(settings) = &settings {
                    let region = Arc::new(
                        RegionalGuest::open(port.clone(), &authority, &config.public_path).await?,
                    );
                    let signup = if let Some(global) = metadata.get(&settings.global_authority_id) {
                        match Directory::open(global.clone()).await {
                            Ok(directory) => Some(Arc::new(GlobalGuest::new(
                                directory,
                                Arc::new(EmbeddedRegion::open(port.clone(), &authority).await?),
                                authority.clone(),
                            ))),
                            Err(_) => None,
                        }
                    } else {
                        None
                    };
                    let queue = Arc::new(Queue::open(port.clone(), &authority).await?);
                    let pool = Arc::new(ManagedWorkspaces::new(
                        port.clone(),
                        &authority,
                        config.product.clone(),
                        settings.workspace_limit,
                    )?);
                    let entry = Arc::new(if config.guest.is_some() {
                        GuestEntry::new(
                            signup.clone(),
                            region.clone(),
                            config.public_origins.clone(),
                        )?
                    } else {
                        GuestEntry::disabled(region.clone())
                    });
                    let processor = Arc::new(GuestCleanup::new(queue.clone(), pool.clone()));
                    let scheduler = Scheduler::new(queue.clone(), processor.clone(), 128)?;
                    Ok((
                        Some(Arc::new(GuestRuntime {
                            guest_enabled: config.guest.is_some(),
                            entry,
                            region,
                            account: Arc::new(
                                RegionalAccount::open(
                                    port.clone(),
                                    &authority,
                                    &config.public_path,
                                    config.sso.as_ref().is_some_and(|s| s.secure()),
                                )
                                .await?,
                            ),
                            account_onboarding: signup,
                            workspaces: pool,
                            cleanup: queue,
                            cleanup_processor: processor,
                            cleanup_slots: Arc::new(tokio::sync::Semaphore::new(8)),
                        })),
                        Some(scheduler),
                    ))
                } else {
                    Ok((None, None))
                }
            }
            .await;
            let (guest_runtime, scheduler) = match guest_setup {
                Ok(setup) => setup,
                Err(_) => {
                    eprintln!(
                        "Guest service setup unavailable for {authority}; other roles continue."
                    );
                    continue;
                }
            };
            let guest_pool = guest_runtime
                .as_ref()
                .map(|runtime| runtime.workspaces.clone());
            if retire_legacy {
                anyhow::ensure!(
                    guest_runtime.is_some()
                        && matches!(&config.metadata, MetaBinding::InProcess { .. }),
                    "Legacy retirement requires a managed regional API"
                );
                purge_legacy_workspace(port.clone(), &config).await?;
                println!("Legacy Workspace live metadata and credentials removed.");
            }
            match WorkspaceServer::open_with_guest(config, port, guest_runtime).await {
                Ok(server) => {
                    let server = if let Some(global) = shared_globals.remove(&bind) {
                        server.with_global(global)
                    } else {
                        server
                    };
                    if let Some(scheduler) = scheduler {
                        let receiver = api_receiver.clone();
                        cleanup_tasks.push(tokio::spawn(async move {
                            if scheduler
                                .run(receiver, Duration::from_secs(1))
                                .await
                                .is_err()
                            {
                                eprintln!(
                                    "Guest expiry scheduler stopped; pending records are retained."
                                );
                            }
                        }));
                    }
                    let workspace = server.workspace.clone();
                    workspaces.push(workspace.clone());
                    let receiver = api_receiver.clone();
                    api_tasks.push(tokio::spawn(async move {
                        if server.serve(stopped(receiver)).await.is_err() {eprintln!("Workspace listener unavailable for {authority}; other roles continue.");}
                        if let Some(pool) = guest_pool && pool.close().await.is_err() { eprintln!("Guest Workspace ownership release is uncertain; reconcile regionally before restart."); }
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
    if metadata.is_empty() && workspaces.is_empty() && !global_started {
        bail!("No configured service could start");
    }
    shutdown_signal().await;
    let _ = api_stop.send(true);
    for task in api_tasks {
        let _ = task.await;
    }
    for task in cleanup_tasks {
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

// Deliberate offline operator operation. The running host owns this Meta root and prevents
// opening a second writer. Never use this command against an active deployment.
async fn purge_legacy(plan: plan::Plan) -> Result<()> {
    anyhow::ensure!(
        plan.workspaces.len() == 1,
        "Expected exactly one configured Workspace"
    );
    let config = &plan.workspaces[0];
    anyhow::ensure!(
        config.workspace_id == "ws_agentlab"
            && matches!(&config.metadata, MetaBinding::InProcess { .. }),
        "Legacy Workspace configuration does not match"
    );
    let mut roles = plan
        .metadata
        .into_iter()
        .filter(|role| role.config.authority_id == config.authority_id);
    let role = roles
        .next()
        .ok_or_else(|| anyhow::anyhow!("Regional metadata configuration missing"))?;
    anyhow::ensure!(
        roles.next().is_none() && !role.initialize,
        "Unexpected regional metadata configuration"
    );
    let service =
        Arc::new(MetaService::open(role.config, false, role.recover_owner.as_deref()).await?);
    let result = purge_legacy_workspace(service.clone(), config).await;
    let closed = service.close().await;
    result?;
    closed?;
    println!("Legacy Workspace live metadata and credentials removed.");
    Ok(())
}

async fn purge_legacy_workspace(
    metadata: Arc<dyn Metadata>,
    config: &workspace_api::Config,
) -> Result<()> {
    anyhow::ensure!(
        config.workspace_id == "ws_agentlab",
        "Legacy Workspace configuration does not match"
    );
    let scope = workspace_contracts::Scope {
        authority_id: config.authority_id.clone(),
        owner_kind: "workspace".into(),
        owner_id: "ws_agentlab".into(),
        family: "workspace".into(),
        partition_id: "primary".into(),
    };
    let page = metadata
        .execute(workspace_contracts::MetaRequest::List {
            scope,
            guard: None,
            prefix: "".into(),
            after: None,
            limit: 1,
        })
        .await?;
    if page["records"]
        .as_array()
        .is_some_and(|records| records.is_empty())
    {
        return Ok(());
    }
    let repository = workspace_domain::Repository::open(
        metadata,
        &config.authority_id,
        "ws_agentlab",
        false,
        config.recover_writer_owner.as_deref(),
    )
    .await?;
    let result = repository.purge_legacy_records().await;
    let close = repository.close().await;
    result?;
    close?;
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
            if let Some(security) = &config.security {
                workspace_api::initialize_security_checkpoint(
                    &security.clock_directory,
                    security.initialize_clock,
                )?;
            }
        }
        for config in plan.globals {
            workspace_api::initialize_security_checkpoint(
                &config.clock_directory,
                config.initialize_clock,
            )?;
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
