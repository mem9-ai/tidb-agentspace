use workspace_meta_service::config::Config;
use workspace_meta_service::server::{MetaService, shutdown_signal};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let i = args.iter().position(|v| v == "--config").ok_or_else(|| {
        anyhow::anyhow!(
            "Use --config <private-file> [--initialize] [--recover-owner <stopped-owner-id>]"
        )
    })?;
    let path = args
        .get(i + 1)
        .ok_or_else(|| anyhow::anyhow!("Missing configuration path"))?;
    let mut config = Config::load(std::path::Path::new(path))?;
    let budget = workspace_cache_budget::Policy {
        total_mi_b: config.block_cache_mib,
        instances: None,
    }
    .resolve(1)?;
    config.block_cache_mib = Some(budget.instance(config.block_cache_mib)?);
    let recover = args
        .iter()
        .position(|v| v == "--recover-owner")
        .and_then(|i| args.get(i + 1));
    let service = MetaService::open(
        config,
        args.iter().any(|v| v == "--initialize"),
        recover.map(String::as_str),
    )
    .await?;
    let result = service.serve(shutdown_signal()).await;
    service.close().await?;
    result
}
