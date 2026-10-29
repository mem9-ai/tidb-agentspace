mod repository;
use chrono::{DateTime, SecondsFormat, Utc};
pub use repository::Repository;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use workspace_contracts::{Result, ServiceError};

#[derive(Clone)]
pub enum Credential {
    LocalDemoOwner,
    Bearer(String),
}
pub enum Operation {
    ListWorkspaces,
    GetWorkspace,
    ListKeys,
    CreateKey(Value),
    RevokeKey(String),
    UpdateSettings(Value),
    ListEvents,
}
pub struct Response {
    pub status: u16,
    pub body: Value,
}
pub struct Workspace {
    repository: std::sync::Arc<Repository>,
}
const SCOPES: &[&str] = &[
    "resources:read",
    "resources:write",
    "files:read",
    "files:write",
    "files:analyze",
    "queries:execute",
    "usage:read",
];
fn reject(status: u16, code: &str) -> ServiceError {
    ServiceError::new(status, code)
}
fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub fn secret(bytes: usize) -> Result<String> {
    let mut value = vec![0; bytes];
    getrandom::fill(&mut value).map_err(|_| reject(503, "RANDOM_UNAVAILABLE"))?;
    Ok(hex::encode(value))
}
fn length(value: &str) -> usize {
    value.encode_utf16().count()
}
fn key_view(key: &Value) -> Value {
    let mut result = key.clone();
    result
        .as_object_mut()
        .expect("validated key")
        .remove("digest");
    if result["resourceIds"].is_null() {
        result["resourceIds"] = json!([]);
    }
    result
}
fn event(state: &mut Value, action: &str, resource: &str, actor: &str) {
    let events = state["events"].as_array_mut().expect("validated events");
    events.insert(0,json!({"id":uuid::Uuid::new_v4().to_string(),"action":action,"resourceId":null,"resource":resource,"actor":actor,"at":timestamp(),"outcome":"success"}));
    events.truncate(200);
}
fn visible(resource: &Value) -> bool {
    match resource["kind"].as_str() {
        Some("mysql" | "duckdb" | "filesystem") => true,
        Some("postgresql") => resource["provider"] == "db9-anonymous",
        _ => false,
    }
}
#[derive(Clone)]
pub struct Principal {
    pub owner: bool,
    pub actor: String,
    pub id: String,
    pub scopes: Vec<String>,
    pub resource_ids: Vec<String>,
}
impl Principal {
    pub fn scope(&self, action: &str) -> Result<()> {
        if !self.owner && !self.scopes.iter().any(|s| s == "*" || s == action) {
            return Err(reject(403, "INSUFFICIENT_SCOPE"));
        }
        Ok(())
    }
    pub fn has(&self, id: &str) -> bool {
        self.owner || self.resource_ids.iter().any(|r| r == "*" || r == id)
    }
    pub fn resource(&self, state: &Value, id: &str, kind: Option<&str>) -> Result<Value> {
        if !self.has(id) {
            return Err(reject(403, "RESOURCE_ACCESS_DENIED"));
        }
        state["resources"]
            .as_array()
            .and_then(|v| {
                v.iter()
                    .find(|r| visible(r) && r["id"] == id && kind.is_none_or(|k| r["kind"] == k))
            })
            .cloned()
            .ok_or_else(|| reject(404, "NOT_FOUND"))
    }
}
pub fn principal(state: &Value, credential: &Credential) -> Result<Principal> {
    if let Credential::Bearer(token) = credential {
        let digest = hex::encode(Sha256::digest(token.as_bytes()));
        let key = state["keys"]
            .as_array()
            .and_then(|v| v.iter().find(|k| k["digest"] == digest))
            .ok_or_else(|| reject(401, "INVALID_KEY"))?;
        let expiry = key["expiresAt"]
            .as_str()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok());
        if !key["revokedAt"].is_null() || expiry.is_none_or(|d| d <= Utc::now()) {
            return Err(reject(401, "INVALID_KEY"));
        }
        return Ok(Principal {
            owner: false,
            actor: key["name"].as_str().unwrap_or("Key").into(),
            id: key["id"]
                .as_str()
                .ok_or_else(|| reject(401, "INVALID_KEY"))?
                .into(),
            scopes: strings(&key["scopes"]).ok_or_else(|| reject(401, "INVALID_KEY"))?,
            resource_ids: strings(&key["resourceIds"]).unwrap_or_default(),
        });
    }
    Ok(Principal {
        owner: true,
        actor: "You".into(),
        id: "local-owner".into(),
        scopes: vec!["*".into()],
        resource_ids: vec!["*".into()],
    })
}
impl Workspace {
    pub async fn authenticate(&self, credential: &Credential) -> Result<Principal> {
        self.repository
            .transaction(|state| {
                let p = principal(state, credential)?;
                if !p.owner
                    && let Some(key) = state["keys"]
                        .as_array_mut()
                        .and_then(|v| v.iter_mut().find(|k| k["id"] == p.id))
                {
                    key["lastUsedAt"] = json!(timestamp());
                }
                let dirty = !p.owner;
                Ok((p, dirty))
            })
            .await
    }
    pub fn repository(&self) -> std::sync::Arc<Repository> {
        self.repository.clone()
    }
    pub fn new(repository: Repository) -> Self {
        Self {
            repository: std::sync::Arc::new(repository),
        }
    }
    pub async fn health(&self) -> Result<()> {
        self.repository.read().await?;
        Ok(())
    }
    pub async fn close(&self) -> Result<()> {
        self.repository.close().await
    }
    pub async fn call(&self, credential: Credential, operation: Operation) -> Result<Response> {
        self.repository
            .transaction(move |state| execute_operation(state, credential, operation))
            .await
    }
}
fn execute_operation(
    state: &mut Value,
    credential: Credential,
    operation: Operation,
) -> Result<(Response, bool)> {
    let owner = matches!(credential, Credential::LocalDemoOwner);
    let mut dirty = false;
    let mut actor = "You".to_owned();
    let mut scopes = vec!["*".to_owned()];
    let mut resources = vec!["*".to_owned()];
    if let Credential::Bearer(token) = credential {
        let digest = hex::encode(Sha256::digest(token.as_bytes()));
        let keys = state["keys"]
            .as_array_mut()
            .ok_or_else(|| reject(503, "META_DOCUMENT_CORRUPT"))?;
        let key = keys
            .iter_mut()
            .find(|k| k["digest"] == digest)
            .ok_or_else(|| reject(401, "INVALID_KEY"))?;
        let expiry = key["expiresAt"]
            .as_str()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok());
        if !key["revokedAt"].is_null() || expiry.is_none_or(|date| date <= Utc::now()) {
            return Err(reject(401, "INVALID_KEY"));
        }
        scopes = strings(&key["scopes"]).ok_or_else(|| reject(401, "INVALID_KEY"))?;
        resources = strings(&key["resourceIds"]).unwrap_or_default();
        actor = key["name"].as_str().unwrap_or("Key").to_owned();
        key["lastUsedAt"] = json!(timestamp());
        dirty = true;
    }
    let owner_only = matches!(
        operation,
        Operation::ListKeys
            | Operation::CreateKey(_)
            | Operation::RevokeKey(_)
            | Operation::UpdateSettings(_)
    );
    if owner_only && !owner {
        return Err(reject(403, "OWNER_REQUIRED"));
    }
    if !owner_only && !scopes.iter().any(|s| s == "*" || s == "resources:read") {
        return Err(reject(403, "INSUFFICIENT_SCOPE"));
    }
    let mut status = 200;
    let body = match operation {
        Operation::ListWorkspaces => json!({"data":[state["workspace"].clone()]}),
        Operation::GetWorkspace => json!({"data":state["workspace"].clone()}),
        Operation::ListKeys => {
            let keys = state["keys"].as_array().expect("validated keys");
            if keys.iter().any(|k| !k.is_object()) {
                return Err(reject(503, "META_DOCUMENT_CORRUPT"));
            }
            json!({"data":keys.iter().map(key_view).collect::<Vec<_>>()})
        }
        Operation::CreateKey(input) => {
            let name = input["name"]
                .as_str()
                .filter(|s| length(trim(s)) >= 2 && length(s) <= 60)
                .ok_or_else(|| reject(400, "INVALID_NAME"))?;
            let input_scopes = strings(&input["scopes"])
                .filter(|v| !v.is_empty() && v.iter().all(|s| SCOPES.contains(&s.as_str())))
                .ok_or_else(|| reject(400, "INVALID_SCOPE"))?;
            let days = input["expiresInDays"]
                .as_i64()
                .filter(|n| [7, 30, 90].contains(n))
                .ok_or_else(|| reject(400, "INVALID_EXPIRY"))?;
            let grants = strings(&input["resourceIds"])
                .filter(|v| !v.is_empty())
                .ok_or_else(|| reject(400, "INVALID_RESOURCE_GRANT"))?;
            let has_wildcard = grants.iter().any(|id| id == "*");
            let known: std::collections::BTreeSet<_> = state["resources"]
                .as_array()
                .expect("validated resources")
                .iter()
                .filter(|r| visible(r))
                .filter_map(|r| r["id"].as_str())
                .collect();
            if (has_wildcard && grants.len() != 1)
                || (!has_wildcard && grants.iter().any(|id| !known.contains(id.as_str())))
            {
                return Err(reject(400, "INVALID_RESOURCE_GRANT"));
            }
            let name = trim(name);
            let token = format!("aw_demo_{}", secret(24)?);
            let key = json!({"id":uuid::Uuid::new_v4().to_string(),"name":name,"prefix":&token[..16],"digest":hex::encode(Sha256::digest(token.as_bytes())),"scopes":deduplicate(input_scopes),"resourceIds":deduplicate(grants),"createdAt":timestamp(),"expiresAt":(Utc::now()+chrono::Duration::days(days)).to_rfc3339_opts(SecondsFormat::Millis,true),"lastUsedAt":null,"revokedAt":null});
            state["keys"]
                .as_array_mut()
                .expect("validated keys")
                .push(key.clone());
            event(state, "key.created", name, &actor);
            dirty = true;
            status = 201;
            json!({"data":key_view(&key),"secret":token})
        }
        Operation::RevokeKey(id) => {
            let key = state["keys"]
                .as_array_mut()
                .expect("validated keys")
                .iter_mut()
                .find(|k| k["id"] == id)
                .ok_or_else(|| reject(404, "NOT_FOUND"))?;
            if key["revokedAt"].is_null() {
                key["revokedAt"] = json!(timestamp());
            }
            let name = key["name"].as_str().unwrap_or("Key").to_owned();
            event(state, "key.revoked", &name, &actor);
            dirty = true;
            json!({"revoked":true})
        }
        Operation::UpdateSettings(input) => {
            let workspace = input["workspaceName"]
                .as_str()
                .filter(|s| length(trim(s)) >= 2 && length(s) <= 50)
                .ok_or_else(|| reject(400, "INVALID_NAME"))?;
            let name = input["name"]
                .as_str()
                .filter(|s| !trim(s).is_empty() && length(s) <= 50)
                .ok_or_else(|| reject(400, "INVALID_NAME"))?;
            let workspace = trim(workspace);
            let name = trim(name);
            state["workspace"]["name"] = json!(workspace);
            state["profile"]["name"] = json!(name);
            state["workspace"]["description"] = json!(
                input["description"]
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .scan(0, |length, c| {
                        *length += c.len_utf16();
                        Some((*length, c))
                    })
                    .take_while(|(n, _)| *n <= 200)
                    .map(|(_, c)| c)
                    .collect::<String>()
            );
            event(state, "workspace.updated", workspace, &actor);
            dirty = true;
            json!({"saved":true})
        }
        Operation::ListEvents => {
            let data = filtered_events(state, owner, &resources);
            json!({"data":data})
        }
    };
    Ok((Response { status, body }, dirty))
}

fn strings(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|v| v.as_str().map(str::to_owned))
        .collect()
}
fn trim(value: &str) -> &str {
    value.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}
fn deduplicate(values: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn filtered_events(state: &Value, owner: bool, resources: &[String]) -> Vec<Value> {
    let retired: Vec<_> = state["resources"]
        .as_array()
        .expect("validated resources")
        .iter()
        .filter(|r| !visible(r))
        .map(|r| &r["id"])
        .collect();
    state["events"]
        .as_array()
        .expect("validated events")
        .iter()
        .filter(|event| {
            !retired.contains(&&event["resourceId"])
                && (owner
                    || event["resourceId"]
                        .as_str()
                        .is_some_and(|id| resources.iter().any(|r| r == "*" || r == id)))
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn corrupt_expiry_and_revocation_fail_closed() {
        for expiry in [
            Value::Null,
            json!("not-a-date"),
            json!("2000-01-01T00:00:00.000Z"),
        ] {
            let mut state = json!({"keys":[{"digest":hex::encode(Sha256::digest(b"original")),"expiresAt":expiry,"scopes":["resources:read"]}]});
            let error = execute_operation(
                &mut state,
                Credential::Bearer("original".into()),
                Operation::GetWorkspace,
            )
            .err()
            .expect("denied");
            assert_eq!(error.code, "INVALID_KEY");
        }
        let mut state = json!({"keys":[{"digest":hex::encode(Sha256::digest(b"original")),"expiresAt":"2099-01-01T00:00:00.000Z","revokedAt":true,"scopes":["resources:read"]}]});
        assert_eq!(
            execute_operation(
                &mut state,
                Credential::Bearer("original".into()),
                Operation::GetWorkspace
            )
            .err()
            .expect("denied")
            .code,
            "INVALID_KEY"
        );
    }
    #[test]
    fn display_names_keep_javascript_utf16_and_whitespace_rules() {
        assert_eq!(length("😀"), 2);
        assert_eq!(trim("\u{feff}Owner\u{feff}"), "Owner");
        assert_eq!(trim("\u{85}Owner\u{85}"), "\u{85}Owner\u{85}");
    }
}
