//! Explicit loopback-only Global Owner sessions. This is not a Workspace Key or hosted identity.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use uuid::Uuid;
use workspace_contracts::{MetaRequest, Metadata, Result, Scope, ServiceError};
fn denied() -> ServiceError {
    ServiceError::new(401, "OWNER_REQUIRED")
}
fn scope(workspace: &str, id: &str) -> Scope {
    Scope {
        authority_id: "global".into(),
        owner_kind: "workspace".into(),
        owner_id: workspace.into(),
        family: "local-global-owner".into(),
        partition_id: id.into(),
    }
}
fn digest(secret: &str) -> String {
    format!("{:x}", Sha256::digest(secret))
}
fn parse(secret: &str) -> Result<&str> {
    let (id, random) = secret
        .strip_prefix("glo_")
        .and_then(|v| v.split_once('_'))
        .ok_or_else(denied)?;
    if !Uuid::parse_str(id).is_ok_and(|v| v.to_string() == id)
        || random.len() != 64
        || !random.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(denied());
    }
    Ok(id)
}
async fn read(
    metadata: &Arc<dyn Metadata>,
    workspace: &str,
    secret: &str,
) -> Result<(Scope, Value)> {
    let id = parse(secret)?;
    let s = scope(workspace, id);
    let result = metadata
        .execute(MetaRequest::Get {
            scope: s.clone(),
            guard: None,
            keys: vec!["session".into()],
        })
        .await?;
    Ok((s, result["records"]["session"].clone()))
}
pub async fn issue(metadata: &Arc<dyn Metadata>, workspace: &str, now: i64) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    let secret = format!("glo_{id}_{}", workspace_domain::secret(32)?);
    metadata.execute(MetaRequest::Commit{scope:scope(workspace,&id),guard:None,mutation_id:Uuid::new_v4().to_string(),changes:vec![json!({"key":"session","expectedVersion":null,"value":{"workspaceId":workspace,"verifier":digest(&secret),"expiresAt":now+28800,"revoked":false}})]}).await?;
    authenticate(metadata, workspace, &secret, now).await?;
    Ok(secret)
}
pub async fn authenticate(
    metadata: &Arc<dyn Metadata>,
    workspace: &str,
    secret: &str,
    now: i64,
) -> Result<()> {
    let (_, record) = read(metadata, workspace, secret).await?;
    let value = &record["value"];
    let expected = digest(secret);
    let actual = value["verifier"].as_str().unwrap_or("");
    // The high-entropy secret has a fixed-size verifier and is never returned from storage.
    use subtle::ConstantTimeEq;
    if value["workspaceId"] != workspace
        || value["revoked"] != false
        || value["expiresAt"].as_i64().is_none_or(|t| t <= now)
        || !bool::from(actual.as_bytes().ct_eq(expected.as_bytes()))
    {
        return Err(denied());
    }
    Ok(())
}
pub async fn revoke(metadata: &Arc<dyn Metadata>, workspace: &str, secret: &str) -> Result<()> {
    let (s, record) = read(metadata, workspace, secret).await?;
    if record.is_null() {
        return Err(denied());
    }
    let mut value = record["value"].clone();
    value["revoked"] = json!(true);
    metadata
        .execute(MetaRequest::Commit {
            scope: s,
            guard: None,
            mutation_id: Uuid::new_v4().to_string(),
            changes: vec![
                json!({"key":"session","expectedVersion":record["version"],"value":value}),
            ],
        })
        .await?;
    Ok(())
}
