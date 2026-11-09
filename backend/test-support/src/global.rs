//! A real Global HTTP process with isolated metadata, signing credentials and OIDC.
use crate::{Fixture, Meta, Process, binary, http_client, private_json, private_write};
use anyhow::{Context, Result, ensure};
use reqwest::{Client, Method, RequestBuilder, header};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    process::Command,
    time::{Duration, Instant},
};

pub struct Global {
    pub origin: String,
    pub config: Value,
    pub http: Client,
    process: Option<Process>,
    config_file: PathBuf,
    plan: PathBuf,
}
impl Global {
    pub async fn start(f: &Fixture, meta: &Meta, origin: String, mut sso: Value) -> Result<Self> {
        let dir = f.directory();
        let key = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| anyhow::anyhow!("generate fixture signing key"))?;
        let pair = Ed25519KeyPair::from_pkcs8(key.as_ref())
            .map_err(|_| anyhow::anyhow!("decode fixture signing key"))?;
        private_write(&dir.join("global-signing.der"), key.as_ref())?;
        private_write(
            &dir.join("global-signing.pub"),
            hex::encode(pair.public_key().as_ref()).as_bytes(),
        )?;
        sso["redirectUri"] = json!(format!("{origin}/api/auth/tidbcloud/callback"));
        let config = json!({"bind":origin.strip_prefix("http://").context("loopback origin")?,"metadata":{"transport":"remote","client":meta.client},
            "publicOrigin":origin,"environment":"test","signerId":"global-fixture","signingKeyFile":dir.join("global-signing.der"),
            "verificationKeyFile":dir.join("global-signing.pub"),"metadataSecurityState":true,"initializeClock":true,
            "regions":[{"regionId":"region:other","apiOrigin":"https://region.example.test","apiPathPrefix":""}],"sso":sso});
        let config_file = dir.join("global-http.json");
        let plan = dir.join("global-plan.json");
        private_json(
            &plan,
            &json!({"format":1,"services":[{"kind":"global","configFile":config_file}]}),
        )?;
        let mut global = Self {
            origin,
            config,
            plan,
            config_file,
            http: http_client()?,
            process: None,
        };
        global.restart(f).await?;
        Ok(global)
    }
    pub async fn stop(&mut self) -> Result<()> {
        if let Some(p) = self.process.as_mut() {
            p.stop_cleanly().await?;
            self.process.take();
        }
        Ok(())
    }
    pub fn crash(&mut self) -> Result<()> {
        let process = self
            .process
            .as_mut()
            .context("Global host is not running")?;
        process.ensure_running()?;
        process.crash()?;
        self.process.take();
        Ok(())
    }
    pub async fn restart(&mut self, f: &Fixture) -> Result<()> {
        self.stop().await?;
        private_json(&self.config_file, &self.config)?;
        let mut p = Process::spawn(
            Command::new(binary("workspace-backend"))
                .arg("serve")
                .arg("--config")
                .arg(&self.plan),
            &f.directory()
                .join(format!("global-{}.log", uuid::Uuid::new_v4())),
        )?;
        let end = Instant::now() + Duration::from_secs(20);
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
            ensure!(Instant::now() < end, "Global did not become healthy");
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
        self.process = Some(p);
        Ok(())
    }
    pub fn owner(
        &self,
        method: Method,
        workspace: &str,
        cookie: &str,
        route: &str,
    ) -> RequestBuilder {
        self.http
            .request(
                method,
                format!(
                    "{}/api/portal/v1/workspaces/{workspace}{route}",
                    self.origin
                ),
            )
            .header(header::ORIGIN, &self.origin)
            .header(header::COOKIE, cookie)
    }
    pub fn agent(
        &self,
        method: Method,
        workspace: &str,
        token: &str,
        route: &str,
    ) -> RequestBuilder {
        self.http
            .request(
                method,
                format!("{}/api/v1/workspaces/{workspace}{route}", self.origin),
            )
            .header(header::ORIGIN, &self.origin)
            .bearer_auth(token)
    }
}

impl Global {
    /// Complete discovery or a Workspace-bound login using the loopback OIDC issuer.
    pub async fn login(&self, workspace: Option<&str>) -> Result<(String, Value)> {
        let mut url = reqwest::Url::parse(&format!("{}/api/auth/tidbcloud/login", self.origin))?;
        if let Some(ws) = workspace {
            url.query_pairs_mut().append_pair("workspaceId", ws);
        }
        let start = self.http.get(url).send().await?;
        ensure!(start.status() == 303, "OIDC login did not redirect");
        let authorize = reqwest::Url::parse(start.headers()[header::LOCATION].to_str()?)?;
        let flow = start.headers()[header::SET_COOKIE]
            .to_str()?
            .split(';')
            .next()
            .context("flow cookie")?
            .to_owned();
        let state = authorize
            .query_pairs()
            .find(|(k, _)| k == "state")
            .context("OIDC state")?
            .1
            .into_owned();
        let code: Value = self
            .http
            .get(authorize)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let mut callback =
            reqwest::Url::parse(&format!("{}/api/auth/tidbcloud/callback", self.origin))?;
        callback
            .query_pairs_mut()
            .append_pair("code", code["code"].as_str().context("OIDC code")?)
            .append_pair("state", &state);
        let r = self
            .http
            .get(callback.clone())
            .header(header::COOKIE, &flow)
            .send()
            .await?
            .error_for_status()?;
        let cookie = r
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .find(|v| v.starts_with("aw_global_owner="))
            .and_then(|v| v.split(';').next())
            .context("owner cookie")?
            .to_owned();
        let data = r.json().await?;
        ensure!(
            self.http
                .get(callback)
                .header(header::COOKIE, flow)
                .send()
                .await?
                .status()
                == 401,
            "replayed OIDC callback accepted"
        );
        Ok((cookie, data))
    }
}
