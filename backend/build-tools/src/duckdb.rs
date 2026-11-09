use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io, path::Path, process::Command};

#[derive(Deserialize)]
struct Manifest {
    version: String,
    artifacts: BTreeMap<String, Artifact>,
}
#[derive(Deserialize)]
struct Artifact {
    platform: String,
    arch: String,
    asset: String,
    sha256: String,
    size: u64,
    files: BTreeMap<String, String>,
}

pub(super) fn digest(path: &Path) -> Result<String> {
    let mut hash = Sha256::new();
    io::copy(&mut fs::File::open(path)?, &mut hash)?;
    Ok(hex::encode(hash.finalize()))
}

fn valid_cache(dir: &Path, pins: &Artifact) -> Result<bool> {
    if !fs::symlink_metadata(dir)?.is_dir() {
        return Ok(false);
    }
    for (name, sha) in &pins.files {
        let path = dir.join(name);
        if !fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file()) || digest(&path)? != *sha {
            return Ok(false);
        }
    }
    Ok(true)
}

fn checked_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn install(
    root: &Path,
    manifest: &Manifest,
    platform: &str,
    arch: &str,
    download: impl FnOnce(&str, &Path, u64) -> Result<()>,
) -> Result<()> {
    let (target, pins) = manifest
        .artifacts
        .iter()
        .find(|(_, a)| a.platform == platform && a.arch == arch)
        .with_context(|| format!("No verified DuckDB static artifact for {platform}/{arch}"))?;
    let version = &manifest.version;
    ensure!(
        version.split('.').count() == 3
            && version
                .split('.')
                .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
            && pins.asset.starts_with("duckdb-static-libs-")
            && pins.asset.ends_with(".tar.gz")
            && pins
                .asset
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-.".contains(&b))
            && (1..=128 * 1024 * 1024).contains(&pins.size)
            && checked_hash(&pins.sha256)
            && !pins.files.is_empty()
            && pins.files.iter().all(|(name, sha)| {
                name.rsplit_once('.').is_some_and(|(stem, ext)| {
                    !stem.is_empty()
                        && stem
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                        && matches!(ext, "h" | "a")
                }) && checked_hash(sha)
            }),
        "Invalid DuckDB artifact definition"
    );
    let parent = root.join(".data/duckdb-native");
    let dst = parent.join(version);
    match fs::symlink_metadata(&dst) {
        Ok(_) if valid_cache(&dst, pins)? => return Ok(()),
        Ok(_) => bail!("Corrupt DuckDB cache at {}", dst.display()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.into()),
    }
    fs::create_dir_all(&parent)?;
    let tmp = tempfile::Builder::new()
        .prefix(".download-")
        .tempdir_in(parent)?;
    let archive = tmp.path().join("download.tar.gz");
    let url = format!(
        "https://github.com/duckdb/duckdb/releases/download/v{version}/{}",
        pins.asset
    );
    download(&url, &archive, pins.size)?;
    ensure!(
        fs::metadata(&archive)?.len() == pins.size && digest(&archive)? == pins.sha256,
        "DuckDB archive size or checksum mismatch"
    );
    let status = Command::new("tar")
        .arg("-xzf")
        .arg(&archive)
        .arg("-C")
        .arg(tmp.path())
        .arg("--")
        .args(pins.files.keys())
        .status()?;
    ensure!(
        status.success() && valid_cache(tmp.path(), pins)?,
        "DuckDB extracted library checksum or file type mismatch"
    );
    fs::remove_file(archive)?;
    fs::write(
        tmp.path().join("build-info.json"),
        serde_json::to_vec_pretty(&json!({
            "version": version, "target":target,"archiveSha256":pins.sha256,"asset":pins.asset
        }))?,
    )?;
    if let Err(err) = fs::rename(tmp.path(), &dst)
        && !(matches!(
            err.kind(),
            io::ErrorKind::AlreadyExists | io::ErrorKind::DirectoryNotEmpty
        ) && valid_cache(&dst, pins)?)
    {
        return Err(err.into());
    }
    Ok(())
}

pub(super) fn platform() -> (&'static str, &'static str) {
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        arch => arch,
    };
    (platform, arch)
}

pub(super) fn prepare(root: &Path) -> Result<()> {
    let manifest =
        serde_json::from_reader(fs::File::open(root.join("scripts/duckdb-runtime.json"))?)?;
    let (platform, arch) = platform();
    install(root, &manifest, platform, arch, |url, archive, limit| {
        let status = Command::new("curl")
            .args([
                "--fail",
                "--silent",
                "--show-error",
                "--location",
                "--retry",
                "2",
                "--retry-max-time",
                "60",
                "--proto",
                "=https",
                "--proto-redir",
                "=https",
                "--max-time",
                "60",
                "--max-filesize",
            ])
            .arg(limit.to_string())
            .arg("--output")
            .arg(archive)
            .arg(url)
            .status()?;
        ensure!(status.success(), "DuckDB artifact download failed");
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn fixture() -> Result<(tempfile::TempDir, Manifest, Vec<u8>)> {
        let root = tempfile::tempdir()?;
        let lib = root.path().join("libduckdb_static.a");
        fs::write(&lib, b"pinned test library")?;
        let archive = root.path().join("test.tar.gz");
        let tar = Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(root.path())
            .arg("libduckdb_static.a")
            .status()?;
        ensure!(tar.success(), "test archive");
        let bytes = fs::read(&archive)?;
        let pins = Artifact {
            platform: "darwin".into(),
            arch: "arm64".into(),
            asset: "duckdb-static-libs-osx-arm64.tar.gz".into(),
            sha256: digest(&archive)?,
            size: bytes.len() as u64,
            files: BTreeMap::from([("libduckdb_static.a".into(), digest(&lib)?)]),
        };
        Ok((
            root,
            Manifest {
                version: "2.0.0".into(),
                artifacts: BTreeMap::from([("test".into(), pins)]),
            },
            bytes,
        ))
    }

    #[test]
    fn verify_before_publication_and_validate_each_cached_library() -> Result<()> {
        let (root, mut manifest, archive) = fixture()?;
        let dst = root.path().join(".data/duckdb-native/2.0.0");
        let save = |url: &str, path: &Path, size: u64| {
            assert_eq!(
                url,
                "https://github.com/duckdb/duckdb/releases/download/v2.0.0/duckdb-static-libs-osx-arm64.tar.gz"
            );
            assert_eq!(archive.len() as u64, size);
            fs::write(path, &archive)?;
            Ok(())
        };
        let corrupt = |_: &str, path: &Path, size: u64| {
            fs::write(path, vec![0; size as usize])?;
            Ok(())
        };
        assert!(install(root.path(), &manifest, "darwin", "arm64", corrupt).is_err());
        assert!(!dst.exists());
        let original = manifest.artifacts["test"].files.clone();
        manifest
            .artifacts
            .get_mut("test")
            .unwrap()
            .files
            .insert("libduckdb_static.a".into(), "0".repeat(64));
        assert!(install(root.path(), &manifest, "darwin", "arm64", save).is_err());
        assert!(!dst.exists());
        manifest.artifacts.get_mut("test").unwrap().files = original;
        assert!(
            install(
                root.path(),
                &manifest,
                "darwin",
                "unknown",
                |_, _, _| panic!("download for unsupported target")
            )
            .is_err()
        );
        let count = AtomicUsize::new(0);
        let run = || {
            install(
                root.path(),
                &manifest,
                "darwin",
                "arm64",
                |url, path, size| {
                    count.fetch_add(1, Ordering::Relaxed);
                    save(url, path, size)
                },
            )
        };
        std::thread::scope(|scope| {
            let a = scope.spawn(run);
            let b = scope.spawn(run);
            a.join().unwrap().unwrap();
            b.join().unwrap().unwrap();
        });
        let downloads = count.load(Ordering::Relaxed);
        run()?;
        assert_eq!(count.load(Ordering::Relaxed), downloads);
        fs::write(dst.join("libduckdb_static.a"), b"modified")?;
        assert!(run().is_err());
        assert_eq!(count.load(Ordering::Relaxed), downloads);
        Ok(())
    }
}
