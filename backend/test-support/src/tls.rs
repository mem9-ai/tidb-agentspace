//! Short-lived certificates for loopback mutual TLS acceptance.
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};
pub fn certificates(dir: &Path) -> Result<(Value, Value)> {
    let openssl = |args: &[&str]| -> Result<()> {
        let result = Command::new("openssl")
            .args(args)
            .current_dir(dir)
            .output()?;
        ensure!(
            result.status.success(),
            "openssl fixture command failed: {}",
            result.status
        );
        Ok(())
    };
    openssl(&[
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "ca.key",
        "-out",
        "ca.crt",
        "-days",
        "1",
        "-subj",
        "/CN=metadata-test-ca",
    ])?;
    fs::set_permissions(dir.join("ca.key"), fs::Permissions::from_mode(0o600))?;
    for role in ["server", "client"] {
        let key = format!("{role}.key");
        let crt = format!("{role}.crt");
        let csr = format!("{role}.csr");
        let ext = format!("{role}.ext");
        openssl(&[
            "req",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            &key,
            "-out",
            &csr,
            "-subj",
            &format!("/CN=metadata-{role}"),
        ])?;
        fs::set_permissions(dir.join(&key), fs::Permissions::from_mode(0o600))?;
        fs::write(
            dir.join(&ext),
            format!("extendedKeyUsage={role}Auth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n"),
        )?;
        openssl(&[
            "x509",
            "-req",
            "-in",
            &csr,
            "-CA",
            "ca.crt",
            "-CAkey",
            "ca.key",
            "-CAcreateserial",
            "-out",
            &crt,
            "-days",
            "1",
            "-extfile",
            &ext,
        ])?;
    }
    Ok((
        json!({"certificateFile":dir.join("server.crt"),"privateKeyFile":dir.join("server.key"),"clientCaFile":dir.join("ca.crt")}),
        json!({"certificateFile":dir.join("client.crt"),"privateKeyFile":dir.join("client.key"),"caFile":dir.join("ca.crt")}),
    ))
}
