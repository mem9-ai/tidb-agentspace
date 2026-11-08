use anyhow::{Context, Result, ensure};
use reqwest::{Client, Method, RequestBuilder};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
use workspace_test_support::{
    Fixture, Meta, Process, binary, http_client, oidc::Provider, port, private_json,
    tls::certificates, workspaces::signer,
};

pub const BASE: &str = "/api/v1/workspaces/ws_agentlab";
pub const GLOBAL: &str = "/studio/api/global";
pub const AUTH: &str = "/studio/api/auth/tidbcloud";

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

pub struct Reply {
    pub headers: reqwest::header::HeaderMap,
    pub status: u16,
    pub body: Value,
}

impl Reply {
    pub fn cookie(&self, name: &str) -> Result<String> {
        self.cookies()
            .into_iter()
            .find(|c| c.starts_with(&format!("{name}=")))
            .and_then(|v| v.split(';').next().map(str::to_string))
            .with_context(|| format!("Missing {name} cookie"))
    }
    pub fn cookies(&self) -> Vec<&str> {
        self.headers
            .get_all("set-cookie")
            .iter()
            .map(|v| v.to_str().unwrap())
            .collect()
    }
    pub fn location(&self) -> &str {
        self.headers["location"].to_str().unwrap()
    }
}

pub fn override_header(name: &str, value: &str) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
        value.parse().unwrap(),
    );
    headers
}

pub async fn response(builder: RequestBuilder) -> Result<Reply> {
    let r = builder.send().await?;
    let headers = r.headers().clone();
    let status = r.status().as_u16();
    let bytes = r.bytes().await?;
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)?
    };
    Ok(Reply {
        headers,
        status,
        body,
    })
}

pub async fn expect(builder: RequestBuilder, code: u16) -> Result<Reply> {
    let r = response(builder).await?;
    ensure!(
        r.status == code,
        "Expected HTTP {code}, got {} ({})",
        r.status,
        r.body["error"]["code"]
    );
    Ok(r)
}

#[derive(Clone, Copy, PartialEq)]
pub enum Profile {
    Shared,
    Personal,
    AccountOnly,
    Global,
    LocalGuest,
    Retire,
    RetireOnStart,
}

#[derive(Clone)]
pub struct Browser {
    pub origin: String,
    pub public_origin: String,
    http: Client,
    strip: bool,
}
impl Browser {
    pub fn request(&self, method: Method, path: &str, cookie: &str) -> RequestBuilder {
        let path = if cookie.is_empty() {
            path.into()
        } else {
            path.replace("/api/v1/workspaces", "/api/portal/v1/workspaces")
        };
        let path = if self.strip {
            path.strip_prefix("/studio/")
                .map(|s| format!("/{s}"))
                .unwrap_or(path)
        } else {
            path
        };
        let host = self.public_origin.split_once("://").unwrap().1;
        let r = self
            .http
            .request(method, format!("{}{path}", self.origin))
            .header("Host", host)
            .header("Origin", &self.public_origin);
        if cookie.is_empty() {
            r
        } else {
            r.header("Cookie", cookie)
        }
    }
    pub async fn get(&self, path: &str, cookie: &str, code: u16) -> Result<Reply> {
        expect(self.request(Method::GET, path, cookie), code).await
    }
    pub async fn post(&self, path: &str, cookie: &str, data: Value, code: u16) -> Result<Reply> {
        expect(self.request(Method::POST, path, cookie).json(&data), code).await
    }
    pub async fn flow(&self, operator: bool) -> Result<Flow> {
        let login = self
            .get(
                &format!("{AUTH}/login{}", if operator { "?operator=1" } else { "" }),
                "",
                302,
            )
            .await?;
        let url = reqwest::Url::parse(login.location())?;
        let state = url
            .query_pairs()
            .find(|(k, _)| k == "state")
            .context("Missing state")?
            .1
            .to_string();
        ensure!(
            url.query_pairs()
                .any(|(k, v)| k == "code_challenge_method" && v == "S256"),
            "Expected S256"
        );
        let auth: Value = self
            .http
            .get(url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let code = auth["code"]
            .as_str()
            .context("Missing authorization code")?
            .into();
        let cookie = login
            .cookies()
            .into_iter()
            .filter_map(|s| s.split(';').next())
            .collect::<Vec<_>>()
            .join("; ");
        Ok(Flow {
            state,
            code,
            cookie,
            login,
        })
    }
    pub async fn callback(&self, flow: &Flow, status: u16) -> Result<Reply> {
        self.get(
            &format!("{AUTH}/callback?code={}&state={}", flow.code, flow.state),
            &flow.cookie,
            status,
        )
        .await
    }
    pub async fn login(&self, operator: bool, status: u16) -> Result<Reply> {
        self.callback(&self.flow(operator).await?, status).await
    }
}

pub struct Flow {
    pub state: String,
    pub code: String,
    pub cookie: String,
    pub login: Reply,
}

pub struct Site {
    pub process: Option<Process>,
    pub oidc: Provider,
    pub region: Meta,
    pub global: Option<Meta>,
    pub fixture: Fixture,
    pub browser: Browser,
    pub config: Value,
    pub global_config: Option<Value>,
    pub hosted_plan: PathBuf,
    pub profile: Profile,
    pub log: PathBuf,
}

fn global_profile(dir: &Path, api: &mut Value) -> Result<Value> {
    let (server, tls) = certificates(dir)?;
    let (global_key, global_pub) = signer(dir, "global")?;
    let (region_key, region_pub) = signer(dir, "regional")?;
    let bind = format!("127.0.0.1:{}", port()?);
    let control_origin = format!("https://{bind}");
    let origin = api["publicOrigins"][0].clone();
    let authority = api["authorityId"].clone();
    let global_path = "/studio/api/global";
    api["globalEntry"] = json!({"apiOrigin":origin,"apiPathPrefix":global_path});
    let mut control = server.clone();
    control["bind"] = json!(bind);
    control["globalClientCertificates"] = json!([tls["certificateFile"]]);
    let mut region_connection = server;
    region_connection["bind"] = json!(bind);
    region_connection["allowedRegions"] =
        json!([{"regionId":authority,"certificateFile":tls["certificateFile"]}]);
    api["security"] = json!({"publicOrigin":origin,"environment":"test","globalIssuer":format!("{}{global_path}",origin.as_str().unwrap()),
        "globalSignerId":"global-primary","globalPublicKeyFile":global_pub,"regionalSignerId":"region-primary","regionalSigningKeyFile":region_key,
        "regionalPublicKeyFile":region_pub,"metadataSecurityState":true,"initializeClock":true,"accessTokenTtl":900,"control":control,
        "regionConnection":{"origin":control_origin,"tls":tls}});
    Ok(
        json!({"bind":api["bind"],"metadata":{"transport":"inProcess","authorityId":"global"},"publicOrigin":origin,"publicPath":global_path,"sharedListener":true,
        "consoleOrigins":api["consoleOrigins"],"environment":"test","signerId":"global-primary","signingKeyFile":global_key,"verificationKeyFile":global_pub,"metadataSecurityState":true,"initializeClock":true,
        "regions":[{"regionId":authority,"apiOrigin":origin,"apiPathPrefix":"/studio"}],"regionConnection":region_connection,
        "regionControls":[{"regionId":authority,"origin":control_origin,"tls":tls}]}),
    )
}

pub fn workspace_scope(id: &str, family: &str) -> Value {
    json!({"authorityId":"region:native-sso","ownerKind":"workspace","ownerId":id,"family":family,"partitionId":"primary"})
}

impl Site {
    pub async fn prepare(profile: Profile, strip: bool, product: Value) -> Result<Self> {
        let fixture = Fixture::start().await?;
        let dir = fixture.directory();
        let mut region = fixture.meta("native-sso").await?;
        let mut services = vec![];
        let mut global = None;
        if profile != Profile::Shared {
            let mut g = fixture.meta("global").await?;
            if matches!(profile, Profile::Retire | Profile::RetireOnStart) {
                let mut changes = vec![
                    json!({"key":"state/workspace","expectedVersion":null,"value":{"id":"ws_agentlab","name":"Legacy"}}),
                    json!({"key":"credentials/accounts/example","expectedVersion":null,"value":{"token":"synthetic-secret"}}),
                ];
                for index in 0..150 {
                    changes.push(json!({"key":format!("state/files/{index:03}"),"value":{"name":"synthetic"},"expectedVersion":null}));
                }
                region.call(json!({"op":"commit","scope":workspace_scope("ws_agentlab","workspace"),"mutationId":Uuid::new_v4().to_string(),"changes":changes})).await?;
                region.call(json!({"op":"commit","scope":workspace_scope("unrelated-workspace","workspace"),"mutationId":Uuid::new_v4().to_string(),
                    "changes":[{"key":"state/workspace","expectedVersion":null,"value":{"id":"unrelated-workspace"}}]})).await?;
            }
            region.process.stop()?;
            g.process.stop()?;
            for (name, meta) in [("global", &g), ("region", &region)] {
                let path = dir.join(format!("{name}-managed.json"));
                private_json(&path, &meta.server)?;
                services.push(json!({"kind":"metadata","configFile":path}));
            }
            global = Some(g);
        }
        let bind = format!("127.0.0.1:{}", port()?);
        let origin = format!("http://{bind}");
        let public_origin = if profile == Profile::LocalGuest {
            origin.clone()
        } else {
            "https://studio.example.test".into()
        };
        let redirect_uri = format!("{public_origin}/studio/api/auth/tidbcloud/callback");
        let oidc = Provider::start("native-client", &redirect_uri).await?;
        let mut config = json!({"bind":bind,"workspaceId":"ws_agentlab","authorityId":region.server["authorityId"],"initializeWorkspace":true,
            "insecureLoopback":true,"consoleOrigins":[],"publicOrigins":[public_origin], "publicPath":"/studio","product":product,
            "metadata":{"transport":"remote","client":region.client},
            "sso":{"issuer":oidc.issuer,"clientId":"native-client","redirectUri":redirect_uri,"ownerSubjects":["alice"],"ownerEmailRules":["*@example.org"],"allowedOrgs":["org-a"],"allowLoopbackHttp":true}});
        if profile != Profile::Shared {
            config["metadata"] =
                json!({"transport":"inProcess","authorityId":region.server["authorityId"]});
        }
        let global_config = if matches!(profile, Profile::Global | Profile::LocalGuest) {
            if profile == Profile::LocalGuest {
                config["consoleOrigins"] = json!([public_origin]);
                config["sso"] = json!({"issuer":oidc.issuer,"clientId":"native-client","redirectUri":redirect_uri,"allowLoopbackHttp":true});
            } else {
                config["publicOrigins"] = json!([public_origin, "https://gateway.example.test"]);
            }
            let global = global_profile(dir, &mut config)?;
            services.push(json!({"kind":"global","configFile":dir.join("global-api.json")}));
            Some(global)
        } else {
            None
        };
        let file = dir.join("api.json");
        services.push(json!({"kind":"workspace","configFile":file}));
        let hosted_plan = dir.join("plan.json");
        private_json(&hosted_plan, &json!({"format":1,"services":services}))?;
        let log = dir.join("boot.log");
        Ok(Self {
            process: None,
            oidc,
            region,
            global,
            fixture,
            browser: Browser {
                http: http_client()?,
                origin,
                public_origin,
                strip,
            },
            config,
            global_config,
            hosted_plan,
            profile,
            log,
        })
    }

    pub async fn new(profile: Profile, strip: bool, product: Value) -> Result<Self> {
        let mut s = Self::prepare(profile, strip, product).await?;
        s.start().await?;
        Ok(s)
    }
    pub fn save(&self) -> Result<()> {
        private_json(&self.fixture.directory().join("api.json"), &self.config)?;
        if let Some(global) = &self.global_config {
            private_json(&self.fixture.directory().join("global-api.json"), global)?;
        }
        Ok(())
    }
    pub fn steady(&mut self) {
        self.config["initializeWorkspace"] = json!(false);
        if self.config["security"].is_object() {
            self.config["security"]["initializeClock"] = json!(false);
        }
        if let Some(glob) = &mut self.global_config {
            glob["initializeClock"] = json!(false);
        }
    }
    pub fn stop(&mut self) -> Result<()> {
        if let Some(mut p) = self.process.take() {
            p.stop()?;
        }
        Ok(())
    }
    pub async fn start(&mut self) -> Result<()> {
        self.save()?;
        let mut command = Command::new(binary("workspace-backend"));
        command.args(["serve", "--config"]).arg(&self.hosted_plan);
        if self.profile != Profile::Shared {
            command.env(
                "WORKSPACE_GUEST_ENABLED",
                if self.profile == Profile::AccountOnly {
                    "false"
                } else {
                    "true"
                },
            );
        }
        if self.profile == Profile::RetireOnStart {
            command.env("WORKSPACE_RETIRE_LEGACY", "ws_agentlab");
        }
        self.log = self
            .fixture
            .directory()
            .join(format!("host-{}.log", Uuid::new_v4()));
        let mut process = Process::spawn(&mut command, &self.log)?;
        let deadline = Instant::now() + Duration::from_secs(25);
        while self.browser.get("/api/health", "", 200).await.is_err() {
            process.ensure_running().with_context(|| {
                format!(
                    "API did not start: {}",
                    fs::read_to_string(&self.log).unwrap_or_default()
                )
            })?;
            ensure!(Instant::now() < deadline, "API startup timed out");
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
        self.process = Some(process);
        Ok(())
    }
    pub async fn policy(&self, workspace: &str) -> Result<Value> {
        let result=self.region.call(json!({"op":"get","scope":workspace_scope(workspace,"regional-policy"),"keys":["owner-policy"]})).await?;
        Ok(result["records"]["owner-policy"]["value"].clone())
    }
}
