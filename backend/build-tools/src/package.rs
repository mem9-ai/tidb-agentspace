use crate::duckdb::{digest, platform};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

fn output(command: &mut Command) -> Result<Vec<u8>> {
    let result = command.output()?;
    ensure!(
        result.status.success(),
        "{:?} failed: {}",
        command.get_program(),
        result.status
    );
    Ok(result.stdout)
}

pub(super) const CONTRACTS: &[&str] = &[
    "openapi.json",
    "owner-openapi.json",
    "global-openapi.json",
    "agent-entry-openapi.json",
    "operator-openapi.json",
];

fn revision(root: &Path, sha: &str) -> Result<()> {
    ensure!(
        sha.len() == 40
            && sha
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            && sha.bytes().any(|c| c != b'0'),
        "Provide the full reviewed source SHA"
    );
    let git = |args: &[&str]| output(Command::new("git").current_dir(root).args(args));
    ensure!(
        String::from_utf8(git(&["rev-parse", "HEAD"])?)?.trim() == sha,
        "Check out the reviewed revision"
    );
    ensure!(
        git(&["status", "--porcelain", "--untracked-files=all"])?.is_empty(),
        "Package a clean reviewed source tree"
    );
    Ok(())
}
fn write_json(path: &Path, value: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    fs::write(path, bytes)?;
    Ok(())
}
pub(super) fn package(root: &Path, sha: &str, binary: &Path, destination: &Path) -> Result<Value> {
    revision(root, sha)?;
    ensure!(
        fs::symlink_metadata(binary)?.is_file(),
        "Package an ordinary native executable"
    );
    let pin: Value = serde_json::from_slice(&fs::read(root.join("scripts/duckdb-runtime.json"))?)?;
    let runtime: Value =
        serde_json::from_slice(&output(Command::new(binary).arg("runtime-info"))?)?;
    let runtime = runtime
        .get("duckdb")
        .context("Missing file analysis runtime")?;
    let target = runtime["target"]
        .as_str()
        .context("Missing runtime target")?;
    let (platform, arch) = platform();
    let artifact = &pin["artifacts"][target];
    ensure!(
        runtime["version"] == pin["version"]
            && runtime["linkage"] == "static"
            && artifact["platform"] == platform
            && artifact["arch"] == arch
            && runtime["archiveSha256"] == artifact["sha256"]
            && artifact["sha256"].is_string(),
        "Native executable does not match the verified static runtime"
    );
    fs::create_dir_all(destination)?;
    let temporary = tempfile::Builder::new()
        .prefix(".workspace-package-")
        .tempdir_in(destination)?;
    let staged = temporary.path().join("api");
    fs::create_dir(&staged)?;
    let executable = staged.join("workspace-backend");
    fs::copy(binary, &executable)?;
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))?;
    fs::copy(root.join("Cargo.lock"), staged.join("Cargo.lock"))?;
    fs::copy(root.join("LICENSE"), staged.join("LICENSE"))?;
    for file in CONTRACTS {
        fs::copy(root.join("public").join(file), staged.join(file))?;
    }
    let rust = fs::read_to_string(root.join("rust-toolchain.toml"))?;
    let rust = rust
        .lines()
        .filter_map(|s| s.split_once('='))
        .find(|(k, _)| k.trim() == "channel")
        .context("Missing Rust pin")?
        .1
        .trim()
        .trim_matches('"');
    let info = json!({"sourceSha":sha,"component":"rust-api","platform":platform,"architecture":arch,"rust":rust,"binarySha256":digest(&executable)?,"duckdb":runtime,"audience":"internal-local-demo","deployed":false});
    write_json(&staged.join("build-info.json"), &info)?;
    fs::write(
        staged.join("README.txt"),
        format!(
            "TiDB Agent Workspace Rust API\nReviewed source: {sha}\nRun ./workspace-backend serve --config /absolute/private/deployment.json\nSee docs/native-studio-deployment.md for API and Meta roles, access policy and private storage configuration.\n"
        ),
    )?;
    let name = format!("workspace-rust-api-{platform}-{arch}.tar.gz");
    let temp_archive = temporary.path().join(&name);
    output(
        Command::new("tar")
            .arg("-czf")
            .arg(&temp_archive)
            .arg("-C")
            .arg(temporary.path())
            .arg("api"),
    )?;
    let archive = destination.join(&name);
    let sha256 = digest(&temp_archive)?;
    fs::write(
        temporary.path().join("SHA256SUMS"),
        format!("{sha256}  {name}\n"),
    )?;
    write_json(&temporary.path().join("build-info.json"), &info)?;
    fs::rename(temp_archive, &archive)?;
    for file in ["build-info.json", "SHA256SUMS"] {
        fs::rename(temporary.path().join(file), destination.join(file))?;
    }
    let mut result = info;
    result["archive"] = json!(archive);
    result["sha256"] = json!(sha256);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_and_unreviewed_revisions() {
        for bad in ["", "bad", &"0".repeat(40), &"f".repeat(40)] {
            assert!(revision(Path::new(env!("CARGO_MANIFEST_DIR")), bad).is_err());
        }
    }
}
