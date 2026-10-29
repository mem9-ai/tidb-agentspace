use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fmt, future::Future, pin::Pin};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub authority_id: String,
    pub owner_kind: String,
    pub owner_id: String,
    pub family: String,
    pub partition_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Gateway {
    pub scope: Scope,
    pub owner_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum MetaRequest {
    Snapshot {
        scope: Scope,
        #[serde(default)]
        gateway: Option<Gateway>,
    },
    Commit {
        scope: Scope,
        #[serde(default)]
        gateway: Option<Gateway>,
        #[serde(rename = "expectedRevision")]
        expected_revision: Option<String>,
        #[serde(rename = "mutationId")]
        mutation_id: String,
        changes: Vec<Value>,
    },
    Resolve {
        scope: Scope,
        #[serde(default)]
        gateway: Option<Gateway>,
        #[serde(rename = "mutationId")]
        mutation_id: String,
    },
}

#[derive(Debug, Clone)]
pub struct ServiceError {
    pub status: u16,
    pub code: String,
}
impl ServiceError {
    pub fn new(status: u16, code: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
        }
    }
}
impl fmt::Display for ServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.code)
    }
}
impl std::error::Error for ServiceError {}
pub type Result<T> = std::result::Result<T, ServiceError>;
pub type Call<'a> = Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>>;

/// An authority-bound port. Local and remote implementations retain identical fencing.
pub trait Metadata: Send + Sync {
    fn execute(&self, request: MetaRequest) -> Call<'_>;
    fn health(&self) -> Call<'_>;
}
