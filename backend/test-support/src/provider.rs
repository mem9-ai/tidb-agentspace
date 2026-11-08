//! Loopback implementations of the provider HTTP boundaries used by native acceptance tests.
use anyhow::Result;
use axum::{
    Json,
    body::{Body, Bytes},
    http::{HeaderMap, Method, Request, StatusCode},
    response::{IntoResponse, Response},
};
use futures::{Future, future::BoxFuture};
use hyper::{body::Incoming, server::conn::http1, service::service_fn};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    io,
    sync::{Arc, Mutex},
};
use tokio::{
    net::TcpListener,
    task::{JoinHandle, JoinSet},
};

pub const NATIVE_SECRET: &str = "private-native-token-not-for-public-output";
pub enum SqlResponse {
    Json(u16, Value),
    Disconnect,
}
type Hook = Arc<dyn Fn(Value) -> BoxFuture<'static, Option<SqlResponse>> + Send + Sync>;
pub type WriteRace =
    Box<dyn FnOnce(&str, &mut BTreeMap<String, Vec<u8>>) -> Option<(u16, Value)> + Send>;
pub struct ProviderState {
    pub files: BTreeMap<String, Vec<u8>>,
    versions: HashMap<String, (usize, usize, String)>,
    next_file: usize,
    pub file_reads: usize,
    pub calls: usize,
    pub statements: Vec<String>,
    pub databases: Vec<Value>,
    pub file_tenants: HashMap<String, String>,
    pub deleted: Vec<(String, String)>,
    pub creates: usize,
    pub database_creates: usize,
    pub account_creates: usize,
    pub file_status: String,
    pub versions_available: bool,
    pub require_file_auth: bool,
    pub lost: bool,
    pub delete_lost: bool,
    pub write_race: Option<WriteRace>,
    write_gate: Option<(
        tokio::sync::oneshot::Sender<()>,
        tokio::sync::oneshot::Receiver<()>,
    )>,
    isolated_tenants: bool,
    sql_hook: Option<Hook>,
}
impl ProviderState {
    fn new(isolated_tenants: bool) -> Self {
        Self {
            files: BTreeMap::from([
                ("/live.csv".into(), b"name,n\nalice,1\nbob,2\n".to_vec()),
                ("/binary.bin".into(), vec![0, 255, 13, 10]),
            ]),
            versions: HashMap::new(),
            next_file: 0,
            file_reads: 0,
            calls: 0,
            statements: Vec::new(),
            databases: Vec::new(),
            file_tenants: HashMap::new(),
            deleted: Vec::new(),
            creates: 0,
            database_creates: 0,
            account_creates: 0,
            file_status: "active".into(),
            versions_available: true,
            require_file_auth: false,
            lost: false,
            delete_lost: false,
            write_race: None,
            write_gate: None,
            isolated_tenants,
            sql_hook: None,
        }
    }
    fn version(&mut self, path: &str) -> Option<(usize, usize, String)> {
        let hash = hex::encode(Sha256::digest(self.files.get(path)?));
        let version = self.versions.entry(path.to_owned()).or_insert_with(|| {
            self.next_file += 1;
            (1, self.next_file, hash.clone())
        });
        if version.2 != hash {
            version.0 += 1;
            version.2 = hash;
        }
        Some(version.clone())
    }
}
pub struct Provider {
    pub origin: String,
    pub state: Arc<Mutex<ProviderState>>,
    task: JoinHandle<()>,
}
impl Drop for Provider {
    fn drop(&mut self) {
        self.task.abort()
    }
}
impl Provider {
    pub async fn start(isolated_tenants: bool) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let origin = format!("http://{}", listener.local_addr()?);
        let state = Arc::new(Mutex::new(ProviderState::new(isolated_tenants)));
        let shared = state.clone();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    Ok((stream,_))=listener.accept()=>{
                        let state=shared.clone();
                        connections.spawn(async move{
                            let service=service_fn(move|req|handle(req,state.clone()));
                            let _=http1::Builder::new().serve_connection(TokioIo::new(stream),service).await;
                        });
                    },
                    _=connections.join_next(), if !connections.is_empty()=>{}
                }
            }
        });
        Ok(Self {
            origin,
            state,
            task,
        })
    }
    /// Hold the next upstream file write while concurrent requests reach the host.
    pub fn hold_next_file_write(
        &self,
    ) -> (
        tokio::sync::oneshot::Receiver<()>,
        tokio::sync::oneshot::Sender<()>,
    ) {
        let (started, entered) = tokio::sync::oneshot::channel();
        let (release, wait) = tokio::sync::oneshot::channel();
        self.state.lock().unwrap().write_gate = Some((started, wait));
        (entered, release)
    }
    pub fn set_sql_hook<F, Fut>(&self, hook: F)
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Option<SqlResponse>> + Send + 'static,
    {
        self.state.lock().unwrap().sql_hook = Some(Arc::new(move |v| Box::pin(hook(v))));
    }
}

type Reply = std::result::Result<Response, io::Error>;
fn reply(status: u16, data: Value) -> Reply {
    Ok((StatusCode::from_u16(status).unwrap(), Json(data)).into_response())
}
fn disconnect() -> Reply {
    Err(io::Error::new(
        io::ErrorKind::ConnectionAborted,
        "simulated lost provider response",
    ))
}
fn header<'a>(headers: &'a HeaderMap, key: &str) -> Option<&'a str> {
    headers.get(key)?.to_str().ok()
}

async fn handle(req: Request<Incoming>, state: Arc<Mutex<ProviderState>>) -> Reply {
    let (parts, body) = req.into_parts();
    let bytes = axum::body::to_bytes(Body::new(body), 3 * 1024 * 1024)
        .await
        .map_err(io::Error::other)?;
    let path = parts.uri.path();
    let body = || serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
    state.lock().unwrap().calls += 1;
    if path == "/sql" {
        let input = body();
        let statement = input["sql"].as_str().unwrap_or("").to_owned();
        let hook = {
            let mut state = state.lock().unwrap();
            state.statements.push(statement.clone());
            state.sql_hook.clone()
        };
        if let Some(hook) = hook
            && let Some(result) = hook(input).await
        {
            return match result {
                SqlResponse::Json(status, v) => reply(status, v),
                SqlResponse::Disconnect => disconnect(),
            };
        }
        return reply(200, sql(&statement));
    }
    if path.starts_with("/v1/fs") && parts.method == Method::PUT {
        let gate = state.lock().unwrap().write_gate.take();
        if let Some((started, release)) = gate {
            let _ = started.send(());
            let _ = release.await;
        }
    }
    let mut s = state.lock().unwrap();
    let token = header(&parts.headers, "authorization")
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("");
    if s.require_file_auth
        && (path == "/v1/status" || path.starts_with("/v1/fs"))
        && token != NATIVE_SECRET
    {
        return reply(403, json!({}));
    }
    match (path, parts.method.clone()) {
        ("/customer/anonymous-register", _) => {
            s.account_creates += 1;
            reply(
                200,
                json!({"anonymous_id":"account","anonymous_secret":NATIVE_SECRET,"token":"account-token","expires_at":"2099-01-01T00:00:00Z"}),
            )
        }
        ("/customer/databases", Method::POST) => {
            let v = body();
            let id = format!("pg{}", s.databases.len());
            let db = json!({"id":id,"name":v["name"],"connection_string":format!("postgresql://{id}.admin@pg.db9.io:5432/postgres"),"admin_password":v["admin_password"]});
            s.databases.push(db.clone());
            s.database_creates += 1;
            if s.lost { disconnect() } else { reply(200, db) }
        }
        ("/customer/databases", _) => reply(200, json!(s.databases)),
        (path, method) if path.starts_with("/customer/databases/") => {
            let id = path.trim_start_matches("/customer/databases/");
            if method == Method::DELETE {
                if token != "account-token" {
                    return reply(403, json!({}));
                }
                s.deleted.push(("db9".into(), id.into()));
                reply(200, json!({"message":"Database disabled"}))
            } else {
                reply(200, json!(s.databases.iter().find(|d| d["id"] == id)))
            }
        }
        ("/v1/status", _) => reply(
            200,
            json!({"status":s.file_status,"max_upload_bytes":1048576,"inline_threshold":1048576}),
        ),
        ("/v1/provision", _) => {
            s.creates += 1;
            if s.lost {
                return disconnect();
            }
            let (key, tenant) = if s.isolated_tenants {
                (
                    format!("file-token-{}", s.creates),
                    format!("created-tenant-{}", s.creates),
                )
            } else {
                (NATIVE_SECRET.into(), "created-tenant".into())
            };
            s.file_tenants.insert(key.clone(), tenant.clone());
            reply(200, json!({"api_key":key,"tenant_id":tenant}))
        }
        ("/v1/tenant", Method::DELETE) => {
            let Some(tenant) = s.file_tenants.get(token).cloned() else {
                return reply(403, json!({}));
            };
            s.deleted.push(("drive9".into(), tenant));
            if s.delete_lost {
                disconnect()
            } else {
                reply(202, json!({"status":"deleting"}))
            }
        }
        (path, method) if path.starts_with("/v1/fs") => {
            let suffix = path.trim_start_matches("/v1/fs");
            let path =
                percent_encoding::percent_decode_str(if suffix.is_empty() { "/" } else { suffix })
                    .decode_utf8_lossy();
            file_response(
                &mut s,
                &path,
                method,
                parts
                    .uri
                    .query()
                    .unwrap_or("")
                    .split('&')
                    .any(|p| p == "list=1"),
                &parts.headers,
                bytes,
            )
        }
        _ => reply(404, json!({})),
    }
}
fn file_response(
    s: &mut ProviderState,
    path: &str,
    method: Method,
    list: bool,
    headers: &HeaderMap,
    bytes: Bytes,
) -> Reply {
    if list {
        let entries: Vec<_> = s
            .files
            .iter()
            .filter_map(|(key, bytes)| {
                let (dir, name) = key.rsplit_once('/')?;
                ((if dir.is_empty() { "/" } else { dir }) == path).then(
                    || json!({"name":name,"size":bytes.len(),"isDir":false,"mtime":1770000000}),
                )
            })
            .collect();
        return reply(200, json!({"entries":entries}));
    }
    if method == Method::PUT {
        if let Some(race) = s.write_race.take()
            && let Some((code, value)) = race(path, &mut s.files)
        {
            return reply(code, value);
        }
        let current = s.version(path);
        if let Some(expected) = header(headers, "x-dat9-expected-revision")
            && expected != current.as_ref().map_or(0, |v| v.0).to_string()
        {
            return reply(409, json!({"error":"revision conflict"}));
        }
        s.files.insert(path.to_owned(), bytes.to_vec());
        if let Some((revision, id, _)) = current {
            s.versions.insert(
                path.to_owned(),
                (revision + 1, id, hex::encode(Sha256::digest(bytes))),
            );
        } else {
            s.version(path);
        }
        return reply(200, json!({}));
    }
    if method == Method::DELETE {
        if s.files.remove(path).is_none() {
            return reply(404, json!({}));
        }
        s.versions.remove(path);
        return reply(200, json!({}));
    }
    if method == Method::GET {
        s.file_reads += 1;
    }
    let Some((revision, id, hash)) = s.version(path) else {
        return reply(404, json!({}));
    };
    let etag = format!("\"{hash}\"");
    if header(headers, "if-match").is_some_and(|h| h != etag) {
        return reply(412, json!({}));
    }
    let bytes = &s.files[path];
    let mut res = Response::builder()
        .header("content-type", "application/octet-stream")
        .header("content-length", bytes.len())
        .header("x-dat9-isdir", "false")
        .header("etag", etag);
    if s.versions_available {
        res = res
            .header("x-dat9-revision", revision)
            .header("x-dat9-resource-id", format!("file-{id}"));
    }
    Ok(res
        .body(if method == Method::HEAD {
            Body::empty()
        } else {
            Body::from(bytes.clone())
        })
        .unwrap())
}
fn sql(query: &str) -> Value {
    let statement = query.trim().to_ascii_lowercase();
    let (columns, rows) = if statement.contains("from pg_roles") {
        (
            json!(["rolsuper", "rolcreatedb", "rolcreaterole"]),
            json!([{"rolsuper":false,"rolcreatedb":false,"rolcreaterole":false}]),
        )
    } else if statement.contains("as owned") {
        (json!(["owned"]), json!([{"owned":true}]))
    } else if statement.contains("information_schema.tables") {
        (
            json!(["name", "type"]),
            json!([{"name":"demo_table","type":"BASE TABLE"}]),
        )
    } else if statement.contains("information_schema.columns") {
        (
            json!([
                "name",
                "type",
                "nullable",
                "defaultValue",
                "columnKey",
                "extra",
                "position"
            ]),
            json!([{"name":"id","type":"integer","nullable":"NO","defaultValue":null,"columnKey":"PRI","extra":"","position":1}]),
        )
    } else if statement.contains("pg_catalog.pg_index") {
        (
            json!(["name", "uniqueValue", "primaryValue", "positionKeys"]),
            json!([{"name":"demo_pkey","uniqueValue":true,"primaryValue":true,"positionKeys":"1"}]),
        )
    } else if statement.starts_with("select 1") {
        let alias = statement
            .split_once(" as ")
            .map(|(_, name)| name.trim_end_matches(';'))
            .unwrap_or("?column?");
        (json!([alias]), json!([{(alias):1}]))
    } else if statement.starts_with("select *") {
        (json!(["id"]), json!([{"id":1}]))
    } else {
        (json!([]), json!([]))
    };
    json!({"columns":columns,"rowCount":rows.as_array().unwrap().len(),"rows":rows,"affectedRows":u8::from(statement.starts_with("insert"))})
}
