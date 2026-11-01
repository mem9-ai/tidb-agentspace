use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fmt, future::Future, pin::Pin};

pub const RESOURCE_INDEX_SCHEMA: &str = "indexes/resource-v1/schema";

/// Commit only atomically with a brand-new, empty Workspace. Existing Workspaces must
/// retain their resumable backfill and may never be marked ready by this initializer.
pub fn initial_resource_index() -> Value {
    json!({"key":RESOURCE_INDEX_SCHEMA,"expectedVersion":null,"value":{"format":1,"phase":"ready","after":null,"position":0}})
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub authority_id: String,
    pub owner_kind: String,
    pub owner_id: String,
    pub family: String,
    pub partition_id: String,
}

impl Scope {
    /// Authority-local state that does not belong to a customer Workspace.
    pub fn system(authority: &str, owner: &str, family: &str, partition: &str) -> Self {
        Self {
            authority_id: authority.into(),
            owner_kind: "system".into(),
            owner_id: owner.into(),
            family: family.into(),
            partition_id: partition.into(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriterGuard {
    pub owner_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum MetaRequest {
    Get {
        scope: Scope,
        #[serde(default)]
        guard: Option<WriterGuard>,
        keys: Vec<String>,
    },
    List {
        scope: Scope,
        #[serde(default)]
        guard: Option<WriterGuard>,
        prefix: String,
        after: Option<String>,
        limit: usize,
    },
    Commit {
        scope: Scope,
        #[serde(default)]
        guard: Option<WriterGuard>,
        #[serde(rename = "mutationId")]
        mutation_id: String,
        changes: Vec<Value>,
    },
    Resolve {
        scope: Scope,
        #[serde(default)]
        guard: Option<WriterGuard>,
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

#[cfg(test)]
mod tests {
    use super::Scope;

    #[test]
    fn system_scope_is_bound_to_its_authority_and_has_no_workspace_owner() {
        let scope = Scope::system("region:example", "control-plane", "runtime-state", "clock");
        assert_eq!(scope.authority_id, "region:example");
        assert_eq!(scope.owner_kind, "system");
        assert_eq!(scope.owner_id, "control-plane");
        assert_eq!(scope.family, "runtime-state");
        assert_eq!(scope.partition_id, "clock");
    }
}
