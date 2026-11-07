#[path = "duckdb-runtime.rs"]
mod duckdb_runtime;
mod entry;
mod exec;
mod native;
pub use entry::execute_entry;
pub use native::{one_statement, safe_error};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
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
    pub analysis_slots: tokio::sync::Semaphore,
}
impl Default for Executor {
    fn default() -> Self {
        Self {
            analysis_slots: tokio::sync::Semaphore::new(2),
        }
    }
}
impl Executor {
    /// Execute one regional task. The child process is an internal same-binary strategy.
    pub async fn execute(&self, input: Value) -> Result<Value> {
        exec::execute(input).await
    }
}
