//! Internal Global Key records. This module does not expose an HTTP service, verify owner
//! identity, resolve resource grants, or install regional policy. Callers must do all of those
//! before using these primitives to authorize or issue customer credentials.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use subtle::ConstantTimeEq;
use uuid::Uuid;
use workspace_contracts::{MetaRequest, Metadata, Result, Scope};

use crate::{error, now};

/// Longest lifetime a Global Key may be issued with, in seconds. The console offers
/// 7/30/90 days and the regional Key policy enforces the same set, so the Global
/// endpoints must not accept a longer lifetime just because a client sent one.
pub const MAX_KEY_LIFETIME: i64 = 90 * 24 * 60 * 60;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyView {
    #[serde(default = "default_name")]
    pub name: String,
    #[serde(default)]
    pub created_at: i64,
    pub workspace_id: String,
    pub key_id: String,
    pub principal_id: String,
    pub key_version: u64,
    pub grant_ref: String,
    pub expires_at: i64,
    pub revoked: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyRecord {
    view: KeyView,
    verifier: String,
}

/// A credential is returned only on the successful initial write; never log or serialize it.
pub struct IssuedKey {
    pub view: KeyView,
    pub secret: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyPage {
    pub data: Vec<KeyView>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewKey {
    #[serde(default = "default_name")]
    pub name: String,
    pub workspace_id: String,
    pub principal_id: String,
    pub grant_ref: String,
    pub expires_at: i64,
}

pub struct GlobalKeys {
    metadata: Arc<dyn Metadata>,
}

fn default_name() -> String {
    "Agent key".into()
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
}
fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|v| v.to_string() == value)
}
fn scope(workspace: &str) -> Result<Scope> {
    if !valid_id(workspace) {
        return Err(error(400, "INVALID_WORKSPACE"));
    }
    Ok(Scope {
        authority_id: "global".into(),
        owner_kind: "workspace".into(),
        owner_id: workspace.into(),
        family: "global-keys".into(),
        partition_id: "primary".into(),
    })
}
fn digest(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}
fn make_secret(key_id: &str, workspace: &str) -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| error(503, "RANDOM_UNAVAILABLE"))?;
    Ok(format!(
        "awk_{key_id}_{}.{}",
        hex::encode(bytes),
        URL_SAFE_NO_PAD.encode(workspace)
    ))
}

fn parse_secret(secret: &str) -> Result<(&str, Option<String>)> {
    let denied = || error(401, "INVALID_CREDENTIAL");
    if secret.len() > 280 {
        return Err(denied());
    }
    let (key_id, tail) = secret
        .strip_prefix("awk_")
        .and_then(|v| v.split_once('_'))
        .filter(|(id, _)| uuid(id))
        .ok_or_else(denied)?;
    let (random, hint) = tail
        .split_once('.')
        .map_or((tail, None), |(random, hint)| (random, Some(hint)));
    if random.len() != 64
        || !random
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(denied());
    }
    let workspace = hint
        .map(|encoded| {
            let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| denied())?;
            if URL_SAFE_NO_PAD.encode(&bytes) != encoded {
                return Err(denied());
            }
            let workspace = String::from_utf8(bytes).map_err(|_| denied())?;
            if !valid_id(&workspace) {
                return Err(denied());
            }
            Ok(workspace)
        })
        .transpose()?;
    Ok((key_id, workspace))
}
fn fingerprint(value: &impl Serialize) -> Result<String> {
    Ok(hex::encode(Sha256::digest(
        serde_json::to_vec(value).map_err(|_| error(503, "KEY_RECORD_CORRUPT"))?,
    )))
}

fn valid_record(record: &KeyRecord, workspace: &str, key_id: &str) -> bool {
    record.view.workspace_id == workspace
        && record.view.key_id == key_id
        && uuid(key_id)
        && valid_id(&record.view.principal_id)
        && valid_id(&record.view.grant_ref)
        && record.view.key_version > 0
        && record.view.expires_at > 0
        && record.verifier.len() == 64
        && hex::decode(&record.verifier).is_ok_and(|v| v.len() == 32)
}

impl GlobalKeys {
    /// The hint is untrusted until the full secret is verified against its Workspace record.
    pub async fn authenticate_discovered(&self, secret: &str) -> Result<KeyView> {
        let (_, workspace) = parse_secret(secret)?;
        let workspace = workspace.ok_or_else(|| error(401, "INVALID_CREDENTIAL"))?;
        self.authenticate(&workspace, secret).await
    }
    pub async fn open(metadata: Arc<dyn Metadata>) -> Result<Self> {
        let health = metadata.health().await?;
        if health["authorityId"] != "global"
            || !health["capabilities"]
                .as_array()
                .is_some_and(|v| v.contains(&json!("recordsV1")))
        {
            return Err(error(503, "GLOBAL_METADATA_REQUIRED"));
        }
        Ok(Self { metadata })
    }

    async fn get(&self, scope: &Scope, keys: Vec<String>) -> Result<Value> {
        let response = self
            .metadata
            .execute(MetaRequest::Get {
                scope: scope.clone(),
                guard: None,
                keys: keys.clone(),
            })
            .await?;
        let records = response["records"]
            .as_object()
            .ok_or_else(|| error(503, "KEY_RECORD_CORRUPT"))?;
        if keys.iter().any(|key| !records.contains_key(key)) {
            return Err(error(503, "KEY_RECORD_CORRUPT"));
        }
        Ok(response["records"].clone())
    }

    /// Owner authorization is required at the transport boundary before calling this method.
    pub async fn key(&self, workspace: &str, key_id: &str) -> Result<KeyView> {
        if !uuid(key_id) {
            return Err(error(404, "NOT_FOUND"));
        }
        let scope = scope(workspace)?;
        let key = format!("keys/{key_id}");
        let result = self.get(&scope, vec![key.clone()]).await?;
        if result[&key].is_null() {
            return Err(error(404, "NOT_FOUND"));
        }
        let record: KeyRecord = serde_json::from_value(result[&key]["value"].clone())
            .map_err(|_| error(503, "KEY_RECORD_CORRUPT"))?;
        if !valid_record(&record, workspace, key_id) {
            return Err(error(503, "KEY_RECORD_CORRUPT"));
        }
        Ok(record.view)
    }

    /// Version history contains public metadata only; the secret is never recoverable here.
    pub async fn key_version(
        &self,
        workspace: &str,
        key_id: &str,
        version: u64,
    ) -> Result<KeyView> {
        if !uuid(key_id) || version == 0 {
            return Err(error(404, "NOT_FOUND"));
        }
        let scope = scope(workspace)?;
        let key = format!("versions/{key_id}/{version}");
        let result = self.get(&scope, vec![key.clone()]).await?;
        if result[&key].is_null() {
            return Err(error(404, "NOT_FOUND"));
        }
        let view: KeyView = serde_json::from_value(result[&key]["value"].clone())
            .map_err(|_| error(503, "KEY_RECORD_CORRUPT"))?;
        if view.workspace_id != workspace
            || view.key_id != key_id
            || view.key_version != version
            || !valid_id(&view.principal_id)
            || !valid_id(&view.grant_ref)
            || view.expires_at <= 0
        {
            return Err(error(503, "KEY_RECORD_CORRUPT"));
        }
        Ok(view)
    }

    /// Bounded cursor pagination; no verifier, secret or cross-Workspace scan is returned.
    pub async fn list(
        &self,
        workspace: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<KeyPage> {
        let scope = scope(workspace)?;
        if !(1..=100).contains(&limit) || cursor.is_some_and(|c| !uuid(c)) {
            return Err(error(400, "INVALID_PAGINATION"));
        }
        let page = self
            .metadata
            .execute(MetaRequest::List {
                scope,
                guard: None,
                prefix: "keys/".into(),
                after: cursor.map(|c| format!("keys/{c}")),
                limit,
            })
            .await?;
        let records = page["records"]
            .as_array()
            .ok_or_else(|| error(503, "KEY_RECORD_CORRUPT"))?;
        if records.len() > limit {
            return Err(error(503, "KEY_RECORD_CORRUPT"));
        }
        let mut data = Vec::with_capacity(records.len());
        for item in records {
            let id = item["key"]
                .as_str()
                .and_then(|key| key.strip_prefix("keys/"))
                .ok_or_else(|| error(503, "KEY_RECORD_CORRUPT"))?;
            let record: KeyRecord = serde_json::from_value(item["value"].clone())
                .map_err(|_| error(503, "KEY_RECORD_CORRUPT"))?;
            if !valid_record(&record, workspace, id) {
                return Err(error(503, "KEY_RECORD_CORRUPT"));
            }
            data.push(record.view);
        }
        let next_cursor = match &page["nextCursor"] {
            Value::Null => None,
            Value::String(value) => {
                let id = value
                    .strip_prefix("keys/")
                    .filter(|v| uuid(v))
                    .ok_or_else(|| error(503, "KEY_RECORD_CORRUPT"))?;
                Some(id.to_owned())
            }
            _ => return Err(error(503, "KEY_RECORD_CORRUPT")),
        };
        if let Some(next) = &next_cursor
            && (data.len() != limit || data.last().is_none_or(|view| &view.key_id != next))
        {
            return Err(error(503, "KEY_RECORD_CORRUPT"));
        }
        Ok(KeyPage { data, next_cursor })
    }

    async fn commit(&self, scope: &Scope, mutation: &str, changes: Vec<Value>) -> Result<()> {
        match self
            .metadata
            .execute(MetaRequest::Commit {
                scope: scope.clone(),
                guard: None,
                mutation_id: mutation.into(),
                changes,
            })
            .await
        {
            Ok(_) => Ok(()),
            Err(e) if e.code == "META_COMMIT_UNKNOWN" => {
                let receipt = self
                    .metadata
                    .execute(MetaRequest::Resolve {
                        scope: scope.clone(),
                        guard: None,
                        mutation_id: mutation.into(),
                    })
                    .await;
                if receipt.as_ref().is_ok_and(|v| v["outcome"] == "committed") {
                    Ok(())
                } else {
                    Err(e)
                }
            }
            Err(e) => Err(e),
        }
    }

    /// The caller must establish Owner authorization and validate the referenced grants before
    /// invoking this method. An ambiguous or replayed creation never returns a second secret.
    pub async fn create(&self, input: &NewKey, mutation: &str) -> Result<IssuedKey> {
        self.create_at(input, mutation, now()?).await
    }
    async fn create_at(&self, input: &NewKey, mutation: &str, current: i64) -> Result<IssuedKey> {
        let scope = scope(&input.workspace_id)?;
        if input.name.trim().is_empty()
            || input.name.len() > 80
            || !valid_id(&input.principal_id)
            || !valid_id(&input.grant_ref)
            || !uuid(mutation)
            || current <= 0
            || input.expires_at <= current
        {
            return Err(error(400, "INVALID_KEY_REQUEST"));
        }
        let latest_expiry = current
            .checked_add(MAX_KEY_LIFETIME)
            .ok_or_else(|| error(400, "INVALID_KEY_REQUEST"))?;
        if input.expires_at > latest_expiry {
            return Err(error(400, "KEY_LIFETIME_OUT_OF_RANGE"));
        }
        let operation = format!("operations/{mutation}");
        let fingerprint = fingerprint(input)?;
        let existing = self.get(&scope, vec![operation.clone()]).await?;
        if !existing[&operation].is_null() {
            return if existing[&operation]["value"]["fingerprint"] == fingerprint {
                Err(error(409, "KEY_SECRET_ALREADY_ISSUED"))
            } else {
                Err(error(409, "KEY_REQUEST_MISMATCH"))
            };
        }
        let view = KeyView {
            name: input.name.trim().into(),
            created_at: current,
            workspace_id: input.workspace_id.clone(),
            key_id: Uuid::new_v4().to_string(),
            principal_id: input.principal_id.clone(),
            key_version: 1,
            grant_ref: input.grant_ref.clone(),
            expires_at: input.expires_at,
            revoked: false,
        };
        let secret = make_secret(&view.key_id, &view.workspace_id)?;
        let verifier = digest(&secret);
        let record = KeyRecord {
            view: view.clone(),
            verifier: verifier.clone(),
        };
        let result = self.commit(&scope, mutation, vec![
            json!({"key":format!("keys/{}", view.key_id),"expectedVersion":null,"value":record}),
            json!({"key":format!("versions/{}/{}", view.key_id, view.key_version),"expectedVersion":null,"value":view}),
            json!({"key":operation,"expectedVersion":null,"value":{"fingerprint":fingerprint,"keyId":view.key_id}}),
        ]).await;
        match result {
            Ok(()) => {
                // A lost-reply resolution can observe another concurrent request's receipt.
                // Never return a secret unless both persisted records match this attempt.
                let key = format!("keys/{}", view.key_id);
                let persisted = self
                    .get(&scope, vec![key.clone(), operation.clone()])
                    .await?;
                if persisted[&operation]["value"]["fingerprint"] != fingerprint
                    || persisted[&operation]["value"]["keyId"] != view.key_id
                    || persisted[&key]["value"]["verifier"] != verifier
                    || persisted[&key]["value"]["view"] != json!(view)
                {
                    return Err(error(503, "KEY_COMMIT_INCONSISTENT"));
                }
                Ok(IssuedKey { view, secret })
            }
            Err(e) if ["META_CONFLICT", "META_MUTATION_MISMATCH"].contains(&e.code.as_str()) => {
                let prior = self.get(&scope, vec![operation.clone()]).await?;
                if prior[&operation]["value"]["fingerprint"] == fingerprint {
                    Err(error(409, "KEY_SECRET_ALREADY_ISSUED"))
                } else {
                    Err(e)
                }
            }
            Err(e) => Err(e),
        }
    }

    /// Authentication alone is not authorization. Callers must check current action, resource,
    /// Region and grant policy and recheck the record at the issuance/effect boundary.
    pub async fn authenticate(&self, workspace: &str, secret: &str) -> Result<KeyView> {
        self.authenticate_at(workspace, secret, now()?).await
    }
    async fn authenticate_at(
        &self,
        workspace: &str,
        secret: &str,
        current: i64,
    ) -> Result<KeyView> {
        let denied = || error(401, "INVALID_CREDENTIAL");
        if current <= 0 || secret.is_empty() {
            return Err(denied());
        }
        let scope = scope(workspace).map_err(|_| denied())?;
        let (key_id, hint) = parse_secret(secret)?;
        if hint.as_deref().is_some_and(|hint| hint != workspace) {
            return Err(denied());
        }
        let verifier = digest(secret);
        let key = format!("keys/{key_id}");
        let data = self.get(&scope, vec![key.clone()]).await?;
        if data[&key].is_null() {
            return Err(denied());
        }
        let record: KeyRecord = serde_json::from_value(data[&key]["value"].clone())
            .map_err(|_| error(503, "KEY_RECORD_CORRUPT"))?;
        if !valid_record(&record, workspace, key_id) {
            return Err(error(503, "KEY_RECORD_CORRUPT"));
        }
        let equal: bool = record.verifier.as_bytes().ct_eq(verifier.as_bytes()).into();
        if !equal
            || record.view.workspace_id != workspace
            || record.view.key_id != key_id
            || record.view.revoked
            || record.view.expires_at <= current
            || record.view.key_version == 0
        {
            return Err(denied());
        }
        Ok(record.view)
    }

    /// Owner authorization and grant policy validation are the caller's responsibility.
    /// The same secret is retained; descendants must use the incremented Key version.
    pub async fn renew(
        &self,
        workspace: &str,
        key_id: &str,
        expected_version: u64,
        expires_at: i64,
        mutation: &str,
    ) -> Result<KeyView> {
        self.change_at(
            workspace,
            key_id,
            expected_version,
            Some(expires_at),
            mutation,
            now()?,
        )
        .await
    }

    /// Revoke one logical Key and advance its version; regional delivery remains separate.
    pub async fn revoke(
        &self,
        workspace: &str,
        key_id: &str,
        expected_version: u64,
        mutation: &str,
    ) -> Result<KeyView> {
        self.change_at(workspace, key_id, expected_version, None, mutation, now()?)
            .await
    }

    /// Rotate the secret once. A replay can observe that it happened but never recover it.
    /// The caller must enforce Owner authorization and perform regional policy delivery.
    pub async fn rotate(
        &self,
        workspace: &str,
        key_id: &str,
        expected_version: u64,
        mutation: &str,
    ) -> Result<IssuedKey> {
        self.rotate_at(workspace, key_id, expected_version, mutation, now()?)
            .await
    }

    async fn rotate_at(
        &self,
        workspace: &str,
        key_id: &str,
        expected_version: u64,
        mutation: &str,
        current: i64,
    ) -> Result<IssuedKey> {
        let scope = scope(workspace)?;
        if !uuid(key_id) || !uuid(mutation) || expected_version == 0 || current <= 0 {
            return Err(error(400, "INVALID_KEY_REQUEST"));
        }
        let key = format!("keys/{key_id}");
        let operation = format!("operations/{mutation}");
        let request_fingerprint = fingerprint(&json!(["rotate", key_id, expected_version]))?;
        let records = self
            .get(&scope, vec![key.clone(), operation.clone()])
            .await?;
        if !records[&operation].is_null() {
            return if records[&operation]["value"]["fingerprint"] == request_fingerprint {
                Err(error(409, "KEY_SECRET_ALREADY_ISSUED"))
            } else {
                Err(error(409, "KEY_REQUEST_MISMATCH"))
            };
        }
        if records[&key].is_null() {
            return Err(error(404, "NOT_FOUND"));
        }
        let record_version = records[&key]["version"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| error(503, "KEY_RECORD_CORRUPT"))?;
        let mut record: KeyRecord = serde_json::from_value(records[&key]["value"].clone())
            .map_err(|_| error(503, "KEY_RECORD_CORRUPT"))?;
        if !valid_record(&record, workspace, key_id) {
            return Err(error(503, "KEY_RECORD_CORRUPT"));
        }
        if record.view.key_version != expected_version {
            return Err(error(409, "KEY_VERSION_CONFLICT"));
        }
        if record.view.revoked || record.view.expires_at <= current {
            return Err(error(409, "KEY_INACTIVE"));
        }
        let secret = make_secret(key_id, workspace)?;
        let verifier = digest(&secret);
        record.verifier = verifier.clone();
        record.view.key_version = record
            .view
            .key_version
            .checked_add(1)
            .ok_or_else(|| error(503, "KEY_VERSION_EXHAUSTED"))?;
        let view = record.view.clone();
        let result = self.commit(&scope, mutation, vec![
            json!({"key":key,"expectedVersion":record_version,"value":record}),
            json!({"key":format!("versions/{key_id}/{}", view.key_version),"expectedVersion":null,"value":view}),
            json!({"key":operation,"expectedVersion":null,"value":{"fingerprint":request_fingerprint,"keyId":key_id}}),
        ]).await;
        if let Err(e) = result {
            if !["META_CONFLICT", "META_MUTATION_MISMATCH"].contains(&e.code.as_str()) {
                return Err(e);
            }
            let prior = self.get(&scope, vec![operation.clone()]).await?;
            return if prior[&operation].is_null() {
                Err(error(409, "KEY_VERSION_CONFLICT"))
            } else if prior[&operation]["value"]["fingerprint"] == request_fingerprint {
                Err(error(409, "KEY_SECRET_ALREADY_ISSUED"))
            } else {
                Err(error(409, "KEY_REQUEST_MISMATCH"))
            };
        }
        let persisted = self
            .get(&scope, vec![key.clone(), operation.clone()])
            .await?;
        if persisted[&operation]["value"]["fingerprint"] != request_fingerprint
            || persisted[&operation]["value"]["keyId"] != key_id
            || persisted[&key]["value"]["verifier"] != verifier
            || persisted[&key]["value"]["view"] != json!(view)
        {
            return Err(error(503, "KEY_COMMIT_INCONSISTENT"));
        }
        Ok(IssuedKey { view, secret })
    }

    async fn change_at(
        &self,
        workspace: &str,
        key_id: &str,
        expected_version: u64,
        renewal: Option<i64>,
        mutation: &str,
        current: i64,
    ) -> Result<KeyView> {
        let scope = scope(workspace)?;
        if !uuid(key_id) || !uuid(mutation) || expected_version == 0 || current <= 0 {
            return Err(error(400, "INVALID_KEY_REQUEST"));
        }
        let key = format!("keys/{key_id}");
        let operation = format!("operations/{mutation}");
        let fingerprint = fingerprint(&json!(["key-change", key_id, expected_version, renewal]))?;
        let records = self
            .get(&scope, vec![key.clone(), operation.clone()])
            .await?;
        if !records[&operation].is_null() {
            if records[&operation]["value"]["fingerprint"] != fingerprint {
                return Err(error(409, "KEY_REQUEST_MISMATCH"));
            }
            return serde_json::from_value(records[&operation]["value"]["view"].clone())
                .map_err(|_| error(503, "KEY_RECORD_CORRUPT"));
        }
        if records[&key].is_null() {
            return Err(error(404, "NOT_FOUND"));
        }
        let version = records[&key]["version"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| error(503, "KEY_RECORD_CORRUPT"))?;
        let mut record: KeyRecord = serde_json::from_value(records[&key]["value"].clone())
            .map_err(|_| error(503, "KEY_RECORD_CORRUPT"))?;
        if !valid_record(&record, workspace, key_id) {
            return Err(error(503, "KEY_RECORD_CORRUPT"));
        }
        if record.view.key_version != expected_version {
            return Err(error(409, "KEY_VERSION_CONFLICT"));
        }
        if record.view.revoked {
            return Err(error(409, "KEY_REVOKED"));
        }
        if let Some(expiry) = renewal {
            if record.view.expires_at <= current || expiry <= record.view.expires_at {
                return Err(error(409, "KEY_RENEWAL_INVALID"));
            }
            let latest_expiry = current
                .checked_add(MAX_KEY_LIFETIME)
                .ok_or_else(|| error(400, "INVALID_KEY_REQUEST"))?;
            if expiry > latest_expiry {
                return Err(error(400, "KEY_LIFETIME_OUT_OF_RANGE"));
            }
            record.view.expires_at = expiry;
        } else {
            record.view.revoked = true;
        }
        record.view.key_version = record
            .view
            .key_version
            .checked_add(1)
            .ok_or_else(|| error(503, "KEY_VERSION_EXHAUSTED"))?;
        let view = record.view.clone();
        let result = self.commit(&scope, mutation, vec![
            json!({"key":key,"expectedVersion":version,"value":record}),
            json!({"key":format!("versions/{key_id}/{}", view.key_version),"expectedVersion":null,"value":view}),
            json!({"key":operation,"expectedVersion":null,"value":{"fingerprint":fingerprint,"view":view}}),
        ]).await;
        if let Err(e) = result
            && !["META_CONFLICT", "META_MUTATION_MISMATCH"].contains(&e.code.as_str())
        {
            return Err(e);
        }
        // Validate the durable receipt after both successful commit and ambiguous resolution.
        let persisted = self.get(&scope, vec![operation.clone()]).await?;
        if persisted[&operation]["value"]["fingerprint"] == fingerprint {
            serde_json::from_value(persisted[&operation]["value"]["view"].clone())
                .map_err(|_| error(503, "KEY_RECORD_CORRUPT"))
        } else if persisted[&operation].is_null() {
            Err(error(409, "KEY_VERSION_CONFLICT"))
        } else {
            Err(error(409, "KEY_REQUEST_MISMATCH"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::MemoryMeta;
    use std::sync::atomic::Ordering;

    fn input() -> NewKey {
        NewKey {
            name: "Test key".into(),
            workspace_id: "ws_agentlab".into(),
            principal_id: "legacy-owner".into(),
            grant_ref: "grant:unchanged".into(),
            expires_at: 1000,
        }
    }

    #[tokio::test]
    async fn key_lifetime_is_bounded_by_the_server_not_the_client() {
        let metadata = Arc::new(MemoryMeta::default());
        let keys = GlobalKeys::open(metadata).await.unwrap();
        let current = now().unwrap();

        let mut beyond = input();
        beyond.expires_at = current + MAX_KEY_LIFETIME + 3_600;
        assert_eq!(
            keys.create(&beyond, &Uuid::new_v4().to_string())
                .await
                .err()
                .unwrap()
                .code,
            "KEY_LIFETIME_OUT_OF_RANGE"
        );

        let mut past = input();
        past.expires_at = current - 1;
        assert_eq!(
            keys.create(&past, &Uuid::new_v4().to_string())
                .await
                .err()
                .unwrap()
                .code,
            "INVALID_KEY_REQUEST"
        );

        let mut at_cap = input();
        at_cap.expires_at = current + MAX_KEY_LIFETIME - 60;
        let issued = keys
            .create(&at_cap, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        assert_eq!(issued.view.expires_at, at_cap.expires_at);

        // Renewing must not hand out a longer lifetime than creating may.
        assert_eq!(
            keys.renew(
                "ws_agentlab",
                &issued.view.key_id,
                issued.view.key_version,
                current + MAX_KEY_LIFETIME + 3_600,
                &Uuid::new_v4().to_string(),
            )
            .await
            .err()
            .unwrap()
            .code,
            "KEY_LIFETIME_OUT_OF_RANGE"
        );
        let renewed = keys
            .renew(
                "ws_agentlab",
                &issued.view.key_id,
                issued.view.key_version,
                current + MAX_KEY_LIFETIME - 30,
                &Uuid::new_v4().to_string(),
            )
            .await
            .unwrap();
        assert_eq!(renewed.expires_at, current + MAX_KEY_LIFETIME - 30);
    }

    #[tokio::test]
    async fn workspace_hint_is_verified_and_legacy_keys_remain_usable_with_workspace() {
        let metadata = Arc::new(MemoryMeta::default());
        let keys = GlobalKeys::open(metadata.clone()).await.unwrap();
        let mut request = input();
        request.expires_at = now().unwrap() + 3600;
        let issued = keys
            .create(&request, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        assert_eq!(
            keys.authenticate_discovered(&issued.secret).await.unwrap(),
            issued.view
        );
        let prefix = issued.secret.split_once('.').unwrap().0;
        let altered = format!("{prefix}.{}", URL_SAFE_NO_PAD.encode("ws_another"));
        assert_eq!(
            keys.authenticate_discovered(&altered)
                .await
                .unwrap_err()
                .code,
            "INVALID_CREDENTIAL"
        );
        let group = crate::tests::group_key(&scope(&request.workspace_id).unwrap());
        metadata
            .groups
            .lock()
            .unwrap()
            .get_mut(&group)
            .unwrap()
            .get_mut(&format!("keys/{}", issued.view.key_id))
            .unwrap()["value"]["verifier"] = json!(digest(prefix));
        assert_eq!(
            keys.authenticate(&request.workspace_id, prefix)
                .await
                .unwrap(),
            issued.view
        );
        assert_eq!(
            keys.authenticate_discovered(prefix).await.unwrap_err().code,
            "INVALID_CREDENTIAL"
        );
    }

    #[tokio::test]
    async fn creation_is_workspace_scoped_once_only_and_never_stores_plaintext() {
        let metadata = Arc::new(MemoryMeta::default());
        let keys = GlobalKeys::open(metadata.clone()).await.unwrap();
        let mutation = Uuid::new_v4().to_string();
        let issued = keys.create_at(&input(), &mutation, 100).await.unwrap();
        assert!(issued.secret.starts_with("awk_"));
        assert!(issued.secret.len() > 105);
        assert_eq!(
            keys.authenticate_at("ws_agentlab", &issued.secret, 100)
                .await
                .unwrap(),
            issued.view
        );
        for (workspace, secret, time) in [
            ("ws_another", issued.secret.as_str(), 100),
            ("ws_agentlab", "incorrect", 100),
            ("ws_agentlab", issued.secret.as_str(), 1000),
            ("ws_agentlab", issued.secret.as_str(), 0),
        ] {
            assert_eq!(
                keys.authenticate_at(workspace, secret, time)
                    .await
                    .unwrap_err()
                    .code,
                "INVALID_CREDENTIAL"
            );
        }
        assert_eq!(
            keys.create_at(&input(), &mutation, 100)
                .await
                .err()
                .unwrap()
                .code,
            "KEY_SECRET_ALREADY_ISSUED"
        );
        let mut altered = input();
        altered.grant_ref = "grant:other".into();
        assert_eq!(
            keys.create_at(&altered, &mutation, 100)
                .await
                .err()
                .unwrap()
                .code,
            "KEY_REQUEST_MISMATCH"
        );
        let snapshot = serde_json::to_string(&*metadata.groups.lock().unwrap()).unwrap();
        assert!(!snapshot.contains(&issued.secret));
        assert!(snapshot.contains(&digest(&issued.secret)));
        assert!(metadata.groups.lock().unwrap().values().all(|group| {
            group
                .keys()
                .all(|key| !key.contains(&digest(&issued.secret)))
        }));
        let reopened = GlobalKeys::open(metadata).await.unwrap();
        assert_eq!(
            reopened
                .authenticate_at("ws_agentlab", &issued.secret, 100)
                .await
                .unwrap(),
            issued.view
        );
    }

    #[tokio::test]
    async fn renewal_and_revocation_are_versioned_fenced_and_retryable() {
        let metadata = Arc::new(MemoryMeta::default());
        let keys = GlobalKeys::open(metadata.clone()).await.unwrap();
        let issued = keys
            .create_at(&input(), &Uuid::new_v4().to_string(), 100)
            .await
            .unwrap();
        let id = &issued.view.key_id;
        let renewal = Uuid::new_v4().to_string();
        let next = keys
            .change_at("ws_agentlab", id, 1, Some(2000), &renewal, 100)
            .await
            .unwrap();
        assert_eq!(
            (next.key_version, next.expires_at, next.revoked),
            (2, 2000, false)
        );
        assert_eq!(
            keys.authenticate_at("ws_agentlab", &issued.secret, 1500)
                .await
                .unwrap(),
            next
        );
        assert_eq!(
            keys.change_at("ws_agentlab", id, 1, Some(2000), &renewal, 100)
                .await
                .unwrap(),
            next
        );
        assert_eq!(
            keys.change_at("ws_agentlab", id, 1, Some(3000), &renewal, 100)
                .await
                .unwrap_err()
                .code,
            "KEY_REQUEST_MISMATCH"
        );
        assert_eq!(
            keys.change_at(
                "ws_agentlab",
                id,
                1,
                Some(3000),
                &Uuid::new_v4().to_string(),
                100
            )
            .await
            .unwrap_err()
            .code,
            "KEY_VERSION_CONFLICT"
        );
        assert_eq!(
            keys.change_at(
                "ws_agentlab",
                id,
                2,
                Some(3000),
                &Uuid::new_v4().to_string(),
                2000
            )
            .await
            .unwrap_err()
            .code,
            "KEY_RENEWAL_INVALID"
        );
        let revoke = Uuid::new_v4().to_string();
        let revoked = keys
            .change_at("ws_agentlab", id, 2, None, &revoke, 100)
            .await
            .unwrap();
        assert_eq!((revoked.key_version, revoked.revoked), (3, true));
        assert_eq!(
            keys.change_at("ws_agentlab", id, 2, None, &revoke, 100)
                .await
                .unwrap(),
            revoked
        );
        assert_eq!(
            keys.authenticate_at("ws_agentlab", &issued.secret, 100)
                .await
                .unwrap_err()
                .code,
            "INVALID_CREDENTIAL"
        );
        assert_eq!(
            keys.change_at(
                "ws_agentlab",
                id,
                3,
                Some(3000),
                &Uuid::new_v4().to_string(),
                100
            )
            .await
            .unwrap_err()
            .code,
            "KEY_REVOKED"
        );
        let reopened = GlobalKeys::open(metadata).await.unwrap();
        assert_eq!(
            reopened
                .change_at("ws_agentlab", id, 2, None, &revoke, 100)
                .await
                .unwrap(),
            revoked
        );
    }

    #[tokio::test]
    async fn rotation_returns_one_secret_and_invalidates_the_old_verifier() {
        let metadata = Arc::new(MemoryMeta::default());
        let keys = GlobalKeys::open(metadata.clone()).await.unwrap();
        let issued = keys
            .create_at(&input(), &Uuid::new_v4().to_string(), 100)
            .await
            .unwrap();
        let mutation = Uuid::new_v4().to_string();
        let rotated = keys
            .rotate_at("ws_agentlab", &issued.view.key_id, 1, &mutation, 100)
            .await
            .unwrap();
        assert_eq!(
            keys.key_version("ws_agentlab", &issued.view.key_id, 1)
                .await
                .unwrap(),
            issued.view
        );
        assert_eq!(
            keys.key_version("ws_agentlab", &issued.view.key_id, 2)
                .await
                .unwrap(),
            rotated.view
        );
        assert_ne!(rotated.secret, issued.secret);
        assert_eq!(rotated.view.key_id, issued.view.key_id);
        assert_eq!(rotated.view.key_version, 2);
        assert_eq!(rotated.view.grant_ref, issued.view.grant_ref);
        assert_eq!(rotated.view.expires_at, issued.view.expires_at);
        assert_eq!(
            keys.authenticate_at("ws_agentlab", &issued.secret, 100)
                .await
                .unwrap_err()
                .code,
            "INVALID_CREDENTIAL"
        );
        assert_eq!(
            keys.authenticate_at("ws_agentlab", &rotated.secret, 100)
                .await
                .unwrap(),
            rotated.view
        );
        assert_eq!(
            keys.rotate_at("ws_agentlab", &issued.view.key_id, 1, &mutation, 100)
                .await
                .err()
                .unwrap()
                .code,
            "KEY_SECRET_ALREADY_ISSUED"
        );
        assert_eq!(
            keys.rotate_at("ws_agentlab", &issued.view.key_id, 2, &mutation, 100)
                .await
                .err()
                .unwrap()
                .code,
            "KEY_REQUEST_MISMATCH"
        );
        assert_eq!(
            keys.rotate_at(
                "ws_agentlab",
                &issued.view.key_id,
                1,
                &Uuid::new_v4().to_string(),
                100
            )
            .await
            .err()
            .unwrap()
            .code,
            "KEY_VERSION_CONFLICT"
        );
        let snapshot = serde_json::to_string(&*metadata.groups.lock().unwrap()).unwrap();
        assert!(!snapshot.contains(&issued.secret));
        assert!(!snapshot.contains(&rotated.secret));
    }

    #[tokio::test]
    async fn listing_is_paginated_workspace_scoped_and_excludes_verifiers() {
        let metadata = Arc::new(MemoryMeta::default());
        let keys = GlobalKeys::open(metadata).await.unwrap();
        let mut expected = Vec::new();
        let mut secrets = Vec::new();
        for _ in 0..3 {
            let issued = keys
                .create_at(&input(), &Uuid::new_v4().to_string(), 100)
                .await
                .unwrap();
            expected.push(issued.view.key_id);
            secrets.push(issued.secret);
        }
        let mut other = input();
        other.workspace_id = "different_workspace".into();
        let foreign = keys
            .create_at(&other, &Uuid::new_v4().to_string(), 100)
            .await
            .unwrap();
        let mut actual = Vec::new();
        let mut cursor = None;
        loop {
            let page = keys
                .list("ws_agentlab", cursor.as_deref(), 1)
                .await
                .unwrap();
            let visible = serde_json::to_string(&page).unwrap();
            for secret in &secrets {
                assert!(!visible.contains(secret) && !visible.contains(&digest(secret)));
            }
            assert!(!visible.contains(&foreign.view.key_id));
            actual.extend(page.data.into_iter().map(|view| view.key_id));
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        expected.sort();
        assert_eq!(actual, expected);
        assert_eq!(
            keys.key("ws_agentlab", &foreign.view.key_id)
                .await
                .unwrap_err()
                .code,
            "NOT_FOUND"
        );
        assert_eq!(
            keys.list("ws_agentlab", Some("../bad"), 10)
                .await
                .unwrap_err()
                .code,
            "INVALID_PAGINATION"
        );
        assert_eq!(
            keys.list("ws_agentlab", None, 101).await.unwrap_err().code,
            "INVALID_PAGINATION"
        );
    }

    #[tokio::test]
    async fn unknown_creation_response_does_not_issue_a_second_secret() {
        let metadata = Arc::new(MemoryMeta::default());
        let keys = GlobalKeys::open(metadata.clone()).await.unwrap();
        let mutation = Uuid::new_v4().to_string();
        metadata.lose_reply.store(true, Ordering::SeqCst);
        assert_eq!(
            keys.create_at(&input(), &mutation, 100)
                .await
                .err()
                .unwrap()
                .code,
            "META_COMMIT_UNKNOWN"
        );
        assert_eq!(
            keys.create_at(&input(), &mutation, 100)
                .await
                .err()
                .unwrap()
                .code,
            "KEY_SECRET_ALREADY_ISSUED"
        );
        let groups = metadata.groups.lock().unwrap();
        let records = groups.values().next().unwrap();
        assert_eq!(
            records
                .keys()
                .filter(|key| key.starts_with("keys/"))
                .count(),
            1
        );
    }
}
