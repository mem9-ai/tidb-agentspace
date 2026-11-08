use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

fn main() {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let pins_path = root.join("scripts/duckdb-runtime.json");
    println!("cargo:rerun-if-changed={}", pins_path.display());
    let pins: Value = serde_json::from_slice(&fs::read(&pins_path).unwrap()).unwrap();
    let target = env::var("TARGET").unwrap();
    assert_eq!(
        env::var("HOST").unwrap(),
        target,
        "Cross builds need a separately verified DuckDB artifact"
    );
    let artifact = &pins["artifacts"][&target];
    println!(
        "cargo:rustc-env=WORKSPACE_DUCKDB_VERSION={}",
        pins["version"].as_str().unwrap()
    );
    println!("cargo:rustc-env=WORKSPACE_DUCKDB_TARGET={target}");
    println!(
        "cargo:rustc-env=WORKSPACE_DUCKDB_ARCHIVE_SHA256={}",
        artifact["sha256"]
            .as_str()
            .expect("Unsupported DuckDB target")
    );
    let files = artifact["files"]
        .as_object()
        .expect("Unsupported DuckDB static target; see docs/rust-backend.md");
    let directory = root
        .join(".data/duckdb-native")
        .join(pins["version"].as_str().unwrap());
    for (name, expected) in files {
        let path = directory.join(name);
        println!("cargo:rerun-if-changed={}", path.display());
        let metadata =
            fs::symlink_metadata(&path).expect("Run cargo run --locked -p workspace-build-tools -- prepare before building the backend");
        assert!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "DuckDB build input must be an ordinary verified file"
        );
        let digest = format!("{:x}", Sha256::digest(fs::read(&path).unwrap()));
        assert_eq!(
            Some(digest.as_str()),
            expected.as_str(),
            "DuckDB build input checksum mismatch: {name}"
        );
    }
    println!("cargo:rustc-link-search=native={}", directory.display());
    // libduckdb-sys links the core archive. Register only the existing product capabilities.
    for library in [
        "core_functions_extension",
        "json_extension",
        "parquet_extension",
        "duckdb_loadable_extensions",
    ] {
        println!("cargo:rustc-link-lib=static={library}");
    }
    if target.ends_with("apple-darwin") {
        println!("cargo:rustc-link-lib=dylib=c++");
    } else {
        println!("cargo:rustc-link-lib=dylib=stdc++");
        println!("cargo:rustc-link-lib=dylib=dl");
    }
}
