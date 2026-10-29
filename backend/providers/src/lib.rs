mod mysql;
mod sql;
use chrono::{DateTime, SecondsFormat, Utc};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::{Client, Method, Response, redirect, retry};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
pub use sql::execute_native;
use std::{sync::Arc, time::Duration};
use tokio::sync::{Mutex, Semaphore};
use workspace_contracts::{Result, ServiceError};
use workspace_domain::{Repository, secret};
pub const DRIVE9: &str = "drive9-anonymous";
pub const ZERO: &str = "tidb-cloud-zero";
pub const DB9: &str = "db9-anonymous";
pub const DUCKDB: &str = "duckdb-drive9";
pub fn err(status: u16, code: &str) -> ServiceError {
    ServiceError::new(status, code)
}
pub fn strv<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| err(502, "INVALID_PROVIDER_RESPONSE"))
}
pub fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub fn fs_path(path: &str) -> String {
    format!(
        "/v1/fs{}",
        path.split('/')
            .map(|p| utf8_percent_encode(p, NON_ALPHANUMERIC).to_string())
            .collect::<Vec<_>>()
            .join("/")
    )
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    #[serde(default = "local")]
    pub files_provider: String,
    #[serde(default = "local")]
    pub mysql_provider: String,
    #[serde(default = "local")]
    pub postgres_provider: String,
    #[serde(default)]
    pub test_mode: bool,
    pub drive9_endpoint: Option<String>,
    pub zero_endpoint: Option<String>,
    pub db9_endpoint: Option<String>,
    pub sql_fixture: Option<String>,
}
fn local() -> String {
    "local".into()
}
impl Default for Config {
    fn default() -> Self {
        Self {
            files_provider: local(),
            mysql_provider: local(),
            postgres_provider: local(),
            test_mode: false,
            drive9_endpoint: None,
            zero_endpoint: None,
            db9_endpoint: None,
            sql_fixture: None,
        }
    }
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        if !["local", DRIVE9].contains(&self.files_provider.as_str())
            || !["local", ZERO].contains(&self.mysql_provider.as_str())
            || !["local", DB9].contains(&self.postgres_provider.as_str())
        {
            return Err(err(503, "INVALID_PROVIDER_CONFIGURATION"));
        }
        for endpoint in [
            &self.drive9_endpoint,
            &self.zero_endpoint,
            &self.db9_endpoint,
            &self.sql_fixture,
        ]
        .into_iter()
        .flatten()
        {
            let url = reqwest::Url::parse(endpoint)
                .map_err(|_| err(503, "INVALID_PROVIDER_CONFIGURATION"))?;
            if !self.test_mode
                || url.scheme() != "http"
                || url.host_str() != Some("127.0.0.1")
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(err(503, "INVALID_PROVIDER_CONFIGURATION"));
            }
        }
        Ok(())
    }
}
pub struct Providers {
    pub config: Config,
    pub repository: Arc<Repository>,
    http: Client,
    setup: Mutex<()>,
    mysql_slots: Semaphore,
    postgres_slots: Semaphore,
}
impl Providers {
    pub fn new(config: Config, repository: Arc<Repository>) -> Result<Self> {
        config.validate()?;
        let http = Client::builder()
            .no_proxy()
            .redirect(redirect::Policy::none())
            .retry(retry::never())
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| err(503, "PROVIDER_UNAVAILABLE"))?;
        Ok(Self {
            config,
            repository,
            http,
            setup: Mutex::new(()),
            mysql_slots: Semaphore::new(4),
            postgres_slots: Semaphore::new(4),
        })
    }
    pub async fn binding(&self, doc: &str, id: &str) -> Result<Value> {
        Ok(self.repository.read_document(doc).await?["bindings"][id].clone())
    }
    pub async fn save_binding(&self, doc: &str, id: &str, binding: Value) -> Result<()> {
        self.repository
            .transaction_document(doc, move |v| {
                v["bindings"][id] = binding;
                Ok(((), true))
            })
            .await
    }
    pub async fn sql(&self, binding: &Value, statement: &str, setup: bool) -> Result<Value> {
        if statement.trim().is_empty() || statement.len() > 65536 {
            return Err(err(400, "INVALID_SQL"));
        }
        if let Some(endpoint) = &self.config.sql_fixture {
            let r = self
                .http
                .post(endpoint)
                .json(&json!({"binding":binding,"sql":statement,"setup":setup}))
                .send()
                .await
                .map_err(|_| err(502, "SQL_EXECUTION_FAILED"))?;
            let status = r.status().as_u16();
            let v: Value = serde_json::from_slice(&bounded(r, 1024 * 1024).await?)
                .map_err(|_| err(502, "SQL_EXECUTION_FAILED"))?;
            if status != 200 {
                return Err(err(
                    status,
                    v["error"]["code"]
                        .as_str()
                        .unwrap_or("SQL_EXECUTION_FAILED"),
                ));
            }
            return Ok(v);
        }
        execute_native(binding, statement, setup).await
    }
    pub async fn execute(&self, resource: &Value, statement: &str) -> Result<Value> {
        let slots = if resource["kind"] == "postgresql" {
            &self.postgres_slots
        } else {
            &self.mysql_slots
        };
        let _permit = slots.try_acquire().map_err(|_| err(429, "SQL_BUSY"))?;
        let doc = if resource["kind"] == "postgresql" {
            "db9"
        } else {
            "zero"
        };
        let binding = self.binding(doc, strv(resource, "id")?).await?;
        if binding["state"] != "ready" {
            return Err(err(503, "DATABASE_NOT_READY"));
        }
        if expired(&binding) {
            return Err(err(410, "DATABASE_EXPIRED"));
        }
        validate_binding(&binding["connection"], resource, false)?;
        let start = std::time::Instant::now();
        let mut result = self.sql(&binding["connection"], statement, false).await?;
        result["mode"] = json!("live");
        result["durationMs"] = json!(start.elapsed().as_millis() as u64);
        Ok(result)
    }
    /// Server-generated PostgreSQL metadata only. The session is disposable, never shared
    /// with customer SQL, and all statements share one admission slot and time/result budget.
    pub async fn postgres_catalog(
        &self,
        resource: &Value,
        statements: &[String],
    ) -> Result<Vec<Value>> {
        if resource["provider"] != DB9
            || resource["kind"] != "postgresql"
            || statements.is_empty()
            || statements.len() > 3
            || statements.iter().any(|sql| !sql.starts_with("SELECT "))
            || statements.iter().map(String::len).sum::<usize>() > 65536
        {
            return Err(err(400, "INVALID_SQL"));
        }
        let _permit = self
            .postgres_slots
            .try_acquire()
            .map_err(|_| err(429, "SQL_BUSY"))?;
        let binding = self.binding("db9", strv(resource, "id")?).await?;
        if binding["state"] != "ready" {
            return Err(err(503, "DATABASE_NOT_READY"));
        }
        if expired(&binding) {
            return Err(err(410, "DATABASE_EXPIRED"));
        }
        validate_binding(&binding["connection"], resource, false)?;
        if self.config.sql_fixture.is_some() {
            return tokio::time::timeout(Duration::from_secs(15), async {
                let mut results = vec![];
                for statement in statements {
                    results.push(self.sql(&binding["connection"], statement, false).await?);
                }
                Ok(results)
            })
            .await
            .map_err(|_| err(504, "SQL_TIMEOUT"))?;
        }
        sql::execute_postgres_catalog(&binding["connection"], statements).await
    }
    pub async fn status(&self, resource: &Value) -> Result<Value> {
        let provider = resource["provider"].as_str().unwrap_or("local");
        let id = strv(resource, "id")?;
        if provider == DRIVE9 {
            return self.file_status(id).await;
        }
        let doc = match provider {
            ZERO => "zero",
            DB9 => "db9",
            DUCKDB => "duckdb",
            _ => return Ok(json!({})),
        };
        let b = self.binding(doc, id).await?;
        if provider == ZERO && expired(&b) {
            return Ok(json!({"status":"expired","expiresAt":b["expiresAt"]}));
        }
        if b["state"] == "ready" {
            let mut v = json!({"status":"active"});
            if provider == ZERO {
                v["expiresAt"] = b["expiresAt"].clone();
            }
            return Ok(v);
        }
        Ok(
            json!({"status":if provider==DUCKDB||b["admin"].is_object(){"provisioning"}else{"failed"},"connectionError":"Setup needs operator recovery. Retry setup on the same resource; no replacement is created automatically."}),
        )
    }
    fn endpoint(&self, kind: &str) -> &str {
        match kind {
            "drive9" => self
                .config
                .drive9_endpoint
                .as_deref()
                .unwrap_or("https://api.drive9.ai"),
            "zero" => self
                .config
                .zero_endpoint
                .as_deref()
                .unwrap_or("https://zero.tidbapi.com/v1beta1/instances"),
            _ => self
                .config
                .db9_endpoint
                .as_deref()
                .unwrap_or("https://api.db9.ai/customer"),
        }
    }
    pub async fn file_connection(&self, id: &str) -> Result<Value> {
        let b = self.binding("drive9", id).await?;
        let key = b["apiKey"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| err(503, "PROVIDER_BINDING_MISSING"))?;
        Ok(json!({"endpoint":self.endpoint("drive9"),"apiKey":key}))
    }
    pub async fn file_request(
        &self,
        id: Option<&str>,
        path: &str,
        method: Method,
        bytes: Option<Vec<u8>>,
        headers: &[(&str, String)],
    ) -> Result<Response> {
        let mut request = self
            .http
            .request(method, format!("{}{}", self.endpoint("drive9"), path));
        if let Some(id) = id {
            let connection = self.file_connection(id).await?;
            request = request.bearer_auth(strv(&connection, "apiKey")?);
        }
        for (k, v) in headers {
            request = request.header(*k, v);
        }
        if let Some(bytes) = bytes {
            request = request.body(bytes);
        }
        let response = request
            .send()
            .await
            .map_err(|_| err(502, "PROVIDER_UNAVAILABLE"))?;
        let code = response.status().as_u16();
        if !(200..300).contains(&code) {
            return Err(match code {
                404 => err(404, "NOT_FOUND"),
                409 => err(409, "FILE_CONFLICT"),
                412 => err(409, "FILE_CHANGED"),
                413 => err(413, "FILE_TOO_LARGE"),
                429 => err(429, "PROVIDER_LIMIT"),
                _ => err(502, "PROVIDER_UNAVAILABLE"),
            });
        }
        Ok(response)
    }
    pub async fn file_json(&self, id: Option<&str>, path: &str, method: Method) -> Result<Value> {
        let r = self.file_request(id, path, method, None, &[]).await?;
        let v: Value = serde_json::from_slice(&bounded(r, 2 * 1024 * 1024).await?)
            .map_err(|_| err(502, "INVALID_PROVIDER_RESPONSE"))?;
        if !v.is_object() {
            return Err(err(502, "INVALID_PROVIDER_RESPONSE"));
        }
        Ok(v)
    }
    pub async fn file_status(&self, id: &str) -> Result<Value> {
        let v = self.file_json(Some(id), "/v1/status", Method::GET).await?;
        if ![
            "active",
            "provisioning",
            "failed",
            "suspended",
            "deleting",
            "deleted",
        ]
        .contains(&v["status"].as_str().unwrap_or(""))
        {
            return Err(err(502, "INVALID_PROVIDER_RESPONSE"));
        }
        let limit = match (
            v["max_upload_bytes"].as_u64(),
            v["inline_threshold"].as_u64(),
        ) {
            (Some(a), Some(b)) if a > 0 && b > 0 => a.min(b).min(1024 * 1024),
            _ => 0,
        };
        Ok(json!({"status":v["status"],"uploadLimitBytes":limit}))
    }
    pub async fn provision_files(&self, id: &str) -> Result<Value> {
        let _guard = self.setup.lock().await;
        self.provision_files_inner(id).await
    }
    async fn provision_files_inner(&self, id: &str) -> Result<Value> {
        let binding = self.binding("drive9", id).await?;
        if binding["apiKey"].is_string() {
            return self.file_status(id).await;
        }
        if !binding.is_null() {
            return Err(err(503, "PROVISION_OUTCOME_UNKNOWN"));
        }
        self.save_binding("drive9", id, json!({"state":"requested"}))
            .await?;
        let value = self.file_json(None, "/v1/provision", Method::POST).await?;
        if !value["api_key"].is_string() || !value["tenant_id"].is_string() {
            return Err(err(502, "INVALID_PROVIDER_RESPONSE"));
        }
        self.save_binding(
            "drive9",
            id,
            json!({"state":"bound","apiKey":value["api_key"],"tenantId":value["tenant_id"]}),
        )
        .await?;
        self.file_status(id).await
    }
    pub async fn file_list(&self, id: &str, path: &str) -> Result<Value> {
        let v = self
            .file_json(Some(id), &(fs_path(path) + "?list=1"), Method::GET)
            .await?;
        let entries = v["entries"]
            .as_array()
            .ok_or_else(|| err(502, "INVALID_PROVIDER_RESPONSE"))?;
        let mut rows = vec![];
        for entry in entries {
            let name = strv(entry, "name")?;
            if name.is_empty()
                || name == "."
                || name == ".."
                || name.chars().any(|c| c < ' ' || c == '/' || c == '\\')
                || !entry["isDir"].is_boolean()
                || entry["size"].as_u64().is_none()
            {
                return Err(err(502, "INVALID_PROVIDER_RESPONSE"));
            }
            let path = format!("{}/{name}", path.trim_end_matches('/'));
            let date = entry["mtime"]
                .as_f64()
                .and_then(|v| DateTime::from_timestamp_millis((v * 1000.0) as i64))
                .map(|v| v.to_rfc3339_opts(SecondsFormat::Millis, true));
            rows.push(json!({"id":format!("{id}:{path}"),"resourceId":id,"path":path,"type":if entry["isDir"]==true{"directory"}else{"file"},"size":entry["size"],"updatedAt":date}));
        }
        Ok(json!(rows))
    }
    pub async fn file_stat(&self, id: &str, path: &str) -> Result<Value> {
        let r = self
            .file_request(Some(id), &fs_path(path), Method::HEAD, None, &[])
            .await?;
        let h = r.headers();
        let size = h
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .ok_or_else(|| err(502, "INVALID_PROVIDER_RESPONSE"))?;
        let mut result =
            json!({"size":size,"directory":h.get("x-dat9-isdir").is_some_and(|v|v=="true")});
        for (a, b) in [
            ("etag", "revision"),
            ("x-dat9-revision", "dataRevision"),
            ("x-dat9-resource-id", "resourceIdentity"),
        ] {
            if let Some(v) = h.get(a).and_then(|v| v.to_str().ok()) {
                result[b] = json!(v);
            }
        }
        Ok(result)
    }
    pub async fn file_write<F, Fut>(
        &self,
        id: &str,
        path: &str,
        bytes: Vec<u8>,
        create_only: bool,
        before_write: F,
    ) -> Result<()>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<()>>,
    {
        let status = self.file_status(id).await?;
        if status["status"] != "active" {
            return Err(err(409, "PROVIDER_NOT_READY"));
        }
        let limit = status["uploadLimitBytes"].as_u64().unwrap_or(0);
        if limit == 0 || bytes.len() as u64 > limit {
            return Err(err(413, "FILE_TOO_LARGE"));
        }
        let mut h = vec![("content-type", "application/octet-stream".into())];
        if create_only {
            h.push(("X-Dat9-Expected-Revision", "0".into()));
        }
        before_write().await?;
        self.file_request(Some(id), &fs_path(path), Method::PUT, Some(bytes), &h)
            .await?;
        Ok(())
    }
    async fn db9_request(
        &self,
        path: &str,
        method: Method,
        body: Option<Value>,
        token: Option<&str>,
    ) -> Result<Value> {
        let mut request = self
            .http
            .request(method, format!("{}{}", self.endpoint("db9"), path))
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let r = request
            .send()
            .await
            .map_err(|_| err(503, "DB9_CREATION_UNCONFIRMED"))?;
        let status = r.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(if status == 429 {
                err(429, "DB9_RATE_LIMIT")
            } else {
                err(503, "DB9_REQUEST_REJECTED")
            });
        }
        serde_json::from_slice(&bounded(r, 256 * 1024).await?)
            .map_err(|_| err(503, "DB9_CREATION_UNCONFIRMED"))
    }
    async fn account(&self) -> Result<Value> {
        let mut saved = self.repository.read_document("db9").await?["account"].clone();
        if saved.is_null() {
            self.save_account(json!({"state":"requested"})).await?;
            let data = self
                .db9_request("/anonymous-register", Method::POST, None, None)
                .await?;
            saved = json!({"state":"received","response":data});
            self.save_account(saved.clone()).await?;
        }
        if saved["state"] == "received" {
            let d = &saved["response"];
            for key in ["anonymous_id", "anonymous_secret", "token"] {
                strv(d, key)?;
            }
            saved = json!({"state":"ready","anonymousId":d["anonymous_id"],"anonymousSecret":d["anonymous_secret"],"token":d["token"],"expiresAt":token_expiry(d)});
            self.save_account(saved.clone()).await?;
        }
        if saved["state"] != "ready" {
            return Err(err(503, "DB9_REGISTRATION_UNCONFIRMED"));
        }
        if saved["expiresAt"].as_i64().unwrap_or(0) <= Utc::now().timestamp_millis() + 60000 {
            let d=self.db9_request("/anonymous-refresh",Method::POST,Some(json!({"anonymous_id":saved["anonymousId"],"anonymous_secret":saved["anonymousSecret"]})),None).await?;
            strv(&d, "token")?;
            saved["token"] = d["token"].clone();
            saved["expiresAt"] = json!(token_expiry(&d));
            self.save_account(saved.clone()).await?;
        }
        Ok(saved)
    }
    async fn save_account(&self, value: Value) -> Result<()> {
        self.repository
            .transaction_document("db9", |d| {
                d["account"] = value;
                Ok(((), true))
            })
            .await
    }
    pub async fn provision_database(&self, r: &Value) -> Result<Value> {
        let _guard = self.setup.lock().await;
        if r["provider"] == ZERO {
            self.provision_zero(r).await
        } else {
            self.provision_db9(r).await
        }
    }
    async fn provision_zero(&self, r: &Value) -> Result<Value> {
        let id = strv(r, "id")?;
        let mut b = self.binding("zero", id).await?;
        if b["state"] == "ready" || expired(&b) {
            return self.status(r).await;
        }
        if b.is_null() {
            self.save_binding("zero", id, json!({"state":"requested"}))
                .await?;
            let result=async{let response=self.http.post(self.endpoint("zero")).json(&json!({"tag":"tidb-workspace"})).send().await.map_err(|_|err(503,"ZERO_CREATION_UNCONFIRMED"))?;
if !response.status().is_success(){return Err(err(503,"ZERO_CREATION_UNCONFIRMED"));}
let result:Value=serde_json::from_slice(&bounded(response,65536).await?).map_err(|_|err(503,"ZERO_CREATION_UNCONFIRMED"))?;
let instance=&result["instance"];
if !instance["id"].is_string()||!instance["expiresAt"].as_str().is_some_and(|s|DateTime::parse_from_rfc3339(s).is_ok_and(|d|d>Utc::now())){return Err(err(503,"ZERO_CREATION_UNCONFIRMED"));}
let admin=json!({"kind":"mysql","region":"automatic","host":instance["connection"]["host"],"port":instance["connection"]["port"],"user":instance["connection"]["username"],"password":instance["connection"]["password"],"database":"test"});validate_binding(&admin,r,true)?;
let login=strv(&admin,"user")?;
if !regex::Regex::new(r"^[a-zA-Z0-9_.-]+$").expect("regex").is_match(login){return Err(err(503,"ZERO_CREATION_UNCONFIRMED"));}
let prefix=login.rfind('.').map(|p|&login[..=p]).unwrap_or("");
let length=12usize.min(31usize.saturating_sub(prefix.len()));
if length<8{return Err(err(503,"ZERO_CREATION_UNCONFIRMED"));}
let user=format!("w{}",&secret(6)?[..length]);
let mut connection=admin.clone();connection["database"]=json!("workspace");connection["user"]=json!(format!("{prefix}{user}"));connection["password"]=json!(secret(32)?);
Ok(json!({"state":"configuring","instanceId":instance["id"],"expiresAt":instance["expiresAt"],"admin":admin,"user":user,"connection":connection}))}.await.map_err(|_|err(503,"ZERO_CREATION_UNCONFIRMED"))?;
            b = result;
            self.save_binding("zero", id, b.clone()).await?;
        }
        if !b["admin"].is_object() {
            return Err(err(503, "ZERO_CREATION_UNCONFIRMED"));
        }
        validate_binding(&b["admin"], r, true)?;
        validate_binding(&b["connection"], r, false)?;
        let role = strv(&b, "user")?;
        if !regex::Regex::new(r"^w[a-f0-9]{8,12}$")
            .expect("regex")
            .is_match(role)
            || !b["connection"]["user"]
                .as_str()
                .is_some_and(|v| v == role || v.ends_with(&format!(".{role}")))
            || !regex::Regex::new(r"^[a-f0-9]{64}$")
                .expect("regex")
                .is_match(strv(&b["connection"], "password")?)
        {
            return Err(err(503, "ZERO_SETUP_INCOMPLETE"));
        }
        let setup=async{self.sql(&b["admin"],"CREATE DATABASE IF NOT EXISTS `workspace`",true).await?;
self.sql(&b["admin"],&format!("CREATE USER IF NOT EXISTS '{}'@'%' IDENTIFIED BY '{}'",strv(&b["connection"],"user")?,strv(&b["connection"],"password")?),true).await?;
self.sql(&b["admin"],&format!("GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES ON `workspace`.* TO '{}'@'%'",strv(&b["connection"],"user")?),true).await?;
self.sql(&b["connection"],"SELECT 1 AS connected",false).await?;
Result::Ok(())}.await;
        if setup.is_err() {
            return Err(err(503, "ZERO_SETUP_INCOMPLETE"));
        }
        self.save_binding("zero",id,json!({"state":"ready","instanceId":b["instanceId"],"expiresAt":b["expiresAt"],"connection":b["connection"]})).await?;
        self.status(r).await
    }
    async fn provision_db9(&self, r: &Value) -> Result<Value> {
        let id = strv(r, "id")?;
        let mut b = self.binding("db9", id).await?;
        if b["state"] == "ready" {
            return self.status(r).await;
        }
        let fresh = b.is_null();
        if fresh {
            b = json!({"state":"requested","name":format!("workspace-{}",id.replace('_',"-")),"adminPassword":secret(32)?,"role":format!("w{}",secret(6)?),"password":secret(32)?});
            self.save_binding("db9", id, b.clone()).await?;
        }
        if b["state"] == "requested" {
            let account = self.account().await?;
            let token = strv(&account, "token")?;
            let data = if fresh {
                self.db9_request(
                    "/databases",
                    Method::POST,
                    Some(json!({"name":b["name"],"admin_password":b["adminPassword"]})),
                    Some(token),
                )
                .await?
            } else {
                let entries = self
                    .db9_request("/databases", Method::GET, None, Some(token))
                    .await?;
                let matches: Vec<_> = entries
                    .as_array()
                    .ok_or_else(|| err(503, "DB9_CREATION_UNCONFIRMED"))?
                    .iter()
                    .filter(|e| e["name"] == b["name"])
                    .collect();
                if matches.len() != 1 {
                    return Err(err(503, "DB9_CREATION_UNCONFIRMED"));
                }
                let target = strv(matches[0], "id")?;
                if !regex::Regex::new(r"^[a-zA-Z0-9_-]+$")
                    .expect("regex")
                    .is_match(target)
                {
                    return Err(err(503, "DB9_CREATION_UNCONFIRMED"));
                }
                self.db9_request(
                    &format!("/databases/{target}"),
                    Method::GET,
                    None,
                    Some(token),
                )
                .await?
            };
            b["state"] = json!("received");
            b["response"] = data;
            self.save_binding("db9", id, b.clone()).await?;
        }
        if b["state"] == "received" {
            let response = &b["response"];
            let url = reqwest::Url::parse(strv(response, "connection_string")?)
                .map_err(|_| err(503, "DB9_CREATION_UNCONFIRMED"))?;
            if !["postgres", "postgresql"].contains(&url.scheme()) {
                return Err(err(503, "DB9_CREATION_UNCONFIRMED"));
            }
            let admin = json!({"kind":"postgresql","region":"automatic","host":url.host_str(),"port":url.port().unwrap_or(5432),"user":percent_encoding::percent_decode_str(url.username()).decode_utf8().map_err(|_|err(503,"DB9_CREATION_UNCONFIRMED"))?.to_string(),"database":url.path().trim_start_matches('/'),"password":response["admin_password"].as_str().unwrap_or(b["adminPassword"].as_str().unwrap_or(""))});
            validate_binding(&admin, r, true)?;
            let instance = strv(response, "id")?;
            if admin["user"] != format!("{instance}.admin") {
                return Err(err(503, "DB9_CREATION_UNCONFIRMED"));
            }
            let mut connection = admin.clone();
            connection["user"] = json!(format!("{instance}.{}", strv(&b, "role")?));
            connection["password"] = b["password"].clone();
            b = json!({"state":"configuring","name":b["name"],"instanceId":instance,"role":b["role"],"admin":admin,"connection":connection});
            self.save_binding("db9", id, b.clone()).await?;
        }
        if !b["admin"].is_object() {
            return Err(err(503, "DB9_CREATION_UNCONFIRMED"));
        }
        validate_binding(&b["admin"], r, true)?;
        validate_binding(&b["connection"], r, false)?;
        let role = strv(&b, "role")?;
        if !regex::Regex::new(r"^w[a-f0-9]{12}$")
            .expect("regex")
            .is_match(role)
            || !b["connection"]["user"]
                .as_str()
                .is_some_and(|v| v == role || v.ends_with(&format!(".{role}")))
            || !regex::Regex::new(r"^[a-f0-9]{64}$")
                .expect("regex")
                .is_match(strv(&b["connection"], "password")?)
        {
            return Err(err(503, "DB9_SETUP_INCOMPLETE"));
        }
        let setup=async{let role=strv(&b,"role")?;
let query=format!("SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = '{role}'");
let roles=self.sql(&b["admin"],&query,true).await?;
if roles["rows"].as_array().is_none_or(|v|v.is_empty()){self.sql(&b["admin"],&format!("CREATE ROLE \"{role}\" LOGIN PASSWORD '{}' NOSUPERUSER NOCREATEDB NOCREATEROLE",strv(&b["connection"],"password")?),true).await?;}
self.sql(&b["admin"],&format!("CREATE SCHEMA IF NOT EXISTS workspace AUTHORIZATION \"{role}\""),true).await?;
let check=self.sql(&b["admin"],&format!("SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = '{role}'"),true).await?;
let rows=check["rows"].as_array().ok_or_else(||err(503,"DB9_SETUP_INCOMPLETE"))?;
if rows.len()!=1||["rolsuper","rolcreatedb","rolcreaterole"].iter().any(|k|rows[0][k]!=false){return Err(err(503,"DB9_SETUP_INCOMPLETE"));}
let check=self.sql(&b["connection"],"SELECT n.nspowner = r.oid AS owned FROM pg_namespace n JOIN pg_roles r ON r.rolname = current_user WHERE n.nspname = 'workspace'",false).await?;
if check["rows"].as_array().is_none_or(|v|v.len()!=1)||check["rows"][0]["owned"]!=true{return Err(err(503,"DB9_SETUP_INCOMPLETE"));}
Result::Ok(())}.await;
        if setup.is_err() {
            return Err(err(503, "DB9_SETUP_INCOMPLETE"));
        }
        self.save_binding("db9",id,json!({"state":"ready","name":b["name"],"instanceId":b["instanceId"],"connection":b["connection"]})).await?;
        self.status(r).await
    }
}
pub async fn bounded(mut response: Response, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = vec![];
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| err(502, "PROVIDER_UNAVAILABLE"))?
    {
        if bytes.len() + chunk.len() > limit {
            return Err(err(413, "CONTENT_TOO_LARGE"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
pub fn expired(binding: &Value) -> bool {
    binding["expiresAt"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .is_some_and(|d| d <= Utc::now())
}
fn token_expiry(v: &Value) -> i64 {
    if let Some(date) = v["expires_at"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
    {
        return date.timestamp_millis();
    }
    use base64::Engine;
    v["token"]
        .as_str()
        .and_then(|s| s.split('.').nth(1))
        .and_then(|s| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(s)
                .ok()
        })
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["exp"].as_i64())
        .unwrap_or(0)
        * 1000
}
pub fn validate_binding(b: &Value, r: &Value, admin: bool) -> Result<()> {
    let mysql = r["kind"] == "mysql";
    if b["kind"] != r["kind"]
        || b["region"] != r["region"]
        || r["region"] != "automatic"
        || !["user", "password", "database", "host"].iter().all(|k| {
            b[k].as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 16384)
        })
    {
        return Err(err(503, "DATABASE_NOT_CONFIGURED"));
    }
    let port = b["port"].as_u64().unwrap_or(0);
    let host = b["host"].as_str().unwrap_or("");
    let valid = if mysql {
        regex::Regex::new(r"^[a-z0-9.-]+\.tidbcloud\.com$")
            .expect("regex")
            .is_match(host)
            && port > 0
            && port <= 65535
            && regex::Regex::new(r"^[a-zA-Z][a-zA-Z0-9_]{0,63}$")
                .expect("regex")
                .is_match(b["database"].as_str().unwrap_or(""))
    } else {
        ["pg.db9.io", "pg.d0000.db9.io"].contains(&host)
            && [5432, 5433].contains(&port)
            && b["database"] == "postgres"
            && regex::Regex::new(if admin {
                r"^[a-zA-Z0-9_-]+\.admin$"
            } else {
                r"^[a-zA-Z0-9_-]+\.w[a-f0-9]{12}$"
            })
            .expect("regex")
            .is_match(b["user"].as_str().unwrap_or(""))
    };
    if !valid {
        return Err(err(503, "DATABASE_NOT_CONFIGURED"));
    }
    Ok(())
}
