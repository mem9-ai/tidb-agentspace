mod database;
mod exports;
mod files;
mod imports;
mod preparations;
mod read_only;
mod resource_cursor;
mod resource_locks;
mod resource_pages;
mod resources;
mod sales_samples;
mod setup_attempts;
mod tutorials;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
use tokio::sync::Mutex;
use workspace_contracts::{Result, ServiceError};
pub use workspace_domain::visible_resource;
use workspace_domain::{Credential, Principal, Workspace, principal, secret};
use workspace_execute::Executor;
use workspace_providers::{DB9, DRIVE9, Providers, err, timestamp};
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub providers: workspace_providers::Config,
    #[serde(default)]
    pub execute: workspace_execute::Config,
}

impl Config {
    pub fn validate(&self) -> Result<()> {
        self.providers.validate()
    }
}
pub struct Product {
    pub workspace: Arc<Workspace>,
    pub providers: Providers,
    pub execute: Executor,
    lifecycle: Vec<tokio::sync::RwLock<()>>,
    file_mutations: Vec<Mutex<()>>,
    setup_admission: Vec<Mutex<()>>,
    cursor_cipher: tokio::sync::OnceCell<aes_gcm::Aes256Gcm>,
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
    pub if_match: Option<&'a str>,
    pub if_none_match: Option<&'a str>,
    pub binary_upload: bool,
    pub table_name: Option<String>,
}
pub enum Reply {
    Json(Value),
    Empty,
    Entity {
        value: Value,
        etag: String,
    },
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
        let execute = Executor::default();
        Ok(Self {
            workspace,
            providers,
            execute,
            lifecycle: (0..resource_locks::STRIPES)
                .map(|_| tokio::sync::RwLock::new(()))
                .collect(),
            file_mutations: (0..resource_locks::STRIPES)
                .map(|_| Mutex::new(()))
                .collect(),
            setup_admission: (0..resource_locks::STRIPES)
                .map(|_| Mutex::new(()))
                .collect(),
            cursor_cipher: tokio::sync::OnceCell::new(),
            preparations: Mutex::new(BTreeMap::new()),
        })
    }
    /// Authenticate, check the action and resolve the selected resource before provider I/O.
    /// Operations with separate source and destination resources must authorize both.
    pub async fn context(
        &self,
        credential: &Credential,
        scope: &str,
        id: Option<(&str, Option<&str>)>,
    ) -> Result<(Principal, Value)> {
        let p = self.workspace.authenticate(credential).await?;
        let value = self.authorized_resource(&p, scope, id).await?;
        Ok((p, value))
    }

    async fn authorized_resource(
        &self,
        p: &Principal,
        scope: &str,
        selection: Option<(&str, Option<&str>)>,
    ) -> Result<Value> {
        p.scope(scope)?;
        let (id, kind) = selection.ok_or_else(|| err(500, "RESOURCE_CONTEXT_REQUIRED"))?;
        let resource = self.workspace.repository().resource(id).await?;
        let r = p.resource(&json!({"resources":[resource]}), id, kind)?;
        if r["status"] == "deleting" || r["status"] == "deleted" {
            return Err(err(409, "RESOURCE_DELETING"));
        }
        Ok(r)
    }
    pub fn capabilities(&self) -> Value {
        let c = &self.providers.config;
        let live_files = c.files_provider == DRIVE9;
        json!({
            "postgresql": {
                "label": "PostgreSQL Compatible",
                "regions": ["automatic"],
                "storageGiB": null,
                "monthlyRU": null,
                "preview": true,
                "available": c.postgres_provider == DB9,
                "provider": DB9
            },
            "filesystem": {
                "label": "TiDB Cloud File System",
                "regions": if live_files { vec!["aws-ap-southeast-1"] } else { vec!["aws-ap-southeast-1", "aws-us-west-2"] },
                "storageGiB": (!live_files).then_some(2),
                "maxFiles": (!live_files).then_some(2000),
                "preview": true,
                "provider": c.files_provider
            }
        })
    }
    pub async fn mode(&self) -> Result<&'static str> {
        let config = &self.providers.config;
        Ok(
            if config.files_provider == DRIVE9 || config.postgres_provider == DB9 {
                "hybrid"
            } else {
                "demo"
            },
        )
    }
    pub async fn update_resource(&self, resource: Value, provision: bool) -> Result<Value> {
        if !resource["deletion"].is_null() || !live(&resource) {
            return Ok(resource);
        }
        let id = text(&resource, "id")?.to_owned();
        let info = if provision {
            if resource["provider"] == DRIVE9 {
                self.providers.provision_files(&id).await
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
        let saved = self
            .workspace
            .repository()
            .update_resource(&id, |current| {
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
                Ok(current.clone())
            })
            .await?;
        Ok(saved)
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
            .append_event(json!({"id":uuid::Uuid::new_v4().to_string(),"action":action,"resource":resource,"resourceId":resource_id,"actor":actor,"at":timestamp(),"outcome":"success"}))
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
            if_match,
            if_none_match,
            binary_upload,
            table_name,
        } = request;
        let (deleting, stripes) = resource_locks::plan(method, route, query, &input);
        let mut _exclusive = Vec::new();
        let mut _admitted = Vec::new();
        for index in stripes {
            if deleting {
                _exclusive.push(self.lifecycle[index].write().await);
            } else {
                _admitted.push(self.lifecycle[index].read().await);
            }
        }
        if matches!(
            (method, route),
            ("GET", "/files" | "/files/metadata" | "/files/content")
                | ("PUT", "/files" | "/files/content")
                | ("DELETE", "/files/entry")
        ) {
            return self
                .files(
                    &credential,
                    files::FileRequest {
                        method,
                        route,
                        query,
                        input,
                        raw,
                        if_match,
                        if_none_match,
                    },
                )
                .await;
        }
        let p = self.workspace.authenticate(&credential).await?;
        let actor_value = if p.owner {
            actor.to_owned()
        } else {
            format!("key:{}", p.id)
        };
        let actor = actor_value.as_str();
        if route == "/tutorials" || route.starts_with("/tutorials/") {
            return self
                .tutorial_request(
                    &credential,
                    &p,
                    tutorials::TutorialRequest {
                        method,
                        route,
                        query,
                        input,
                        if_match,
                        if_none_match,
                    },
                )
                .await;
        }
        if route == "/sales-sample-attempts" || route.starts_with("/sales-sample-attempts/") {
            return self
                .sales_sample_request(
                    &credential,
                    &p,
                    sales_samples::SampleRequest {
                        method,
                        route,
                        query,
                        input,
                        idempotency: idem,
                    },
                )
                .await;
        }
        let reply = match (method, route) {
            ("GET", "/context") => Reply::Json(self.agent_context(&p).await?),
            ("GET", "/bootstrap") => {
                if !p.owner {
                    return Err(err(403, "OWNER_REQUIRED"));
                }
                let repository = self.workspace.repository();
                let (page, next) = repository.resources_page(None, 100).await?;
                let keys: Vec<Value> = Vec::new();
                let key_next: Option<String> = None;
                let ids = page
                    .iter()
                    .map(|resource| text(resource, "id").map(str::to_owned))
                    .collect::<Result<BTreeSet<_>>>()?;
                let mut state = visible(
                    repository
                        .resource_transaction(
                            ids.iter().cloned().collect(),
                            true,
                            false,
                            false,
                            &credential,
                            |state| Ok((state.clone(), false)),
                        )
                        .await?,
                );
                state["resources"]
                    .as_array_mut()
                    .ok_or_else(|| err(503, "META_RECORD_CORRUPT"))?
                    .retain(|resource| resource["id"].as_str().is_some_and(|id| ids.contains(id)));
                state["keys"] = json!(keys);
                state["keysNextCursor"] = key_next.into();
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
                let usage = indexed_usage(&repository, &state).await?;
                if !self.workspace.authenticate(&credential).await?.owner {
                    return Err(err(403, "OWNER_REQUIRED"));
                }
                state["capabilities"] = self.capabilities();
                state["usage"] = usage;
                state["resourceNextCursor"] = next
                    .map(|key| {
                        key.strip_prefix("state/resources/")
                            .map(|id| URL_SAFE_NO_PAD.encode(id))
                            .ok_or_else(|| err(503, "META_RECORD_CORRUPT"))
                    })
                    .transpose()?
                    .into();
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
                p.scope("resources:read")?;
                let (data, next) = self.resource_page(&p, query).await?;
                Reply::Json(
                    json!({"data":data,"capabilities":self.capabilities(),"nextCursor":next}),
                )
            }
            ("POST", "/resources") => {
                p.scope("resources:write")?;
                if !p.resource_ids.iter().any(|v| v == "*") {
                    return Err(err(403, "WORKSPACE_GRANT_REQUIRED"));
                }
                let kind = text(&input, "kind").map_err(|_| err(400, "INVALID_KIND"))?;
                if !matches!(kind, "postgresql" | "filesystem") {
                    return Err(err(400, "INVALID_KIND"));
                }
                let name = text(&input, "name").map_err(|_| err(400, "INVALID_NAME"))?;
                let region = text(&input, "region").map_err(|_| err(400, "UNSUPPORTED_REGION"))?;
                let initial = match input.get("onlyIfNew") {
                    None | Some(Value::Bool(false)) => false,
                    Some(Value::Bool(true)) if !p.owner => return Err(err(403, "OWNER_REQUIRED")),
                    Some(Value::Bool(true)) if kind == "filesystem" && idem.is_some() => true,
                    _ => return Err(err(400, "INVALID_INPUT")),
                };
                let authority = self.workspace.repository().authority_id().to_owned();
                if input
                    .get("regionId")
                    .is_some_and(|value| value.as_str() != Some(authority.as_str()))
                {
                    return Err(err(400, "UNSUPPORTED_WORKSPACE_REGION"));
                }
                let caps = self.capabilities();
                if caps[kind].is_null()
                    || (kind == "postgresql" && self.providers.config.postgres_provider != DB9)
                {
                    return Err(err(400, "INVALID_KIND"));
                }
                let name_pattern = if kind == "postgresql" {
                    r"^[a-z][a-z0-9_-]{2,39}$"
                } else {
                    r"^[a-z][a-z0-9-]{2,39}$"
                };
                if !regex::Regex::new(name_pattern)
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
                if idem.is_some_and(|v| v.encode_utf16().count() > 128) {
                    return Err(err(400, "INVALID_IDEMPOTENCY_KEY"));
                }
                let slot = idem.map(|v| format!("{}:{v}", p.id));
                let fingerprint = fingerprint(raw)?;
                let provider = match kind {
                    "filesystem" => self.providers.config.files_provider.as_str(),
                    "postgresql" => DB9,
                    _ => return Err(err(400, "INVALID_KIND")),
                };
                let mut resource = json!({"id":format!("{}_{}",if kind=="filesystem"{"fs"}else{"db"},secret(6)?),"name":name,"kind":kind,"region":region,"regionId":authority,"status":if provider=="local"{"active"}else{"provisioning"},"provider":provider,"createdAt":timestamp()});
                if initial {
                    resource["isDefault"] = json!(true);
                }
                let event = json!({"id":uuid::Uuid::new_v4().to_string(),"action":"resource.created","resource":name,"resourceId":resource["id"],"actor":p.actor,"at":timestamp(),"outcome":"success"});
                let repository = self.workspace.repository();
                let resource = if initial {
                    // Index preparation has no provider effects; wait before reserving an
                    // automatic first resource so a fresh Workspace need not be retried.
                    repository.prepare_sample_resource_index().await?;
                    repository
                        .create_initial_resource(
                            &credential,
                            slot.as_deref()
                                .expect("initial request requires idempotency"),
                            &fingerprint,
                            resource,
                            event,
                        )
                        .await?
                } else {
                    repository
                        .create_indexed_resource(
                            &credential,
                            slot.as_deref(),
                            &fingerprint,
                            resource,
                            event,
                        )
                        .await?
                };
                let is_live = live(&resource);
                let authorized = self.workspace.authenticate(&credential).await?;
                authorized.scope("resources:write")?;
                if !authorized.has("*") {
                    return Err(err(403, "WORKSPACE_GRANT_REQUIRED"));
                }
                if !visible_resource(&resource) {
                    return Err(err(404, "NOT_FOUND"));
                }
                let data = self.update_resource(resource, true).await?;
                let reply = json!({"data":data,"mode":if is_live{"live"}else{"demo"}});
                return Ok((201, Reply::Json(reply)));
            }
            ("GET", "/usage") => {
                p.scope("usage:read")?;
                let (resources, next) = self.resource_page(&p, query).await?;
                let ids = resources
                    .iter()
                    .map(|resource| text(resource, "id").map(str::to_owned))
                    .collect::<Result<Vec<_>>>()?;
                let state = self
                    .workspace
                    .repository()
                    .resource_transaction(ids, false, false, true, &credential, |state| {
                        Ok((state.clone(), false))
                    })
                    .await?;
                let mut data = indexed_usage(&self.workspace.repository(), &state)
                    .await?
                    .as_array()
                    .expect("usage")
                    .clone();
                self.workspace
                    .authenticate(&credential)
                    .await?
                    .scope("usage:read")?;
                data.sort_by(|a, b| a["resourceId"].as_str().cmp(&b["resourceId"].as_str()));
                let count = if p.has("*") {
                    state["queryCount"].as_u64().unwrap_or(0)
                } else {
                    state["resourceQueryCounts"]
                        .as_object()
                        .map(|counts| {
                            resources
                                .iter()
                                .filter_map(|r| counts.get(r["id"].as_str()?)?.as_u64())
                                .sum()
                        })
                        .unwrap_or(0)
                };
                Reply::Json(
                    json!({"data":data,"mode":"demo","queryCount":count,"queryCountScope":if p.has("*"){"workspace"}else{"page"},"nextCursor":next}),
                )
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
            ("POST", "/database-imports") => Reply::Json(
                self.database_import(
                    &credential,
                    actor,
                    imports::DatabaseImportRequest {
                        route,
                        query,
                        input,
                        raw,
                        upload: false,
                    },
                )
                .await?,
            ),
            ("POST", "/database-import-preparations") => {
                return Ok((
                    201,
                    Reply::Json(
                        self.database_import(
                            &credential,
                            actor,
                            imports::DatabaseImportRequest {
                                route,
                                query,
                                input,
                                raw,
                                upload: binary_upload,
                            },
                        )
                        .await?,
                    ),
                ));
            }
            ("POST", "/file-export-preparations") => {
                return Ok((
                    201,
                    Reply::Json(self.export(&credential, actor, route, input).await?),
                ));
            }
            ("POST", "/result-exports") | ("POST", "/file-exports") => {
                Reply::Json(self.export(&credential, actor, route, input).await?)
            }
            _ => {
                let parts = route
                    .split('/')
                    .filter(|v| !v.is_empty())
                    .collect::<Vec<_>>();
                if parts.len() == 2
                    && parts[0] == "resources"
                    && ["GET", "DELETE"].contains(&method)
                {
                    return self.resource_request(&credential, method, parts[1]).await;
                }
                if parts.len() == 2
                    && ["database-import-preparations", "file-export-preparations"]
                        .contains(&parts[0])
                    && ["GET", "DELETE"].contains(&method)
                {
                    return self
                        .preparation_request(&credential, actor, method, parts[0], parts[1])
                        .await;
                }
                if parts.len() >= 3 && parts[0] == "resources" && parts[2] == "setup-attempts" {
                    return self
                        .setup_attempt_request(&credential, method, &parts, query, idem, &input)
                        .await;
                } else if method == "GET" && parts.len() >= 3 && parts[0] == "resources" {
                    let action = match parts.as_slice() {
                        [_, _, "tables"] => "tables",
                        [_, _, "tables", _] => "table",
                        [_, _, "tables", _, "rows"] => "table/rows",
                        _ => return Err(err(404, "NOT_FOUND")),
                    };
                    let (_, r) = self
                        .context(&credential, "queries:read", Some((parts[1], None)))
                        .await?;
                    Reply::Json(
                        self.browse(&credential, &r, action, table_name.as_deref())
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
    [DRIVE9, DB9].contains(&r["provider"].as_str().unwrap_or(""))
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
        .retain(|r| visible_resource(r) && r["status"] != "deleted");
    state["events"]
        .as_array_mut()
        .expect("events")
        .retain(|e| !retired.contains(&e["resourceId"]));
    state
}
pub fn file_view(mut f: Value) -> Value {
    f["version"] = json!(files::local_version(&f));
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
let files=state["files"].as_array().expect("files").iter().filter(|f|f["resourceId"]==r["id"]).collect::<Vec<_>>();json!({"resourceId":r["id"],"name":r["name"],"kind":r["kind"],"storageBytes":if native{Value::Null}else{json!(files.iter().map(|f|f["content"].as_str().unwrap_or("").len()).sum::<usize>())},"storageLimitBytes":if native{Value::Null}else{json!((if r["kind"]=="filesystem"{2u64}else{5})*1024*1024*1024)},"measured":!native,"fileCount":if native{Value::Null}else{json!(files.iter().filter(|f|f["type"]=="file").count())},"monthlyRU":if native{Value::Null}else{json!(0)},"monthlyRULimit":Value::Null})}).collect::<Vec<_>>())
}
async fn indexed_usage(repository: &workspace_domain::Repository, state: &Value) -> Result<Value> {
    let mut output = usage(state);
    let resources = state["resources"]
        .as_array()
        .ok_or_else(|| err(503, "META_RECORD_CORRUPT"))?;
    let local = resources
        .iter()
        .filter(|r| r["kind"] == "filesystem" && !live(r))
        .collect::<Vec<_>>();
    if !local.is_empty() {
        repository.ensure_file_indexes().await?;
    }
    for resource in local {
        let id = text(resource, "id")?;
        let summary = repository.local_file_summary(id).await?;
        let row = output
            .as_array_mut()
            .and_then(|rows| rows.iter_mut().find(|row| row["resourceId"] == id))
            .ok_or_else(|| err(503, "META_RECORD_CORRUPT"))?;
        row["storageBytes"] = summary["bytes"].clone();
        row["fileCount"] = summary["files"].clone();
    }
    Ok(output)
}
fn message(code: &str) -> &str {
    match code {
        "PROVISION_OUTCOME_UNKNOWN" => {
            "Provisioning outcome is unknown. Operator recovery is required; no duplicate trial will be created."
        }
        "PROVIDER_BINDING_MISSING" => {
            "File System provisioning requires operator recovery. No replacement tenant will be created automatically."
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
#[cfg(test)]
mod execute_config_tests {
    use super::*;

    #[test]
    fn execute_configuration_uses_one_name_and_rejects_obsolete_fields() {
        let extension = json!({"extensionPath":"/private/tidbfs.duckdb_extension","extensionSha256":"retained-checksum"});
        let current: Config = serde_json::from_value(json!({"execute":extension})).unwrap();
        assert_eq!(
            serde_json::to_value(&current).unwrap()["execute"],
            extension
        );
        for value in [
            json!({"compute":extension}),
            json!({"compute":extension,"execute":extension}),
        ] {
            let error = serde_json::from_value::<Config>(value)
                .err()
                .expect("obsolete configuration accepted");
            assert!(error.to_string().contains("unknown field `compute`"));
        }
    }
}
