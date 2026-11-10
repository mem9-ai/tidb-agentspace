//! Two real Workspace APIs sharing a regional metadata authority. Both Workspaces deliberately
//! contain the same resource IDs and file paths so an isolation assertion cannot pass by accident.
use crate::{
    Fixture, Meta, Process, binary,
    expiry_clock::ExpiryClock,
    http_client, private_json, private_write,
    provider::{NATIVE_SECRET, Provider},
    tls::certificates,
};
use anyhow::{Context, Result, ensure};
use reqwest::{Client, Method, RequestBuilder};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde_json::{Value, json};
use std::{
    net::TcpListener,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const IDS: [&str; 2] = ["ws_agentlab", "ws_other"];
pub const REGION: &str = "region:api-coverage";
const STATE: &str = include_str!("../tests/cases/product-state.json");

fn scope(i: usize) -> Value {
    json!({"authorityId":REGION,"ownerKind":"workspace","ownerId":IDS[i],"family":"workspace","partitionId":"primary"})
}
async fn seed(region: &Meta, i: usize, fresh: bool) -> Result<()> {
    let records: serde_json::Map<String, Value> = serde_json::from_str(
        &STATE
            .replace("WORKSPACE_ID", IDS[i])
            .replace("$private-provider-credential", NATIVE_SECRET),
    )?;
    let mut changes: Vec<_> = records
        .into_iter()
        .filter(|(key, _)| {
            !fresh || !(key.starts_with("state/files/") || key.starts_with("state/resources/"))
        })
        .map(|(key, value)| json!({"key":key,"expectedVersion":null,"value":value}))
        .collect();
    if fresh {
        // Production writes the empty index in the same commit as a new Workspace.
        changes.push(workspace_contracts::initial_resource_index());
    }
    region.call(json!({"op":"commit","scope":scope(i),"mutationId":Uuid::new_v4().to_string(),"changes":changes})).await?;
    Ok(())
}
pub fn signer(dir: &Path, name: &str) -> Result<(PathBuf, PathBuf)> {
    let key = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
        .map_err(|_| anyhow::anyhow!("fixture key generation"))?;
    let pair = Ed25519KeyPair::from_pkcs8(key.as_ref())
        .map_err(|_| anyhow::anyhow!("fixture key loading"))?;
    let private = dir.join(format!("{name}.der"));
    let public = dir.join(format!("{name}.pub"));
    private_write(&private, key.as_ref())?;
    private_write(&public, hex::encode(pair.public_key().as_ref()).as_bytes())?;
    Ok((private, public))
}
fn reserve_workspace_ports() -> Result<Vec<(TcpListener, TcpListener)>> {
    IDS.iter()
        .map(|_| {
            Ok((
                TcpListener::bind("127.0.0.1:0")?,
                TcpListener::bind("127.0.0.1:0")?,
            ))
        })
        .collect()
}
struct Host {
    config: Value,
    global: Value,
    region_file: PathBuf,
    global_file: PathBuf,
    directory: PathBuf,
    plan: PathBuf,
    executable: PathBuf,
    process: Option<Process>,
    cookie: String,
    global_cookie: String,
    origin: String,
}
impl Host {
    async fn launch(
        &mut self,
        client: &Client,
        mut services: Vec<Value>,
        global_available: bool,
        stage: &str,
    ) -> Result<()> {
        private_json(&self.region_file, &self.config)?;
        private_json(&self.global_file, &self.global)?;
        services.extend([
            json!({"kind":"workspace","configFile":self.region_file}),
            json!({"kind":"global","configFile":self.global_file}),
        ]);
        private_json(&self.plan, &json!({"format":1,"services":services}))?;
        let log = self.directory.join(format!("{}.log", Uuid::new_v4()));
        let mut process = Process::spawn(
            Command::new(&self.executable)
                .args(["serve", "--config"])
                .arg(&self.plan),
            &log,
        )?;
        let workspace = self.config["workspaceId"].as_str().context("workspaceId")?;
        let ready = format!(
            "Rust full regional API listening on {}.",
            self.config["bind"].as_str().context("bind")?
        );
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut observation = String::from("waiting for the child to bind the API");
        loop {
            let output = std::fs::read_to_string(&log)?;
            if let Some(reason) = output.lines().find(|s| {
                s.starts_with("Workspace startup unavailable for ")
                    || s.starts_with("Metadata startup unavailable for ")
                    || s.starts_with("Regional dependency unavailable for ")
            }) {
                anyhow::bail!("{workspace} {stage}: {reason}");
            }
            process
                .ensure_running()
                .with_context(|| format!("{workspace} {stage}: {observation}"))?;
            // A refused HTTP request cannot distinguish a failed Workspace from its
            // healthy sibling roles. Conversely, another listener can return HTTP 200.
            if output.lines().any(|line| line == ready) {
                let response = client
                    .get(format!("{}/api/health", self.origin))
                    .timeout(Duration::from_secs(1))
                    .send()
                    .await;
                observation = match response {
                    Ok(r) if r.status() == 200 => {
                        if r.json::<Value>().await.is_ok_and(|v| v["status"] == "ok") {
                            break;
                        }
                        "health returned an invalid readiness document".into()
                    }
                    Ok(r) => {
                        let status = r.status();
                        let code = r.json::<Value>().await.ok().and_then(|v| {
                            v["error"]["code"]
                                .as_str()
                                .filter(|s| {
                                    s.len() <= 64
                                        && s.bytes().all(|b| b.is_ascii_uppercase() || b == b'_')
                                })
                                .map(str::to_owned)
                        });
                        format!(
                            "health HTTP {status} ({})",
                            code.as_deref().unwrap_or("unknown")
                        )
                    }
                    Err(e) if e.is_timeout() => "health request timed out".into(),
                    Err(_) => "could not connect to the bound API".into(),
                };
            }
            ensure!(
                Instant::now() < deadline,
                "{workspace} {stage}: {observation}"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        for (prefix, status) in [("", 200), ("/api/global", 201)] {
            if !global_available && !prefix.is_empty() {
                continue;
            }
            let r = client
                .post(format!("{}{prefix}/api/session", self.origin))
                .header("Origin", &self.origin)
                .json(&json!({}))
                .send()
                .await?;
            ensure!(
                r.status() == status,
                "session creation failed ({prefix} {}): {}",
                r.status(),
                r.text().await?
            );
            let cookie = r
                .headers()
                .get("set-cookie")
                .context("session cookie")?
                .to_str()?
                .split(';')
                .next()
                .unwrap()
                .to_owned();
            if prefix.is_empty() {
                self.cookie = cookie;
            } else {
                self.global_cookie = cookie;
            }
        }
        self.process = Some(process);
        Ok(())
    }
}

pub struct Workspaces {
    hosts: Vec<Host>,
    pub provider: Provider,
    pub region: Meta,
    global_meta: Meta,
    global_available: bool,
    storage: Fixture,
    http: Client,
    embedded: bool,
}
impl Workspaces {
    pub async fn start(embedded: bool, fresh: bool) -> Result<Self> {
        Self::configured(embedded, fresh, false).await
    }
    pub async fn configured(
        embedded: bool,
        fresh: bool,
        metadata_security_state: bool,
    ) -> Result<Self> {
        Self::with_files(
            embedded,
            fresh,
            metadata_security_state,
            "drive9-anonymous",
            None,
            |_| Ok(None),
        )
        .await
    }
    pub async fn local_files(embedded: bool, fresh: bool) -> Result<Self> {
        Self::with_files(embedded, fresh, false, "local", None, |_| Ok(None)).await
    }
    /// Only the primary Workspace and its Global authority use the SDK's adjustable clock.
    pub async fn with_expiry_clock() -> Result<(Self, ExpiryClock)> {
        let host = binary("examples").join("expiry_clock_host");
        let f = Self::with_files(false, false, false, "drive9-anonymous", Some(host), |_| {
            Ok(None)
        })
        .await?;
        let clock = ExpiryClock::in_directory(&f.hosts[0].directory);
        Ok((f, clock))
    }
    /// Route only the Global hosts' authenticated Meta traffic through a loopback fault fixture.
    pub async fn with_global_meta_route(
        route: impl FnOnce(&Meta) -> Result<String>,
    ) -> Result<Self> {
        Self::with_files(true, false, false, "drive9-anonymous", None, |meta| {
            route(meta).map(Some)
        })
        .await
    }

    async fn with_files(
        embedded: bool,
        fresh: bool,
        metadata_security_state: bool,
        files_provider: &str,
        mut primary_clock_host: Option<PathBuf>,
        route_global: impl FnOnce(&Meta) -> Result<Option<String>>,
    ) -> Result<Self> {
        let storage = Fixture::start().await?;
        let mut region = storage.meta("api-coverage").await?;
        let global_meta = storage.meta("global").await?;
        let mut global_client = global_meta.client.clone();
        if let Some(origin) = route_global(&global_meta)? {
            global_client["origin"] = json!(origin);
        }
        let provider = Provider::start(false).await?;
        {
            let mut state = provider.state.lock().unwrap();
            state.require_file_auth = true;
            state
                .file_tenants
                .insert(NATIVE_SECRET.into(), "coverage-tenant".into());
        }
        let client = http_client()?;
        let reservations = reserve_workspace_ports()?;
        for i in 0..IDS.len() {
            seed(&region, i, fresh).await?;
        }
        if embedded {
            region
                .process
                .stop_cleanly()
                .await
                .context("stopping regional Meta")?;
        }
        let mut hosts = Vec::new();
        for (i, (listen, control)) in reservations.into_iter().enumerate() {
            let dir = storage.directory().join(IDS[i]);
            std::fs::create_dir(&dir)?;
            let addr = listen.local_addr()?.to_string();
            let control_addr = control.local_addr()?.to_string();
            let origin = format!("http://{addr}");
            let global_origin = format!("{origin}/api/global");
            let (server_tls, client_tls) = certificates(&dir)?;
            let (g_priv, g_pub) = signer(&dir, "global")?;
            let (r_priv, r_pub) = signer(&dir, "regional")?;
            let control_origin = format!("https://{control_addr}");
            let mut region_connection = server_tls.clone();
            region_connection["bind"] = json!(control_addr);
            region_connection["allowedRegions"] =
                json!([{"regionId":REGION,"certificateFile":client_tls["certificateFile"]}]);
            let global = json!({"bind":addr,"metadata":{"transport":"remote","client":global_client},"publicOrigin":origin,"publicPath":"/api/global","sharedListener":true,"environment":"test","signerId":"global-fixture","signingKeyFile":g_priv,"verificationKeyFile":g_pub,"clockDirectory":dir.join("global-clock"),"initializeClock":true,"localWorkspace":{"workspaceId":IDS[i],"regionId":REGION},"regions":[{"regionId":REGION,"apiOrigin":origin,"apiPathPrefix":""}],"regionConnection":region_connection,"regionControls":[{"regionId":REGION,"origin":control_origin,"tls":client_tls}]});
            let mut server_control = server_tls.clone();
            server_control["bind"] = json!(control_addr);
            server_control["globalClientCertificates"] = json!([client_tls["certificateFile"]]);
            let security = json!({"metadataSecurityState":metadata_security_state && i==0,"publicOrigin":origin,"environment":"test","globalIssuer":global_origin,"globalSignerId":"global-fixture","globalPublicKeyFile":g_pub,"regionalSignerId":"region-fixture","regionalSigningKeyFile":r_priv,"regionalPublicKeyFile":r_pub,"clockDirectory":dir.join("region-clock"),"initializeClock":true,"accessTokenTtl":900,"control":server_control,"regionConnection":{"origin":control_origin,"tls":client_tls}});
            let transport = if embedded && i == 0 {
                json!({"transport":"inProcess","authorityId":REGION})
            } else {
                json!({"transport":"remote","client":region.client})
            };
            let config = json!({"bind":addr,"workspaceId":IDS[i],"authorityId":REGION,"insecureLoopback":true,"publicOrigins":[origin],"consoleOrigins":["http://127.0.0.1:5173"],"metadata":transport,"security":security,"product":{"providers":{"filesProvider":files_provider,"postgresProvider":"db9-anonymous","testMode":true,"drive9Endpoint":provider.origin,"db9Endpoint":format!("{}/customer",provider.origin),"sqlFixture":format!("{}/sql",provider.origin)}}});
            let executable = if let Some(host) = primary_clock_host.take() {
                ExpiryClock::in_directory(&dir).initialize()?;
                host
            } else {
                binary("workspace-backend")
            };
            let mut host = Host {
                executable,
                origin,
                config,
                global,
                plan: dir.join("plan.json"),
                region_file: dir.join("region.json"),
                global_file: dir.join("global.json"),
                directory: dir,
                cookie: String::new(),
                global_cookie: String::new(),
                process: None,
            };
            drop(listen);
            drop(control);
            let mut roles = Vec::new();
            if embedded && i == 0 {
                let metadata = storage.directory().join("embedded-meta.json");
                private_json(&metadata, &region.server)?;
                roles.push(json!({"kind":"metadata","configFile":metadata}));
            }
            host.launch(&client, roles, true, "initial startup").await?;
            hosts.push(host);
        }
        Ok(Self {
            hosts,
            provider,
            region,
            global_meta,
            global_available: true,
            storage,
            http: client,
            embedded,
        })
    }
    pub fn at(&self, i: usize, method: Method, path: &str, cookie: bool) -> RequestBuilder {
        let host = &self.hosts[i];
        let req = self
            .http
            .request(method, format!("{}{path}", host.origin))
            .header("Origin", &host.origin);
        if cookie {
            req.header("Cookie", &host.cookie)
        } else {
            req
        }
    }
    pub async fn guarded(&self, op: &str, parameters: Value) -> Result<Value> {
        let scope = scope(0);
        let writer = self
            .region
            .call(json!({"op":"get","scope":scope,"keys":["system/writer"]}))
            .await?;
        let mut input = parameters;
        input["scope"] = scope;
        input["op"] = json!(op);
        input["guard"] = json!({"ownerId":writer["records"]["system/writer"]["value"]["ownerId"]});
        self.region.call(input).await
    }
    pub async fn seed_files(&self, count: usize, resource: Option<&str>) -> Result<()> {
        self.seed_scale("files",count,|n|{
            let id=format!("file_scale_{n:08}");
            let resource_id=resource.map(str::to_owned).unwrap_or_else(||format!("fs_cold_{n}"));
            let path=resource.map(|_|format!("/synthetic-{n:08}.txt")).unwrap_or_else(||"/cold.txt".into());
            json!({"id":id,"resourceId":resource_id,"path":path,"type":"file","content":"synthetic"})
        }).await
    }
    pub async fn seed_scale(
        &self,
        family: &str,
        count: usize,
        mut record: impl FnMut(usize) -> Value,
    ) -> Result<()> {
        for offset in (0..count).step_by(1000) {
            let changes:Vec<_>=(offset..(offset+1000).min(count)).map(|n|{
                let v=record(n); let id=v["id"].as_str().unwrap();
                json!({"key":format!("state/{family}/{id}"),"expectedVersion":null,"value":{"position":n+100,"record":v}})
            }).collect();
            self.guarded(
                "commit",
                json!({"mutationId":Uuid::new_v4().to_string(),"changes":changes}),
            )
            .await?;
        }
        Ok(())
    }
    pub fn global_meta(&self) -> &Meta {
        &self.global_meta
    }
    pub fn crash_global_meta(&mut self) -> Result<()> {
        self.global_meta.process.crash()?;
        self.global_available = false;
        Ok(())
    }
    pub fn global_meta_running(&mut self) -> bool {
        self.global_meta.process.ensure_running().is_ok()
    }
    pub fn control(&self, i: usize) -> (&Value, &Value) {
        (
            &self.hosts[i].global["regionConnection"],
            &self.hosts[i].global["regionControls"][0]["tls"],
        )
    }
    pub fn global_profile(
        &self,
        i: usize,
        method: Method,
        path: &str,
        token: Option<&str>,
    ) -> RequestBuilder {
        let h = &self.hosts[i];
        let req = self
            .http
            .request(method, format!("{}/api/global{path}", h.origin))
            .header("Origin", &h.origin);
        if let Some(t) = token {
            req.bearer_auth(t)
        } else {
            req.header("Cookie", &h.global_cookie)
        }
    }
    pub fn origin(&self, i: usize) -> &str {
        &self.hosts[i].origin
    }
    pub fn owner(&self, i: usize, method: Method, route: &str) -> RequestBuilder {
        let host = &self.hosts[i];
        self.http
            .request(
                method,
                format!("{}/api/portal/v1/workspaces/{}{route}", host.origin, IDS[i]),
            )
            .header("Origin", &host.origin)
            .header("Cookie", &host.cookie)
    }
    pub fn agent(
        &self,
        i: usize,
        method: Method,
        route: &str,
        token: Option<&str>,
    ) -> RequestBuilder {
        let host = &self.hosts[i];
        let req = self
            .http
            .request(
                method,
                format!("{}/api/v1/workspaces/{}{route}", host.origin, IDS[i]),
            )
            .header("Origin", &host.origin);
        if let Some(token) = token {
            req.bearer_auth(token)
        } else {
            req
        }
    }
    pub fn global(
        &self,
        i: usize,
        method: Method,
        route: &str,
        token: Option<&str>,
    ) -> RequestBuilder {
        let host = &self.hosts[i];
        let profile = if token.is_some() {
            "/api/v1"
        } else {
            "/api/portal/v1"
        };
        let req = self
            .http
            .request(
                method,
                format!(
                    "{}/api/global{profile}/workspaces/{}{route}",
                    host.origin, IDS[i]
                ),
            )
            .header("Origin", &host.origin);
        if let Some(token) = token {
            req.bearer_auth(token)
        } else {
            req.header("Cookie", &host.global_cookie)
        }
    }
    pub async fn create_key(
        &self,
        i: usize,
        name: &str,
        scopes: &[&str],
        resources: &[&str],
    ) -> Result<Value> {
        let expiry = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() + 7 * 86400;
        expect(self.global(i,Method::POST,"/keys",None).header("Idempotency-Key",Uuid::new_v4().to_string()).json(&json!({"name":name,"scopes":scopes,"resourceIds":resources,"expiresAt":expiry})),201).await
    }
    pub async fn exchange(&self, i: usize, secret: &str) -> Result<String> {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let r = self
                .global(i, Method::POST, "/token-issuances", Some(secret))
                .json(&json!({"audience":REGION}))
                .send()
                .await?;
            let status = r.status();
            let body = r.json::<Value>().await?;
            if status == 503
                && body["error"]["code"] == "POLICY_DELIVERY_UNKNOWN"
                && Instant::now() < deadline
            {
                tokio::time::sleep(Duration::from_millis(250)).await;
                continue;
            }
            ensure!(
                status == 201,
                "key exchange {status} {}",
                body["error"]["code"]
            );
            return Ok(body["accessToken"].as_str().context("accessToken")?.into());
        }
    }
    pub async fn revoke(&self, i: usize, key: &Value) -> Result<()> {
        revoke_and_confirm(
            |method, path| self.global(i, method, path, None),
            key,
            Duration::from_secs(30),
        )
        .await
    }
    pub async fn records(&self, i: usize, keys: &[&str]) -> Result<Value> {
        let scope = scope(i);
        let writer = self
            .region
            .call(json!({"op":"get","scope":scope,"keys":["system/writer"]}))
            .await?;
        let guard = json!({"ownerId":writer["records"]["system/writer"]["value"]["ownerId"]});
        Ok(self
            .region
            .call(json!({"op":"get","scope":scope,"guard":guard,"keys":keys}))
            .await?["records"]
            .clone())
    }
    pub async fn restart(&mut self, crash: bool) -> Result<()> {
        let mut owners = Vec::new();
        let mut meta_owner = Value::Null;
        if crash {
            for i in 0..self.hosts.len() {
                let writer = self
                    .region
                    .call(json!({"op":"get","scope":scope(i),"keys":["system/writer"]}))
                    .await?;
                owners.push(writer["records"]["system/writer"]["value"]["ownerId"].clone());
            }
            if self.embedded {
                meta_owner = self.region.health().await?["ownerId"].clone();
            }
        }
        for host in self.hosts.iter_mut().rev() {
            if let Some(mut process) = host.process.take() {
                if crash {
                    process.crash()?;
                } else {
                    process
                        .stop_cleanly()
                        .await
                        .with_context(|| format!("draining {}", host.config["workspaceId"]))?;
                }
            }
        }
        if !self.embedded {
            self.region
                .process
                .stop_cleanly()
                .await
                .context("stopping regional Meta")?;
            self.region = self
                .storage
                .start_meta(self.region.server.clone(), false, None)
                .await?;
        }
        for (i, host) in self.hosts.iter_mut().enumerate() {
            host.config["recoverWriterOwner"] = owners.get(i).cloned().unwrap_or(Value::Null);
            host.global["initializeClock"] = json!(false);
            host.config["security"]["initializeClock"] = json!(false);
            let mut roles = Vec::new();
            if self.embedded && i == 0 {
                roles.push(json!({"kind":"metadata","configFile":self.storage.directory().join("embedded-meta.json"),"recoverOwner":meta_owner}));
            }
            host.launch(
                &self.http,
                roles,
                self.global_available,
                if crash {
                    "crash recovery"
                } else {
                    "graceful restart"
                },
            )
            .await?;
        }
        Ok(())
    }
}
async fn revoke_and_confirm(
    request: impl Fn(Method, &str) -> RequestBuilder,
    key: &Value,
    timeout: Duration,
) -> Result<()> {
    let id = key["keyId"].as_str().unwrap();
    let version = key["keyVersion"].as_u64().unwrap();
    let revoked = expect(
        request(Method::DELETE, &format!("/keys/{id}"))
            .header("Idempotency-Key", Uuid::new_v4().to_string())
            .header("If-Match", format!("\"{version}\"")),
        202,
    )
    .await?;
    let mut status = revoked["regionalStatus"].clone();
    let until = Instant::now() + timeout;
    while status == "pending" && Instant::now() < until {
        let delivered = expect(
            request(Method::POST, "/key-policy-deliveries")
                .header("Idempotency-Key", Uuid::new_v4().to_string())
                .json(&json!({"keyId":id,"keyVersion":version+1})),
            201,
        )
        .await?;
        status = delivered["data"]["regionalStatus"].clone();
        if status == "pending" {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
    ensure!(status == "applied", "regional revocation was not applied");
    Ok(())
}
pub async fn expect(request: RequestBuilder, status: u16) -> Result<Value> {
    let r = request.send().await?;
    let actual = r.status();
    let bytes = r.bytes().await?;
    let body: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)?
    };
    ensure!(
        actual == status,
        "expected HTTP {status}, got {actual} {}",
        body["error"]["code"]
    );
    Ok(body)
}

impl Drop for Workspaces {
    fn drop(&mut self) {
        for host in self.hosts.iter_mut().rev() {
            drop(host.process.take());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeSet, io::ErrorKind};
    #[tokio::test]
    async fn revocation_requires_an_applied_receipt_for_the_same_key_version() -> Result<()> {
        use axum::{
            Json, Router,
            extract::{Path, State},
            http::{HeaderMap, StatusCode},
            routing::{delete, post},
        };
        use std::sync::{Arc, Mutex};
        let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
        let app=Router::new()
            .route("/keys/{id}",delete(|Path(id):Path<String>, State(calls):State<Arc<Mutex<Vec<Value>>>>, h:HeaderMap| async move {
                calls.lock().unwrap().push(json!(["revoke", id, h["if-match"].to_str().unwrap()]));
                (StatusCode::ACCEPTED,Json(json!({"regionalStatus":if id=="applied-key"{"applied"}else{"pending"}})))
            }))
            .route("/key-policy-deliveries",post(|State(calls):State<Arc<Mutex<Vec<Value>>>>,Json(v):Json<Value>| async move {
                let mut calls=calls.lock().unwrap();
                calls.push(json!(["deliver",v["keyId"],v["keyVersion"]]));
                (StatusCode::CREATED,Json(json!({"data":{"regionalStatus":if calls.len()==2{"pending"}else{"applied"}}})))
            })).with_state(calls.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let origin = format!("http://{}", listener.local_addr()?);
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = http_client()?;
        let request =
            |method: Method, path: &str| client.request(method, format!("{origin}{path}"));
        revoke_and_confirm(
            request,
            &json!({"keyId":"test-key","keyVersion":4}),
            Duration::from_secs(2),
        )
        .await?;
        assert_eq!(
            *calls.lock().unwrap(),
            vec![
                json!(["revoke", "test-key", "\"4\""]),
                json!(["deliver", "test-key", 5]),
                json!(["deliver", "test-key", 5])
            ]
        );
        calls.lock().unwrap().clear();
        revoke_and_confirm(
            request,
            &json!({"keyId":"applied-key","keyVersion":1}),
            Duration::ZERO,
        )
        .await?;
        let unconfirmed = revoke_and_confirm(
            request,
            &json!({"keyId":"test-key","keyVersion":1}),
            Duration::ZERO,
        )
        .await
        .unwrap_err();
        assert!(unconfirmed.to_string().contains("not applied"));
        assert_eq!(
            *calls.lock().unwrap(),
            vec![
                json!(["revoke", "applied-key", "\"1\""]),
                json!(["revoke", "test-key", "\"1\""])
            ]
        );
        server.abort();
        Ok(())
    }
    #[test]
    fn workspace_ports_stay_reserved_until_the_owner_releases_them() -> Result<()> {
        let mut reservations = reserve_workspace_ports()?;
        let addresses = reservations
            .iter()
            .flat_map(|(api, control)| [api.local_addr().unwrap(), control.local_addr().unwrap()])
            .collect::<BTreeSet<_>>();
        assert_eq!(addresses.len(), 4);
        let (api, _) = reservations.pop().unwrap();
        let address = api.local_addr()?;
        assert_eq!(
            TcpListener::bind(address).unwrap_err().kind(),
            ErrorKind::AddrInUse
        );
        drop(api);
        let _reacquired = TcpListener::bind(address)?;
        Ok(())
    }
}
