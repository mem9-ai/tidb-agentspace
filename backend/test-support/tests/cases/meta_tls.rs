use super::*;
use reqwest::{Certificate, Client, Identity, tls::Version};
use std::time::Duration;
use workspace_test_support::{Process, tls::certificates};

#[tokio::test]
#[ignore = "requires RustFS, native Meta and openssl"]
async fn mutual_tls_checks_peer_identity_certificate_purpose_and_protocol() -> Result<()> {
    let f = Fixture::start().await?;
    let mut local = f.meta("tls-local").await?;
    local.process.stop()?;
    let (server, client_tls) = certificates(f.directory())?;
    let mut config = local.server.clone();
    config["insecureLoopback"] = json!(false);
    config["tls"] = server;
    config["s3"]["allowLoopbackHttp"] = json!(true);
    let file = f.directory().join("tls.json");
    private_json(&file, &config)?;
    let mut m = Process::spawn(
        Command::new(binary("workspace-meta-service"))
            .arg("--config")
            .arg(&file),
        &f.directory().join("tls.log"),
    )?;
    let addr: std::net::SocketAddr = config["bind"].as_str().unwrap().parse()?;
    let client = |role: Option<&str>, max_version| -> Result<Client> {
        let mut b = Client::builder()
            .no_proxy()
            .tls_certs_only(Certificate::from_pem_bundle(&fs::read(
                f.directory().join("ca.crt"),
            )?)?)
            .resolve("wrong.example", addr)
            .tls_version_max(max_version)
            .timeout(Duration::from_secs(2));
        if let Some(role) = role {
            let mut pem = fs::read(f.directory().join(format!("{role}.crt")))?;
            pem.extend(fs::read(f.directory().join(format!("{role}.key")))?);
            b = b.identity(Identity::from_pem(&pem)?);
        }
        Ok(b.build()?)
    };
    let url = format!("https://{addr}/health");
    let token = fs::read_to_string(config["tokenFile"].as_str().unwrap())?;
    let valid = client(Some("client"), Version::TLS_1_3)?;
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            m.ensure_running()?;
            if let Ok(res) = valid
                .get(&url)
                .bearer_auth(token.trim())
                .header("X-Meta-Authority", config["authorityId"].as_str().unwrap())
                .header(
                    "X-Meta-Installation",
                    config["installationId"].as_str().unwrap(),
                )
                .send()
                .await
            {
                assert!(res.status().is_success());
                assert_eq!(
                    res.json::<Value>().await?["authorityId"],
                    config["authorityId"]
                );
                break Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await??;
    for c in [
        client(None, Version::TLS_1_3)?,
        client(Some("server"), Version::TLS_1_3)?,
        client(Some("client"), Version::TLS_1_2)?,
    ] {
        assert!(c.get(&url).send().await.is_err());
    }
    assert!(
        valid
            .get(format!("https://wrong.example:{}/health", addr.port()))
            .send()
            .await
            .is_err()
    );
    let mut cfg = local.client.clone();
    cfg["origin"] = json!(format!("https://{addr}"));
    cfg["insecureLoopback"] = json!(false);
    cfg["tls"] = client_tls;
    cfg["tokenFile"] = json!(f.directory().join("missing-token"));
    assert!(
        workspace_meta_client::RemoteMetadata::connect(serde_json::from_value(cfg)?)
            .await
            .is_err()
    );
    Ok(())
}
