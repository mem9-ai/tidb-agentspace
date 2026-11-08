use super::*;
use crate::global::{checked, documented};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use reqwest::{Client, Method, RequestBuilder, header};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use workspace_openapi::View;
use workspace_test_support::{
    Process,
    global::Global,
    http_client,
    oidc::Provider as Oidc,
    port,
    provider::{Provider, SqlResponse},
    tls::certificates,
};

#[path = "region_journey.rs"]
mod journey;

const AUTHORITY: &str = "region:other";
static CONTRACT: LazyLock<Value> = LazyLock::new(|| View::Regional.document());
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
fn create_signer() -> Result<(Vec<u8>, Ed25519KeyPair)> {
    let der = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
        .map_err(|_| anyhow::anyhow!("create signing key"))?;
    let key = Ed25519KeyPair::from_pkcs8(der.as_ref())
        .map_err(|_| anyhow::anyhow!("decode signing key"))?;
    Ok((der.as_ref().to_owned(), key))
}
struct Proof {
    key: Ed25519KeyPair,
    jwk: Value,
    thumbprint: String,
}
impl Proof {
    fn create() -> Result<Self> {
        let (_, key) = create_signer()?;
        let x = B64.encode(key.public_key().as_ref());
        let jwk = json!({"crv":"Ed25519","kty":"OKP","x":x});
        let thumbprint = B64.encode(Sha256::digest(format!(
            r#"{{"crv":"Ed25519","kty":"OKP","x":"{x}"}}"#
        )));
        Ok(Self {
            key,
            jwk,
            thumbprint,
        })
    }
    fn sign(&self, uri: &str, nonce: &str) -> String {
        let header = B64.encode(
            serde_json::to_vec(&json!({"alg":"EdDSA","typ":"dpop+jwt","jwk":self.jwk})).unwrap(),
        );
        let claims = B64.encode(
            serde_json::to_vec(
                &json!({"jti":id(),"htm":"POST","htu":uri,"nonce":nonce,"iat":now()}),
            )
            .unwrap(),
        );
        let signed = format!("{header}.{claims}");
        format!(
            "{signed}.{}",
            B64.encode(self.key.sign(signed.as_bytes()).as_ref())
        )
    }
}
struct Regional {
    origin: String,
    http: Client,
    config: Value,
    process: Option<Process>,
    covered: Mutex<BTreeSet<String>>,
}
impl Regional {
    async fn create(
        f: &Fixture,
        meta: &Meta,
        g: &Global,
        workspace: &str,
        provider: &Provider,
        control: &str,
        tls: (&Value, &Value),
    ) -> Result<Self> {
        let origin = format!("http://127.0.0.1:{}", port()?);
        let (der, key) = create_signer()?;
        private_write(&f.directory().join("regional.der"), &der)?;
        private_write(
            &f.directory().join("regional.pub"),
            hex::encode(key.public_key().as_ref()).as_bytes(),
        )?;
        let mut legacy = tls.0.clone();
        legacy["bind"] = format!("127.0.0.1:{}", port()?).into();
        legacy["globalClientCertificates"] = json!([tls.1["certificateFile"]]);
        let config = json!({"bind":origin.strip_prefix("http://").unwrap(),"workspaceId":workspace,"authorityId":AUTHORITY,
            "insecureLoopback":true,"consoleOrigins":[g.origin],"publicOrigins":[origin],"metadata":{"transport":"remote","client":meta.client},
            "product":{"providers":{"filesProvider":"drive9-anonymous","postgresProvider":"db9-anonymous","testMode":true,
                "drive9Endpoint":provider.origin,"db9Endpoint":format!("{}/customer",provider.origin),"sqlFixture":format!("{}/sql",provider.origin)}},
            "security":{"publicOrigin":origin,"environment":"test","globalIssuer":g.origin,"globalSignerId":"global-fixture",
                "globalPublicKeyFile":g.config["verificationKeyFile"],"regionalSignerId":"region-fixture",
                "regionalSigningKeyFile":f.directory().join("regional.der"),"regionalPublicKeyFile":f.directory().join("regional.pub"),
                "metadataSecurityState":true,"initializeClock":true,"accessTokenTtl":3,"control":legacy,
                "regionConnection":{"origin":control,"tls":tls.1}}});
        private_json(
            &f.directory().join("region-plan"),
            &json!({"format":1,"services":[{"kind":"workspace","configFile":f.directory().join("regional-http")}]}),
        )?;
        let mut region = Self {
            origin,
            http: http_client()?,
            config,
            process: None,
            covered: Mutex::default(),
        };
        region.restart(f).await?;
        Ok(region)
    }
    fn stop(&mut self) -> Result<()> {
        if let Some(mut p) = self.process.take() {
            p.stop()?;
        }
        Ok(())
    }
    async fn restart(&mut self, f: &Fixture) -> Result<()> {
        self.stop()?;
        private_json(&f.directory().join("regional-http"), &self.config)?;
        let mut p = Process::spawn(
            std::process::Command::new(binary("workspace-backend"))
                .args(["serve", "--config"])
                .arg(f.directory().join("region-plan")),
            &f.directory().join(format!("region-{}.log", id())),
        )?;
        let end = Instant::now() + Duration::from_secs(15);
        loop {
            p.ensure_running()?;
            if let Ok(r) = self
                .http
                .get(format!("{}/api/health", self.origin))
                .send()
                .await
                && r.status().is_success()
            {
                break;
            }
            ensure!(Instant::now() < end, "Region startup timed out");
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
        self.process = Some(p);
        Ok(())
    }
    fn url(&self, ws: &str, path: &str) -> String {
        format!("{}/api/v1/workspaces/{ws}{path}", self.origin)
    }
    fn req(&self, method: Method, ws: &str, path: &str) -> RequestBuilder {
        self.http
            .request(method, self.url(ws, path))
            .header(header::ORIGIN, &self.origin)
    }
    async fn security(&self, req: RequestBuilder, expected: &[u16]) -> Result<Value> {
        let (body, _, op) = documented(req, expected, &CONTRACT, true).await?;
        if expected.iter().all(|s| (200..300).contains(s)) {
            self.covered.lock().unwrap().insert(op);
        }
        Ok(body)
    }
    async fn enroll(&self, ws: &str, issue: &Value, proof: &Proof) -> Result<Value> {
        let path = "/refresh-families";
        self.security(
            self.req(Method::POST, ws, path)
                .header(
                    "DPoP",
                    proof.sign(&self.url(ws, path), field(issue, "nonce")),
                )
                .json(&json!({"ticket":issue["enrollmentTicket"]})),
            &[201],
        )
        .await
    }
    fn refresh(&self, ws: &str, family: &Value, proof: Option<&Proof>) -> RequestBuilder {
        let path = "/token-issuances";
        let mut r = self
            .req(Method::POST, ws, path)
            .header(
                header::AUTHORIZATION,
                format!("Refresh {}", field(family, "refreshCredential")),
            )
            .json(&json!({"keyId":family["keyId"]}));
        if let Some(p) = proof {
            r = r.header("DPoP", p.sign(&self.url(ws, path), field(family, "nonce")));
        }
        r
    }
    async fn renew(&self, ws: &str, family: &mut Value, proof: &Proof) -> Result<String> {
        *family = self
            .security(self.refresh(ws, family, Some(proof)), &[201])
            .await?;
        Ok(field(family, "accessToken").into())
    }
}
async fn result(req: RequestBuilder, status: u16) -> Result<Value> {
    let r = req.send().await?;
    let path = r.url().path().to_owned();
    let actual = r.status().as_u16();
    let data: Value = r.json().await?;
    ensure!(
        actual == status,
        "{path}: expected {status}, got {actual} ({})",
        data["error"]["code"]
    );
    Ok(data)
}
async fn new_key(
    g: &Global,
    ws: &str,
    cookie: &str,
    scopes: &[&str],
    resources: &Value,
    expires: u64,
) -> Result<Value> {
    Ok(checked(
        g.owner(Method::POST, ws, cookie, "/keys")
            .header("Idempotency-Key", id())
            .json(&json!({"scopes":scopes,"resourceIds":resources,"expiresAt":expires})),
        201,
    )
    .await?
    .0)
}
async fn issuance(g: &Global, ws: &str, key: &Value, proof: &Proof, status: u16) -> Result<Value> {
    Ok(checked(
        g.agent(Method::POST, ws, field(key, "secret"), "/token-issuances")
            .json(&json!({"audience":AUTHORITY,"clientThumbprint":proof.thumbprint})),
        status,
    )
    .await?
    .0)
}
async fn revoke(g: &Global, ws: &str, cookie: &str, key: &Value) -> Result<Value> {
    Ok(checked(
        g.owner(
            Method::DELETE,
            ws,
            cookie,
            &format!("/keys/{}", field(&key["data"], "keyId")),
        )
        .header("Idempotency-Key", id())
        .header(header::IF_MATCH, "\"1\""),
        202,
    )
    .await?
    .0)
}
async fn extend_key(g: &Global, ws: &str, cookie: &str, key: &Value) -> Result<Value> {
    Ok(checked(
        g.owner(
            Method::PATCH,
            ws,
            cookie,
            &format!("/keys/{}", field(&key["data"], "keyId")),
        )
        .header("Idempotency-Key", id())
        .header(header::IF_MATCH, "\"1\"")
        .json(&json!({"expiresAt":now()+3600})),
        200,
    )
    .await?
    .0)
}
