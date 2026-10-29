mod database;
mod exports;
mod files;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
use tokio::sync::Mutex;
use workspace_compute::Compute;
use workspace_contracts::{Result, ServiceError};
use workspace_domain::{Credential, Principal, Workspace, principal, secret};
use workspace_providers::{DB9, DRIVE9, DUCKDB, Providers, ZERO, err, timestamp};
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub providers: workspace_providers::Config,
    #[serde(default)]
    pub compute: workspace_compute::Config,
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        self.providers.validate()
    }
}
pub struct Product {
    pub workspace: Arc<Workspace>,
    pub providers: Providers,
    pub compute: Compute,
    preparations: Mutex<BTreeMap<String, exports::Preparation>>,
}
pub struct Request<'a> {
    pub credential: Credential,
    pub actor: &'a str,
    pub method: &'a str,
    pub route: &'a str,
    pub query: &'a BTreeMap<String, String>,
    pub input: Value,
    pub raw: &'a [u8],
    pub condition: Option<&'a str>,
}
pub enum Reply {
    Json(Value),
    Download {
        response: reqwest::Response,
        size: u64,
        filename: String,
    },
}
impl Product {
    pub async fn new(workspace: Arc<Workspace>, config: Config) -> Result<Self> {
        config.validate()?;
        let providers = Providers::new(config.providers, workspace.repository())?;
        let compute = Compute::new(config.compute).await;
        Ok(Self {
            workspace,
            providers,
            compute,
            preparations: Mutex::new(BTreeMap::new()),
        })
    }
    pub async fn context(
        &self,
        credential: &Credential,
        scope: &str,
        id: Option<(&str, Option<&str>)>,
    ) -> Result<(Principal, Value)> {
        let p = self.workspace.authenticate(credential).await?;
        p.scope(scope)?;
        let value = if let Some((id, kind)) = id {
            let resource = self.workspace.repository().resource(id).await?;
            p.resource(&json!({"resources":[resource]}), id, kind)?
        } else {
            self.workspace.repository().read().await?
        };
        Ok((p, value))
    }
    pub fn capabilities(&self) -> Value {
        let c = &self.providers.config;
        json!({"mysql":{"label":"TiDB Starter · MySQL","regions":if c.mysql_provider==ZERO{vec!["automatic"]}else{vec!["aws-us-east-1","aws-us-west-2"]},"storageGiB":if c.mysql_provider==ZERO{Value::Null}else{json!(5)},"monthlyRU":if c.mysql_provider==ZERO{Value::Null}else{json!(50_000_000)},"preview":false,"provider":c.mysql_provider},"postgresql":{"label":"PostgreSQL · db9","regions":["automatic"],"storageGiB":null,"monthlyRU":null,"preview":true,"available":c.postgres_provider==DB9,"provider":DB9},"duckdb":{"label":"DuckDB","regions":["aws-ap-southeast-1"],"storageGiB":null,"monthlyRU":null,"preview":true,"available":self.compute.available,"provider":DUCKDB},"filesystem":{"label":"TiDB Cloud File System","regions":if c.files_provider==DRIVE9{vec!["aws-ap-southeast-1"]}else{vec!["aws-ap-southeast-1","aws-us-west-2"]},"storageGiB":if c.files_provider==DRIVE9{Value::Null}else{json!(2)},"maxFiles":if c.files_provider==DRIVE9{Value::Null}else{json!(2000)},"preview":true,"provider":c.files_provider}})
    }
    pub async fn mode(&self) -> Result<&'static str> {
        let state = self.workspace.repository().read().await?;
        Ok(
            if self.providers.config.files_provider == DRIVE9
                || state["resources"]
                    .as_array()
                    .is_some_and(|v| v.iter().any(live))
            {
                "hybrid"
            } else {
                "demo"
            },
        )
    }
    pub async fn update_resource(&self, resource: Value, provision: bool) -> Result<Value> {
        if !live(&resource) {
            return Ok(resource);
        }
        let id = text(&resource, "id")?.to_owned();
        let info = if provision {
            if resource["provider"] == DRIVE9 {
                self.providers.provision_files(&id).await
            } else if resource["provider"] == DUCKDB {
                self.setup_duckdb(&resource).await
            } else {
                self.providers.provision_database(&resource).await
            }
        } else {
            self.providers.status(&resource).await
        };
        let info = match info {
            Ok(v) => v,
            Err(e) => {
                let mut value = self.providers.status(&resource).await.unwrap_or(json!({}));
                value["connectionError"] = json!(message(&e.code));
                value
            }
        };
        self.workspace
            .repository()
            .transaction(|state| {
                let current = state["resources"]
                    .as_array_mut()
                    .and_then(|v| v.iter_mut().find(|r| r["id"] == id))
                    .ok_or_else(|| err(404, "NOT_FOUND"))?;
                current
                    .as_object_mut()
                    .ok_or_else(|| err(503, "META_RECORD_CORRUPT"))?
                    .remove("connectionError");
                for (k, v) in info
                    .as_object()
                    .ok_or_else(|| err(502, "INVALID_PROVIDER_RESPONSE"))?
                {
                    current[k] = v.clone();
                }
                Ok((current.clone(), true))
            })
            .await
    }
    async fn setup_duckdb(&self, r: &Value) -> Result<Value> {
        self.compute.verify()?;
        let id = text(r, "id")?;
        let mut b = self.providers.binding("duckdb", id).await?;
        if b.is_null() {
            b = json!({"state":"requested","storageId":format!("duckdb_{}",secret(12)?)});
            self.providers.save_binding("duckdb", id, b.clone()).await?;
        }
        if b["state"] == "ready" {
            return self.providers.status(r).await;
        }
        let info = self
            .providers
            .provision_files(text(&b, "storageId")?)
            .await?;
        if info["status"] != "active" {
            return Ok(
                json!({"status":"provisioning","connectionError":"Database storage is not ready. Retry setup later."}),
            );
        }
        let connection = self
            .providers
            .file_connection(text(&b, "storageId")?)
            .await?;
        self.compute
            .database(id, connection, "SELECT 1 AS connected", json!([]), false)
            .await?;
        b["state"] = json!("ready");
        self.providers.save_binding("duckdb", id, b).await?;
        self.providers.status(r).await
    }
    pub async fn record(
        &self,
        action: &str,
        resource: &str,
        actor: &str,
        resource_id: Option<&str>,
    ) -> Result<()> {
        self.workspace
            .repository()
            .transaction(|state| {
                event(state, action, resource, actor, resource_id);
                Ok(((), true))
            })
            .await
    }
    pub async fn handle(&self, request: Request<'_>) -> Result<(u16, Reply)> {
        let Request {
            credential,
            actor,
            method,
            route,
            query,
            input,
            raw,
            condition: idem,
        } = request;
        let p = self.workspace.authenticate(&credential).await?;
        let actor_value = if p.owner {
            actor.to_owned()
        } else {
            format!("key:{}", p.id)
        };
        let actor = actor_value.as_str();
        let reply = match (method, route) {
            ("GET", "/bootstrap") => {
                if !p.owner {
                    return Err(err(403, "OWNER_REQUIRED"));
                }
                let state = visible(self.workspace.repository().read().await?);
                for r in state["resources"]
                    .as_array()
                    .ok_or_else(|| err(503, "META_RECORD_CORRUPT"))?
                {
                    self.update_resource(r.clone(), false).await?;
                }
                let mut state = visible(self.workspace.repository().read().await?);
                for file in state["files"]
                    .as_array_mut()
                    .ok_or_else(|| err(503, "META_RECORD_CORRUPT"))?
                {
                    *file = file_view(file.clone());
                }
                for key in state["keys"]
                    .as_array_mut()
                    .ok_or_else(|| err(503, "META_RECORD_CORRUPT"))?
                {
                    key.as_object_mut()
                        .ok_or_else(|| err(503, "META_RECORD_CORRUPT"))?
                        .remove("digest");
                    if key["resourceIds"].is_null() {
                        key["resourceIds"] = json!([]);
                    }
                }
                let usage = usage(&state);
                state["capabilities"] = self.capabilities();
                state["usage"] = usage;
                state["mode"] = json!(if state["resources"]
                    .as_array()
                    .is_some_and(|v| v.iter().any(live))
                {
                    "hybrid"
                } else {
                    "demo"
                });
                state.as_object_mut().expect("state").remove("idempotency");
                Reply::Json(state)
            }
            ("GET", "/resources") => {
                let (_, state) = self.context(&credential, "resources:read", None).await?;
                let mut data = vec![];
                for r in visible(state)["resources"]
                    .as_array()
                    .ok_or_else(|| err(503, "META_RECORD_CORRUPT"))?
                {
                    if p.has(text(r, "id")?) {
                        data.push(self.update_resource(r.clone(), false).await?);
                    }
                }
                Reply::Json(json!({"data":data,"capabilities":self.capabilities()}))
            }
            ("POST", "/resources") => {
                p.scope("resources:write")?;
                if !p.resource_ids.iter().any(|v| v == "*") {
                    return Err(err(403, "WORKSPACE_GRANT_REQUIRED"));
                }
                let kind = text(&input, "kind").map_err(|_| err(400, "INVALID_KIND"))?;
                let name = text(&input, "name").map_err(|_| err(400, "INVALID_NAME"))?;
                let region = text(&input, "region").map_err(|_| err(400, "UNSUPPORTED_REGION"))?;
                let caps = self.capabilities();
                if caps[kind].is_null()
                    || (kind == "postgresql" && self.providers.config.postgres_provider != DB9)
                {
                    return Err(err(400, "INVALID_KIND"));
                }
                if !regex::Regex::new(r"^[a-z][a-z0-9-]{2,39}$")
                    .expect("regex")
                    .is_match(name)
                {
                    return Err(err(400, "INVALID_NAME"));
                }
                if !caps[kind]["regions"]
                    .as_array()
                    .is_some_and(|v| v.contains(&json!(region)))
                {
                    return Err(err(400, "UNSUPPORTED_REGION"));
                }
                if kind == "duckdb" {
                    self.compute.verify()?;
                }
                if idem.is_some_and(|v| v.encode_utf16().count() > 128) {
                    return Err(err(400, "INVALID_IDEMPOTENCY_KEY"));
                }
                let slot = idem.map(|v| format!("{}:{v}", p.id));
                let fingerprint = fingerprint(raw)?;
                let provider = match kind {
                    "filesystem" => self.providers.config.files_provider.as_str(),
                    "mysql" => self.providers.config.mysql_provider.as_str(),
                    "postgresql" => DB9,
                    _ => DUCKDB,
                };
                let resource=self.workspace.repository().transaction(|state|{if let Some(slot)=&slot&& !state["idempotency"][slot].is_null(){let prior=&state["idempotency"][slot];
if prior["fingerprint"]!=fingerprint{return Err(err(409,"IDEMPOTENCY_CONFLICT"));}
return Ok((state["resources"].as_array().and_then(|v|v.iter().find(|r|r["id"]==prior["resource"]["id"])).unwrap_or(&prior["resource"]).clone(),false));}
let resources=state["resources"].as_array().ok_or_else(||err(503,"META_RECORD_CORRUPT"))?;
if resources.iter().any(|r|r["name"]==name){return Err(err(409,"NAME_EXISTS"));}
if(kind=="filesystem"&&resources.iter().any(|r|r["kind"]==kind&&r["region"]==region&&r["provider"].as_str().unwrap_or("local")==provider))||(kind!="filesystem"&&resources.iter().filter(|r|r["kind"]==kind&&(kind!="postgresql"||r["provider"]==DB9)).count()>=5){return Err(err(409,"FREE_TIER_LIMIT"));}
let r=json!({"id":format!("{}_{}",if kind=="filesystem"{"fs"}else{"db"},secret(6)?),"name":name,"kind":kind,"region":region,"status":if provider=="local"{"active"}else{"provisioning"},"provider":provider,"createdAt":timestamp()});state["resources"].as_array_mut().expect("resources").push(r.clone());event(state,"resource.created",name,&p.actor,r["id"].as_str());
if let Some(slot)=&slot{state["idempotency"][slot]=json!({"fingerprint":fingerprint,"resource":r});}
Ok((r,true))}).await?;
                let is_live = live(&resource);
                let data = self.update_resource(resource, true).await?;
                return Ok((
                    201,
                    Reply::Json(json!({"data":data,"mode":if is_live{"live"}else{"demo"}})),
                ));
            }
            ("GET", "/usage") => {
                let (_, state) = self.context(&credential, "usage:read", None).await?;
                let data = usage(&state)
                    .as_array()
                    .expect("usage")
                    .iter()
                    .filter(|r| p.has(r["resourceId"].as_str().unwrap_or("")))
                    .cloned()
                    .collect::<Vec<_>>();
                let count = if p.has("*") {
                    state["queryCount"].as_u64().unwrap_or(0)
                } else {
                    state["resourceQueryCounts"]
                        .as_object()
                        .map(|v| {
                            v.iter()
                                .filter(|(k, _)| p.has(k))
                                .map(|(_, v)| v.as_u64().unwrap_or(0))
                                .sum()
                        })
                        .unwrap_or(0)
                };
                Reply::Json(json!({"data":data,"mode":"demo","queryCount":count}))
            }
            ("GET", "/files")
            | ("PUT", "/files")
            | ("DELETE", "/files")
            | ("GET", "/files/content")
            | ("PUT", "/files/content") => {
                return self
                    .files(
                        &credential,
                        &p,
                        files::FileRequest {
                            method,
                            route,
                            query,
                            input,
                            raw,
                            condition: idem,
                        },
                    )
                    .await;
            }
            ("POST", "/queries") => Reply::Json(self.query(&credential, &p, &input).await?),
            ("GET", "/file-analyses/capabilities")
            | ("GET", "/files/tabular-preview")
            | ("POST", "/file-analyses") => Reply::Json(
                self.analysis(
                    &credential,
                    route,
                    if method == "GET" { json!(query) } else { input },
                )
                .await?,
            ),
            ("POST", "/result-exports")
            | ("POST", "/file-exports")
            | ("POST", "/file-exports/prepare") => {
                Reply::Json(self.export(&credential, actor, route, input).await?)
            }
            _ => {
                let parts = route
                    .split('/')
                    .filter(|v| !v.is_empty())
                    .collect::<Vec<_>>();
                if parts.len() == 3
                    && parts[0] == "resources"
                    && parts[2] == "setup"
                    && method == "POST"
                {
                    let (_, r) = self
                        .context(&credential, "resources:write", Some((parts[1], None)))
                        .await?;
                    if ![ZERO, DB9, DUCKDB].contains(&r["provider"].as_str().unwrap_or("")) {
                        return Err(err(400, "UNSUPPORTED_PROVIDER"));
                    }
                    Reply::Json(json!({"data":self.update_resource(r,true).await?}))
                } else if method == "GET" && parts.len() >= 3 && parts[0] == "resources" {
                    let action = parts[2..].join("/");
                    if !["tables", "table", "table/rows"].contains(&action.as_str()) {
                        return Err(err(404, "NOT_FOUND"));
                    }
                    let (_, r) = self
                        .context(&credential, "queries:execute", Some((parts[1], None)))
                        .await?;
                    Reply::Json(
                        self.browse(
                            &credential,
                            &r,
                            &action,
                            query.get("name").map(String::as_str),
                        )
                        .await?,
                    )
                } else {
                    return Err(err(404, "NOT_FOUND"));
                }
            }
        };
        Ok((200, reply))
    }
}
pub fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().ok_or_else(|| err(400, "INVALID_BODY"))
}
pub fn live(r: &Value) -> bool {
    [DRIVE9, ZERO, DB9, DUCKDB].contains(&r["provider"].as_str().unwrap_or(""))
}
pub fn visible_resource(r: &Value) -> bool {
    match r["kind"].as_str() {
        Some("mysql" | "filesystem" | "duckdb") => true,
        Some("postgresql") => r["provider"] == DB9,
        _ => false,
    }
}
pub fn visible(mut state: Value) -> Value {
    let retired = state["resources"]
        .as_array()
        .map(|v| {
            v.iter()
                .filter(|r| !visible_resource(r))
                .map(|r| r["id"].clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    state["resources"]
        .as_array_mut()
        .expect("resources")
        .retain(visible_resource);
    state["events"]
        .as_array_mut()
        .expect("events")
        .retain(|e| !retired.contains(&e["resourceId"]));
    state
}
pub fn file_view(mut f: Value) -> Value {
    f["size"] = json!(f["content"].as_str().unwrap_or("").len());
    f
}
pub fn event(
    state: &mut Value,
    action: &str,
    resource: &str,
    actor: &str,
    resource_id: Option<&str>,
) {
    let events = state["events"].as_array_mut().expect("events");
    events.insert(0,json!({"id":uuid::Uuid::new_v4().to_string(),"action":action,"resource":resource,"resourceId":resource_id,"actor":actor,"at":timestamp(),"outcome":"success"}));
    events.truncate(200);
}
pub fn clean_path(path: &str) -> Result<String> {
    if !path.starts_with('/')
        || path.contains(['\\', '\0'])
        || path.encode_utf16().count() > 512
        || path.split('/').any(|s| s == "." || s == "..")
    {
        return Err(err(400, "INVALID_PATH"));
    }
    let v = path
        .split('/')
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    Ok(format!("/{v}"))
}
fn usage(state: &Value) -> Value {
    json!(state["resources"].as_array().expect("resources").iter().filter(|r|visible_resource(r)).map(|r|{let native=live(r);
let files=state["files"].as_array().expect("files").iter().filter(|f|f["resourceId"]==r["id"]).collect::<Vec<_>>();json!({"resourceId":r["id"],"name":r["name"],"kind":r["kind"],"storageBytes":if native{Value::Null}else{json!(files.iter().map(|f|f["content"].as_str().unwrap_or("").len()).sum::<usize>())},"storageLimitBytes":if native{Value::Null}else{json!((if r["kind"]=="filesystem"{2u64}else{5})*1024*1024*1024)},"measured":!native,"fileCount":if native{Value::Null}else{json!(files.iter().filter(|f|f["type"]=="file").count())},"monthlyRU":if native{Value::Null}else{json!(0)},"monthlyRULimit":if [ZERO,DB9,DUCKDB].contains(&r["provider"].as_str().unwrap_or(""))||r["kind"]!="mysql"{Value::Null}else{json!(50_000_000)}})}).collect::<Vec<_>>())
}
fn message(code: &str) -> &str {
    match code {
        "PROVISION_OUTCOME_UNKNOWN" => {
            "Provisioning outcome is unknown. Operator recovery is required; no duplicate trial will be created."
        }
        "PROVIDER_BINDING_MISSING" => {
            "File System provisioning requires operator recovery. No replacement tenant will be created automatically."
        }
        "ZERO_CREATION_UNCONFIRMED" => {
            "Database creation could not be confirmed. No automatic retry will create another instance."
        }
        "DB9_CREATION_UNCONFIRMED" => {
            "Database creation could not be confirmed. Setup can recover the saved instance; no replacement is created automatically."
        }
        _ => "Setup needs recovery on the same resource. No replacement is created automatically.",
    }
}
// Preserve insertion order for resource creation fingerprints without changing metadata serialization.
fn fingerprint(bytes: &[u8]) -> Result<String> {
    use serde::de::{self, MapAccess, SeqAccess, Visitor};
    use std::fmt;
    struct Ordered(String);
    impl<'de> Deserialize<'de> for Ordered {
        fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
            struct V;
            impl<'de> Visitor<'de> for V {
                type Value = Ordered;
                fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                    f.write_str("JSON")
                }
                fn visit_map<M: MapAccess<'de>>(
                    self,
                    mut m: M,
                ) -> std::result::Result<Ordered, M::Error> {
                    let mut entries = vec![];
                    while let Some((k, v)) = m.next_entry::<String, Ordered>()? {
                        entries.push((k, v.0));
                    }
                    entries.sort_by(|a, b| {
                        let key = |s: &str| {
                            s.parse::<u32>()
                                .ok()
                                .filter(|n| *n < u32::MAX && n.to_string() == s)
                        };
                        match (key(&a.0), key(&b.0)) {
                            (Some(a), Some(b)) => a.cmp(&b),
                            (Some(_), None) => std::cmp::Ordering::Less,
                            (None, Some(_)) => std::cmp::Ordering::Greater,
                            _ => std::cmp::Ordering::Equal,
                        }
                    });
                    Ok(Ordered(format!(
                        "{{{}}}",
                        entries
                            .into_iter()
                            .map(|(k, v)| format!("{}:{v}", json!(k)))
                            .collect::<Vec<_>>()
                            .join(",")
                    )))
                }
                fn visit_seq<A: SeqAccess<'de>>(
                    self,
                    mut a: A,
                ) -> std::result::Result<Ordered, A::Error> {
                    let mut v = vec![];
                    while let Some(x) = a.next_element::<Ordered>()? {
                        v.push(x.0);
                    }
                    Ok(Ordered(format!("[{}]", v.join(","))))
                }
                fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Ordered, E> {
                    Ok(Ordered(json!(v).to_string()))
                }
                fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Ordered, E> {
                    Ok(Ordered(v.to_string()))
                }
                fn visit_unit<E: de::Error>(self) -> std::result::Result<Ordered, E> {
                    Ok(Ordered("null".into()))
                }
                fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Ordered, E> {
                    Ok(Ordered((v as f64).to_string()))
                }
                fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Ordered, E> {
                    Ok(Ordered((v as f64).to_string()))
                }
                fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Ordered, E> {
                    Ok(Ordered(v.to_string()))
                }
            }
            d.deserialize_any(V)
        }
    }
    use sha2::{Digest, Sha256};
    let v: Ordered = serde_json::from_slice(bytes).map_err(|_| err(400, "INVALID_JSON"))?;
    Ok(hex::encode(Sha256::digest(v.0.as_bytes())))
}
