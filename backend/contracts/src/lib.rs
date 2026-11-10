use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fmt, future::Future, pin::Pin};

/// New anonymous sessions last 48 hours. Legacy sessions keep their recorded deadline.
pub const GUEST_SESSION_SECONDS: i64 = 48 * 60 * 60;

pub fn valid_guest_session_window(created: i64, expires: i64) -> bool {
    matches!(
        expires.checked_sub(created),
        Some(86_400 | GUEST_SESSION_SECONDS)
    )
}

/// Public resource families which may receive a dynamic Workspace Key grant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceType {
    Database,
    Filesystem,
}
impl ResourceType {
    pub fn from_public_kind(kind: &str) -> Option<Self> {
        match kind {
            "postgresql" => Some(Self::Database),
            "filesystem" => Some(Self::Filesystem),
            _ => None,
        }
    }
}

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

/// A bounded read within one workspace, for an authority-local consistent snapshot.
#[derive(Clone)]
pub struct MetaRead {
    pub scope: Scope,
    pub guard: Option<WriterGuard>,
    pub keys: Vec<String>,
}

pub fn validate_meta_reads(reads: &[MetaRead]) -> Result<()> {
    let Some(first) = reads.first() else {
        return Err(ServiceError::new(400, "META_INVALID_REQUEST"));
    };
    if reads.len() > 8
        || first.scope.owner_kind != "workspace"
        || reads.iter().any(|read| {
            read.scope.authority_id != first.scope.authority_id
                || read.scope.owner_kind != first.scope.owner_kind
                || read.scope.owner_id != first.scope.owner_id
                || read.scope.partition_id != first.scope.partition_id
                || read.keys.is_empty()
        })
        || reads.iter().map(|read| read.keys.len()).sum::<usize>() > 512
    {
        return Err(ServiceError::new(400, "META_INVALID_REQUEST"));
    }
    Ok(())
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

    /// Remote/older implementations keep their existing fenced reads; embedded engines may
    /// override this with one snapshot without changing the metadata wire protocol.
    fn read_workspace_scopes(&self, reads: Vec<MetaRead>) -> Call<'_> {
        Box::pin(async move {
            validate_meta_reads(&reads)?;
            let mut results = Vec::with_capacity(reads.len());
            for read in reads {
                results.push(
                    self.execute(MetaRequest::Get {
                        scope: read.scope,
                        guard: read.guard,
                        keys: read.keys,
                    })
                    .await?,
                );
            }
            Ok(json!({"results": results}))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{MetaRead, Scope, validate_meta_reads};

    #[test]
    fn system_scope_is_bound_to_its_authority_and_has_no_workspace_owner() {
        let scope = Scope::system("region:example", "control-plane", "runtime-state", "clock");
        assert_eq!(scope.authority_id, "region:example");
        assert_eq!(scope.owner_kind, "system");
        assert_eq!(scope.owner_id, "control-plane");
        assert_eq!(scope.family, "runtime-state");
        assert_eq!(scope.partition_id, "clock");
    }

    #[test]
    fn grouped_reads_require_one_workspace_and_bounded_keys() {
        let scope = Scope {
            authority_id: "region:a".into(),
            owner_kind: "workspace".into(),
            owner_id: "workspace-a".into(),
            family: "workspace".into(),
            partition_id: "primary".into(),
        };
        let read = MetaRead {
            scope,
            guard: None,
            keys: vec!["item".into()],
        };
        let mut policy = read.clone();
        policy.scope.family = "regional-policy".into();
        assert!(validate_meta_reads(&[read.clone(), policy.clone()]).is_ok());
        policy.scope.owner_id = "workspace-b".into();
        assert!(validate_meta_reads(&[read.clone(), policy]).is_err());
        assert!(validate_meta_reads(&[]).is_err());
        let mut excessive = read;
        excessive.keys = vec!["item".into(); 513];
        assert!(validate_meta_reads(&[excessive]).is_err());
    }
}
