#[path = "duckdb-runtime.rs"]
mod duckdb_runtime;
mod entry;
mod exec;
mod native;
pub use entry::execute_entry;
pub use native::{one_statement, safe_error};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use workspace_contracts::{Result, ServiceError};
fn err(status: u16, code: &str) -> ServiceError {
    ServiceError::new(status, code)
}
pub fn runtime_info() -> Value {
    json!({"duckdb":{"version":env!("WORKSPACE_DUCKDB_VERSION"),"linkage":"static","target":env!("WORKSPACE_DUCKDB_TARGET"),"archiveSha256":env!("WORKSPACE_DUCKDB_ARCHIVE_SHA256")}})
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub extension_path: Option<PathBuf>,
    pub extension_sha256: Option<String>,
}
pub struct Executor {
    pub config: Config,
    pub available: bool,
    pub analysis_slots: tokio::sync::Semaphore,
    pub database_slots: tokio::sync::Semaphore,
    pub active: std::sync::Mutex<std::collections::BTreeSet<String>>,
}
impl Executor {
    pub async fn new(config: Config) -> Self {
        let mut result = Self {
            config,
            available: false,
            analysis_slots: tokio::sync::Semaphore::new(2),
            database_slots: tokio::sync::Semaphore::new(4),
            active: std::sync::Mutex::new(std::collections::BTreeSet::new()),
        };
        if result.verify().is_ok() {
            result.available = result
                .execute(json!({"mode":"probe","extensionPath":result.config.extension_path}))
                .await
                .is_ok();
        }
        result
    }
    pub fn verify(&self) -> Result<()> {
        let path = self
            .config
            .extension_path
            .as_ref()
            .ok_or_else(|| err(503, "DUCKDB_RUNTIME_UNAVAILABLE"))?;
        let metadata =
            std::fs::symlink_metadata(path).map_err(|_| err(503, "DUCKDB_RUNTIME_UNAVAILABLE"))?;
        let bytes = std::fs::read(path).map_err(|_| err(503, "DUCKDB_RUNTIME_UNAVAILABLE"))?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || self.config.extension_sha256.as_ref() != Some(&hex::encode(Sha256::digest(bytes)))
        {
            return Err(err(503, "DUCKDB_RUNTIME_UNAVAILABLE"));
        }
        Ok(())
    }
    /// Execute one regional task. The child process is an internal same-binary strategy.
    pub async fn execute(&self, input: Value) -> Result<Value> {
        exec::execute(input).await
    }
    pub async fn database(
        &self,
        id: &str,
        connection: Value,
        sql: &str,
        sources: Value,
        read_only: bool,
    ) -> Result<Value> {
        self.database_job(id, json!({"mode":"database","connection":connection,"extensionPath":self.config.extension_path,"sql":sql,"sources":sources,"readOnly":read_only})).await
    }
    pub async fn import_statement(&self, id: &str, connection: Value, sql: &str) -> Result<Value> {
        self.database_job(id, json!({"mode":"database","connection":connection,"extensionPath":self.config.extension_path,"sql":sql,"sources":[],"readOnly":false,"importWrite":true})).await
    }
    async fn database_job(&self, id: &str, input: Value) -> Result<Value> {
        self.verify()?;
        let _slot = self
            .database_slots
            .try_acquire()
            .map_err(|_| err(429, "SQL_BUSY"))?;
        {
            let mut active = self.active.lock().expect("active query mutex");
            if !active.insert(id.into()) {
                return Err(err(429, "SQL_BUSY"));
            }
        }
        struct Active<'a>(
            &'a std::sync::Mutex<std::collections::BTreeSet<String>>,
            String,
        );
        impl Drop for Active<'_> {
            fn drop(&mut self) {
                self.0.lock().expect("active query mutex").remove(&self.1);
            }
        }
        let _active = Active(&self.active, id.into());
        let start = std::time::Instant::now();
        let result = self.execute(input).await;
        let mut value = result?;
        value["mode"] = json!("live");
        value["durationMs"] = json!(start.elapsed().as_millis() as u64);
        Ok(value)
    }
}
