use anyhow::{Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Write},
    path::Path,
    process::{Command, Stdio},
};

fn capture(cmd: &mut Command) -> Result<Vec<u8>> {
    let r = cmd.output()?;
    ensure!(
        r.status.success(),
        "{:?} failed with {}: {}",
        cmd.get_program(),
        r.status,
        String::from_utf8_lossy(&r.stderr)
    );
    Ok(r.stdout)
}
#[test]
#[ignore = "requires a clean reviewed checkout and a built native executable"]
fn packaged_backend_runs_with_an_empty_path_and_no_private_state() -> Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let sha = String::from_utf8(capture(
        Command::new("git")
            .current_dir(&root)
            .args(["rev-parse", "HEAD"]),
    )?)?;
    let sha = sha.trim();
    let temp = tempfile::tempdir()?;
    let dir = temp.path();
    let binary = std::env::current_exe()?
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("workspace-backend");
    let v: Value = serde_json::from_slice(&capture(
        Command::new(env!("CARGO_BIN_EXE_workspace-build-tools"))
            .arg("package")
            .arg(sha)
            .arg(&binary)
            .arg(dir),
    )?)?;
    assert_eq!(v["sourceSha"], sha);
    let archive = Path::new(v["archive"].as_str().unwrap());
    let mut hash = Sha256::new();
    io::copy(&mut fs::File::open(archive)?, &mut hash)?;
    let digest = hex::encode(hash.finalize());
    assert_eq!(v["sha256"], digest);
    assert_eq!(
        fs::read_to_string(dir.join("SHA256SUMS"))?,
        format!(
            "{digest}  {}\n",
            archive.file_name().unwrap().to_str().unwrap()
        )
    );
    let entries = String::from_utf8(capture(Command::new("tar").arg("-tzf").arg(archive))?)?;
    let mut actual: Vec<_> = entries.lines().map(|p| p.trim_end_matches('/')).collect();
    actual.sort_unstable();
    let mut allowed = vec![
        "api",
        "api/workspace-backend",
        "api/Cargo.lock",
        "api/build-info.json",
        "api/README.txt",
        "api/LICENSE",
        "api/openapi.json",
        "api/global-openapi.json",
        "api/owner-openapi.json",
        "api/operator-openapi.json",
        "api/agent-entry-openapi.json",
    ];
    allowed.sort_unstable();
    assert_eq!(actual, allowed);
    capture(
        Command::new("tar")
            .arg("-xzf")
            .arg(archive)
            .arg("-C")
            .arg(dir),
    )?;
    let staged = dir.join("api");
    for file in [
        "openapi.json",
        "global-openapi.json",
        "owner-openapi.json",
        "operator-openapi.json",
        "agent-entry-openapi.json",
    ] {
        assert_eq!(
            fs::read(staged.join(file))?,
            fs::read(root.join("public").join(file))?
        );
    }
    assert_eq!(
        fs::read(staged.join("LICENSE"))?,
        fs::read(root.join("LICENSE"))?
    );
    let info: Value = serde_json::from_slice(&fs::read(staged.join("build-info.json"))?)?;
    assert_eq!(info["sourceSha"], sha);
    assert_eq!(info["binarySha256"], v["binarySha256"]);
    let packaged = staged.join("workspace-backend");
    let mut binary_hash = Sha256::new();
    io::copy(&mut fs::File::open(&packaged)?, &mut binary_hash)?;
    assert_eq!(info["binarySha256"], hex::encode(binary_hash.finalize()));
    let runtime: Value =
        serde_json::from_slice(&capture(Command::new(&packaged).arg("runtime-info"))?)?;
    assert_eq!(runtime["duckdb"], info["duckdb"]);
    assert_eq!(info["duckdb"]["linkage"], "static");
    assert_eq!(info["duckdb"]["version"], "2.0.0");
    let mut libraries = if cfg!(target_os = "macos") {
        let mut c = Command::new("otool");
        c.arg("-L");
        c
    } else {
        Command::new("ldd")
    };
    let libraries = String::from_utf8(capture(libraries.arg(&packaged))?)?;
    assert!(
        !libraries
            .split_whitespace()
            .any(|l| l.contains("libduckdb") && (l.contains(".so") || l.contains(".dylib")))
    );
    let csv = dir.join("selected.csv");
    fs::write(&csv, b"name,n\nalice,1\n")?;
    let mut worker = Command::new(&packaged)
        .arg("execute")
        .env_clear()
        .env("PATH", "/nonexistent")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    worker.stdin.take().unwrap().write_all(&serde_json::to_vec(
        &json!({"mode":"preview","sourcePath":csv,"format":"csv"}),
    )?)?;
    let r = worker.wait_with_output()?;
    assert!(r.status.success());
    let body: Value = serde_json::from_slice(&r.stdout)?;
    assert!(body.get("error").is_none() && body.get("result").is_some());
    Ok(())
}
