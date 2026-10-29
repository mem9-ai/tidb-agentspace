use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Mutex;
use uuid::Uuid;
use workspace_contracts::{Gateway, MetaRequest, Metadata, Result, Scope, ServiceError};

fn error(code: &str) -> ServiceError {
    ServiceError::new(503, code)
}
fn scope(authority: &str, family: &str, owner: &str, partition: &str) -> Scope {
    Scope {
        authority_id: authority.into(),
        owner_kind: if family == "legacy-document" {
            "workspace"
        } else {
            "system"
        }
        .into(),
        owner_id: owner.into(),
        family: family.into(),
        partition_id: partition.into(),
    }
}
pub struct Repository {
    metadata: Arc<dyn Metadata>,
    document: Scope,
    gateway: Gateway,
    queue: Mutex<()>,
    closed: AtomicBool,
}
impl Repository {
    pub async fn open(
        metadata: Arc<dyn Metadata>,
        authority: &str,
        workspace: &str,
        import_id: &str,
        recover: Option<&str>,
    ) -> Result<Self> {
        if !authority.starts_with("region:") || workspace != "ws_agentlab" || import_id.is_empty() {
            return Err(error("META_INVALID_CONFIGURATION"));
        }
        let health = metadata.health().await?;
        if health["authorityId"] != authority
            || !health["capabilities"]
                .as_array()
                .is_some_and(|v| v.contains(&json!("legacyGatewayFencing")))
        {
            return Err(error("META_PROTOCOL_UNSUPPORTED"));
        }
        let control = metadata
            .execute(MetaRequest::Snapshot {
                scope: scope(authority, "imports", "migration", import_id),
                gateway: None,
            })
            .await?;
        if control["records"]["status"] != "verified"
            || control["records"]["workspaceId"] != workspace
        {
            return Err(error("META_IMPORT_NOT_VERIFIED"));
        }
        let gate = scope(authority, "legacy-gateway", "compatibility", workspace);
        let prior = metadata
            .execute(MetaRequest::Snapshot {
                scope: gate.clone(),
                gateway: None,
            })
            .await?;
        if let Some(owner) = prior["records"]["ownerId"].as_str()
            && Some(owner) != recover
        {
            return Err(error("META_GATEWAY_ACTIVE"));
        }
        let owner = Uuid::new_v4().to_string();
        metadata
            .execute(MetaRequest::Commit {
                scope: gate.clone(),
                gateway: None,
                expected_revision: revision(&prior)?,
                mutation_id: Uuid::new_v4().to_string(),
                changes: vec![json!({"key":"ownerId","value":owner})],
            })
            .await?;
        let result = Self {
            metadata,
            document: scope(authority, "legacy-document", workspace, "workspace"),
            gateway: Gateway {
                scope: gate,
                owner_id: owner,
            },
            queue: Mutex::new(()),
            closed: AtomicBool::new(false),
        };
        if let Err(error) = result.read().await {
            let _ = result.close().await;
            return Err(error);
        }
        Ok(result)
    }
    async fn snapshot_document(&self, name: &str) -> Result<Value> {
        if !["workspace", "drive9", "zero", "duckdb", "db9"].contains(&name) {
            return Err(error("META_INVALID_DOCUMENT"));
        }
        let mut document = self.document.clone();
        document.partition_id = name.into();
        if self.closed.load(Ordering::Acquire) {
            return Err(error("META_GATEWAY_CLOSED"));
        }
        self.metadata
            .execute(MetaRequest::Snapshot {
                scope: document,
                gateway: Some(self.gateway.clone()),
            })
            .await
    }
    pub async fn read(&self) -> Result<Value> {
        self.read_document("workspace").await
    }
    pub async fn read_document(&self, name: &str) -> Result<Value> {
        let _lock = self.queue.lock().await;
        decode(&self.snapshot_document(name).await?, name)
    }
    pub async fn transaction<T>(
        &self,
        apply: impl FnOnce(&mut Value) -> Result<(T, bool)> + Send,
    ) -> Result<T> {
        self.transaction_document("workspace", apply).await
    }
    pub async fn transaction_document<T>(
        &self,
        name: &str,
        apply: impl FnOnce(&mut Value) -> Result<(T, bool)> + Send,
    ) -> Result<T> {
        let _lock = self.queue.lock().await;
        let snapshot = self.snapshot_document(name).await?;
        let mut document = decode(&snapshot, name)?;
        let (result, dirty) = apply(&mut document)?;
        if dirty {
            let bytes =
                serde_json::to_vec(&document).map_err(|_| error("META_DOCUMENT_CORRUPT"))?;
            let mut scope = self.document.clone();
            scope.partition_id = name.into();
            self.metadata
                .execute(MetaRequest::Commit {
                    scope,
                    gateway: Some(self.gateway.clone()),
                    expected_revision: revision(&snapshot)?,
                    mutation_id: Uuid::new_v4().to_string(),
                    changes: encode(&bytes, &snapshot)?,
                })
                .await?;
        }
        Ok(result)
    }
    pub async fn close(&self) -> Result<()> {
        let _lock = self.queue.lock().await;
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let prior = self
            .metadata
            .execute(MetaRequest::Snapshot {
                scope: self.gateway.scope.clone(),
                gateway: None,
            })
            .await?;
        if prior["records"]["ownerId"] == self.gateway.owner_id {
            self.metadata
                .execute(MetaRequest::Commit {
                    scope: self.gateway.scope.clone(),
                    gateway: None,
                    expected_revision: revision(&prior)?,
                    mutation_id: Uuid::new_v4().to_string(),
                    changes: vec![json!({"key":"ownerId","delete":true})],
                })
                .await?;
        }
        Ok(())
    }
}
fn revision(snapshot: &Value) -> Result<Option<String>> {
    match &snapshot["revision"] {
        Value::Null => Ok(None),
        Value::String(s) => Ok(Some(s.clone())),
        _ => Err(error("META_DOCUMENT_CORRUPT")),
    }
}
fn decode(snapshot: &Value, name: &str) -> Result<Value> {
    if revision(snapshot)?.is_none() || snapshot["records"]["descriptor"]["format"] != 1 {
        return Err(error("META_DOCUMENT_MISSING"));
    }
    let records = snapshot["records"]
        .as_object()
        .ok_or_else(|| error("META_DOCUMENT_CORRUPT"))?;
    let mut chunks: Vec<_> = records
        .iter()
        .filter(|(key, _)| key.as_str() != "descriptor")
        .collect();
    chunks.sort_by_key(|(key, _)| *key);
    let mut bytes = Vec::new();
    for (i, (key, value)) in chunks.into_iter().enumerate() {
        if key != &format!("chunk-{i:05}") {
            return Err(error("META_DOCUMENT_CORRUPT"));
        }
        let chunk = STANDARD
            .decode(
                value
                    .as_str()
                    .ok_or_else(|| error("META_DOCUMENT_CORRUPT"))?,
            )
            .map_err(|_| error("META_DOCUMENT_CORRUPT"))?;
        if bytes.len() + chunk.len() > 12 * 1024 * 1024 {
            return Err(error("META_LEGACY_DOCUMENT_TOO_LARGE"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let descriptor = &snapshot["records"]["descriptor"];
    if descriptor["size"].as_u64() != Some(bytes.len() as u64)
        || descriptor["digest"] != hex::encode(Sha256::digest(&bytes))
    {
        return Err(error("META_DOCUMENT_CORRUPT"));
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| error("META_DOCUMENT_CORRUPT"))?;
    if name == "workspace"
        && (value["workspace"]["id"] != "ws_agentlab"
            || !value["resources"].is_array()
            || !value["keys"].is_array()
            || !value["events"].is_array()
            || !value["profile"].is_object())
    {
        return Err(error("META_DOCUMENT_CORRUPT"));
    }
    if name != "workspace" && !value["bindings"].is_object() {
        return Err(error("META_DOCUMENT_CORRUPT"));
    }
    Ok(value)
}
fn encode(bytes: &[u8], previous: &Value) -> Result<Vec<Value>> {
    if bytes.len() > 12 * 1024 * 1024 {
        return Err(error("META_LEGACY_DOCUMENT_TOO_LARGE"));
    }
    let mut changes = vec![
        json!({"key":"descriptor","value":{"format":1,"size":bytes.len(),"digest":hex::encode(Sha256::digest(bytes))}}),
    ];
    let mut names = std::collections::BTreeSet::from(["descriptor".to_owned()]);
    for (i, chunk) in bytes.chunks(64 * 1024).enumerate() {
        let name = format!("chunk-{i:05}");
        names.insert(name.clone());
        changes.push(json!({"key":name,"value":STANDARD.encode(chunk)}));
    }
    for name in previous["records"]
        .as_object()
        .ok_or_else(|| error("META_DOCUMENT_CORRUPT"))?
        .keys()
    {
        if !names.contains(name) {
            changes.push(json!({"key":name,"delete":true}));
        }
    }
    Ok(changes)
}
