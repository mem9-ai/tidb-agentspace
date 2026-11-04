//! Private analytics projection port. This is not the Meta protocol or a Meta client.
use serde_json::Value;
use std::{future::Future, pin::Pin};
use workspace_contracts::Result;

#[derive(Clone)]
pub(crate) struct Namespace {
    pub authority_id: String,
}
pub(crate) enum Request {
    Get {
        scope: Namespace,
        keys: Vec<String>,
    },
    Commit {
        scope: Namespace,
        changes: Vec<Value>,
    },
    List {
        scope: Namespace,
        prefix: String,
        after: Option<String>,
        limit: usize,
    },
}
pub(crate) trait Storage: Send + Sync {
    fn execute(&self, request: Request)
    -> Pin<Box<dyn Future<Output = Result<Value>> + Send + '_>>;
}
