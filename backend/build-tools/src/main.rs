mod duckdb;
mod package;

use anyhow::{Result, bail};
use std::path::{Path, PathBuf};

fn main() -> Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let [action, sha, rest @ ..] = &args[..]
        && action == "package"
        && rest.len() <= 2
    {
        let binary = rest
            .first()
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("meta-service/target/debug/workspace-backend"));
        let destination = rest
            .get(1)
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("release/rust-api"));
        println!("{}", package::package(&root, sha, &binary, &destination)?);
        return Ok(());
    }
    match args.as_slice() {
        [action] if action == "prepare" => duckdb::prepare(&root),
        _ => bail!(
            "Use workspace-build-tools prepare | package FULL_SOURCE_SHA [BINARY [DESTINATION]]"
        ),
    }
}
