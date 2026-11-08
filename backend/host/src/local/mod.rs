//! Local installation and supervision of the standard native deployment roles.
mod config;
mod supervisor;

use anyhow::{Context, Result, bail, ensure};
use config::{Topology, init};
use std::path::{Path, PathBuf};

pub async fn run(args: &[String]) -> Result<()> {
    let Some((action, flags)) = args.split_first() else {
        bail!("Use workspace-backend local init|serve|status|stop [--directory <path>]");
    };
    let mut directory = None;
    let mut port = None;
    let mut workspace = None;
    let mut binary = None;
    for pair in flags.chunks(2) {
        let value = pair.get(1).context("Missing local option value")?;
        let setting = match pair[0].as_str() {
            "--directory" => &mut directory,
            "--api-port" if action == "init" => &mut port,
            "--workspace" if action == "init" => &mut workspace,
            "--binary" if action == "init" => &mut binary,
            _ => bail!("Unknown local option"),
        };
        ensure!(
            setting.replace(value.as_str()).is_none(),
            "Duplicate local option"
        );
    }
    let directory = Path::new(directory.unwrap_or(".data/meta-runtime"));
    match action.as_str() {
        "init" => init(
            directory,
            port.unwrap_or("4318").parse()?,
            workspace.unwrap_or("ws_agentlab"),
            &binary
                .map(PathBuf::from)
                .map_or_else(std::env::current_exe, Ok)?,
        ),
        "serve" => supervisor::serve(directory, Topology::load(directory)?).await,
        "status" => supervisor::status(directory),
        "stop" => supervisor::stop(directory).await,
        _ => bail!("Use workspace-backend local init|serve|status|stop"),
    }
}
