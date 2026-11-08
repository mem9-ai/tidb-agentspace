use super::*;
use reqwest::{Certificate, Client, Identity, tls::Version};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use workspace_test_support::{Process, port, tls::certificates};

#[tokio::test]
#[ignore = "requires isolated RustFS and native examples"]
async fn policy_mtls_pins_the_sender_and_rejects_redirects() -> Result<()> {
    let f = Fixture::start().await?;
    let dir = f.directory();
    let mut global = f.meta("global").await?;
    let region = f.meta("other").await?;
    private_json(&dir.join("region"), &region.client)?;
    let (mut server, mut client) = certificates(dir)?;
    let openssl = |args: &[&str]| -> Result<()> {
        let o = std::process::Command::new("openssl")
            .current_dir(dir)
            .args(args)
            .output()?;
        ensure!(o.status.success(), "generate test certificate");
        Ok(())
    };
    openssl(&[
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "other.key",
        "-out",
        "other.csr",
        "-subj",
        "/CN=other-client",
    ])?;
    openssl(&[
        "x509",
        "-req",
        "-in",
        "other.csr",
        "-CA",
        "ca.crt",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-out",
        "other.crt",
        "-days",
        "1",
        "-extfile",
        "client.ext",
    ])?;
    let addr = format!("127.0.0.1:{}", port()?);
    let origin = format!("https://{addr}");
    server["metaFile"] = file(&f, "region").into();
    server["bind"] = addr.clone().into();
    server["globalClientCertificate"] = client["certificateFile"].clone();
    private_json(&dir.join("server"), &server)?;
    let probe = "policy_transport_probe";
    let mut child = Process::spawn(
        std::process::Command::new(binary("examples").join(probe))
            .current_dir(dir)
            .args(["serve", "server"]),
        &dir.join("control.log"),
    )?;
    let end = Instant::now() + Duration::from_secs(10);
    while tokio::net::TcpStream::connect(&addr).await.is_err() {
        child.ensure_running()?;
        ensure!(Instant::now() < end, "control timeout");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let p = policy();
    let command_id = id();
    private_json(
        &dir.join("input"),
        &json!({"policy":p,"commandId":command_id}),
    )?;
    run(
        dir,
        "policy_command_probe",
        &["sign", "-", "input", "signed"],
    )
    .await?;
    let signed = fs::read_to_string(dir.join("signed"))?;
    let receipt = json!({"commandId":command_id,"workspaceId":p["workspaceId"],"regionId":p["regionId"],"keyId":p["keyId"],"keyVersion":1,"policyGeneration":1});
    private_json(&dir.join("receipt"), &receipt)?;
    client["origin"] = origin.clone().into();
    client["commandFile"] = file(&f, "signed").into();
    client["receiptFile"] = file(&f, "receipt").into();
    private_json(&dir.join("client"), &client)?;
    let http = |role: Option<&str>, max: Version| -> Result<Client> {
        let mut b = Client::builder()
            .no_proxy()
            .tls_certs_only(Certificate::from_pem_bundle(&fs::read(
                dir.join("ca.crt"),
            )?)?)
            .resolve("wrong.example", addr.parse()?)
            .tls_version_max(max)
            .timeout(Duration::from_secs(3));
        if let Some(role) = role {
            let mut pem = fs::read(dir.join(format!("{role}.crt")))?;
            pem.extend(fs::read(dir.join(format!("{role}.key")))?);
            b = b.identity(Identity::from_pem(&pem)?);
        }
        Ok(b.build()?)
    };
    let path = "/internal/v1/region-key-policy-commands";
    let send = |http: Client, origin: &str, command: &str| {
        http.post(format!("{origin}{path}"))
            .json(&json!({"command":command}))
            .send()
    };
    for (role, max, endpoint) in [
        (None, Version::TLS_1_3, origin.clone()),
        (Some("other"), Version::TLS_1_3, origin.clone()),
        (Some("client"), Version::TLS_1_2, origin.clone()),
        (
            Some("client"),
            Version::TLS_1_3,
            origin.replace("127.0.0.1", "wrong.example"),
        ),
    ] {
        assert!(send(http(role, max)?, &endpoint, &signed).await.is_err());
    }
    let authorized = http(Some("client"), Version::TLS_1_3)?;
    assert_eq!(
        send(authorized.clone(), &origin, &"x".repeat(25 * 1024))
            .await?
            .status(),
        413
    );
    assert_eq!(
        send(authorized.clone(), &origin, &format!("{signed}x"))
            .await?
            .status(),
        401
    );
    global.process.crash()?;
    let response = send(authorized, &origin, &signed).await?;
    assert_eq!(response.status(), 202);
    assert_eq!(
        response.json::<Value>().await?,
        json!({"status":"stored","receipt":receipt})
    );
    run(dir, probe, &["send", "client"]).await?;
    let mut wrong = receipt.clone();
    wrong["workspaceId"] = "other-workspace".into();
    private_json(&dir.join("receipt"), &wrong)?;
    reject(dir, probe, &["send", "client"]).await?;
    private_json(&dir.join("receipt"), &receipt)?;
    let mut roots = rustls::RootCertStore::empty();
    for cert in certs(dir, "ca.crt")? {
        roots.add(cert)?;
    }
    let verifier = rustls::server::WebPkiClientVerifier::builder(Arc::new(roots)).build()?;
    let private =
        rustls_pemfile::private_key(&mut std::io::Cursor::new(fs::read(dir.join("server.key"))?))?
            .context("test key")?;
    let tls = rustls::ServerConfig::builder()
        .with_client_cert_verifier(verifier)
        .with_single_cert(certs(dir, "server.crt")?, private)?;
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?;
    listener.set_nonblocking(true)?;
    let leaks = Arc::new(AtomicUsize::new(0));
    let hit = leaks.clone();
    let router = axum::Router::new().fallback(move |uri: axum::http::Uri| {
        let hit = hit.clone();
        async move {
            if uri.path() == "/leak" {
                hit.fetch_add(1, Ordering::SeqCst);
            }
            (
                axum::http::StatusCode::FOUND,
                [(axum::http::header::LOCATION, "/leak")],
            )
        }
    });
    let server = axum_server::from_tcp_rustls(
        listener,
        axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(tls)),
    )?;
    let redirect = tokio::spawn(server.serve(router.into_make_service()));
    client["origin"] = format!("https://{address}").into();
    private_json(&dir.join("client"), &client)?;
    reject(dir, probe, &["send", "client"]).await?;
    assert_eq!(leaks.load(Ordering::SeqCst), 0);
    redirect.abort();
    client["origin"] = format!("http://{addr}").into();
    private_json(&dir.join("client"), &client)?;
    reject(dir, probe, &["send", "client"]).await
}
fn certs(dir: &Path, name: &str) -> Result<Vec<rustls::pki_types::CertificateDer<'static>>> {
    Ok(
        rustls_pemfile::certs(&mut std::io::Cursor::new(fs::read(dir.join(name))?))
            .collect::<std::io::Result<Vec<_>>>()?,
    )
}

#[tokio::test]
#[ignore = "requires isolated RustFS and native examples"]
async fn provider_deletions_are_scoped_and_indeterminate_outcomes_are_not_retried() -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let f = Fixture::start().await?;
    let region = f.meta("cleanup").await?;
    let dir = f.directory();
    private_json(&dir.join("region"), &region.client)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let observer = tokio::spawn(async move {
        let mut calls = Vec::new();
        for _ in 0..4 {
            let (mut socket, _) = listener.accept().await?;
            let mut buf = Vec::new();
            let mut block = [0; 1024];
            while !buf.windows(4).any(|v| v == b"\r\n\r\n") && buf.len() < 8192 {
                let n = socket.read(&mut block).await?;
                ensure!(n > 0, "incomplete request");
                buf.extend(&block[..n]);
            }
            let text = std::str::from_utf8(&buf)?;
            let line = text.lines().next().context("request line")?.to_owned();
            let files = line == "DELETE /v1/tenant HTTP/1.1";
            let token = if files {
                "bearer test-file-token"
            } else {
                "bearer test-only-token"
            };
            ensure!(
                text.lines()
                    .any(|h| h.to_ascii_lowercase() == format!("authorization: {token}")),
                "wrong cleanup credential"
            );
            if !line.contains("/db_lost ") {
                let (status, body) = if files {
                    ("202 Accepted", r#"{"status":"deleting"}"#)
                } else {
                    ("200 OK", r#"{"message":"Database disabled"}"#)
                };
                socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len()).as_bytes()).await?;
            }
            calls.push(line);
        }
        Ok::<_, anyhow::Error>(calls)
    });
    assert_eq!(
        run(dir, "guest_cleanup_probe", &["region", &origin]).await?["verified"],
        true
    );
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), observer).await???,
        [
            "DELETE /customer/databases/db_guest HTTP/1.1",
            "DELETE /customer/databases/db_lost HTTP/1.1",
            "DELETE /v1/tenant HTTP/1.1",
            "DELETE /v1/tenant HTTP/1.1"
        ]
    );
    Ok(())
}
