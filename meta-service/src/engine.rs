use crate::config::{Config, Installation, private_file, valid_id};
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, AeadCore, OsRng, Payload},
};
use anyhow::{Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use slatedb::{
    Db, DbTransaction, ErrorKind, IsolationLevel,
    config::{DurabilityLevel, ReadOptions, ScanOptions},
    object_store::{
        ObjectStore, ObjectStoreExt, PutMode, PutOptions, UpdateVersion, aws::AmazonS3Builder,
        path::Path,
    },
};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::RwLock;
use uuid::Uuid;
pub struct Engine {
    pub config: Config,
    db: Db,
    store: Arc<dyn ObjectStore>,
    cipher: Aes256Gcm,
    owner: Owner,
    healthy: AtomicBool,
    closed: AtomicBool,
    lifecycle: RwLock<()>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Owner {
    id: String,
    installation_id: String,
    released: bool,
}
pub use workspace_contracts::{Gateway, MetaRequest as Request, Scope};
#[derive(Debug)]
pub struct Failure(pub u16, pub &'static str);
type Outcome<T> = std::result::Result<T, Failure>;
fn unavailable(_: impl std::fmt::Display) -> Failure {
    Failure(503, "META_UNAVAILABLE")
}
fn corrupt(_: impl std::fmt::Display) -> Failure {
    Failure(503, "META_CORRUPT")
}
fn safe_json(value: &Value) -> bool {
    match value {
        Value::Number(n) => n.as_f64().is_some_and(|v| {
            v.is_finite() && (v.fract() != 0.0 || v.abs() <= 9_007_199_254_740_991.0)
        }),
        Value::Array(a) => a.iter().all(safe_json),
        Value::Object(m) => m.iter().all(|(k, v)| {
            !["__proto__", "constructor", "prototype"].contains(&k.as_str()) && safe_json(v)
        }),
        _ => true,
    }
}
fn seal(cipher: &Aes256Gcm, key: &[u8], bytes: &[u8]) -> Result<Vec<u8>> {
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let encrypted = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: bytes,
                aad: key,
            },
        )
        .map_err(|_| anyhow::anyhow!("Encryption failed"))?;
    Ok([nonce.as_slice(), encrypted.as_slice()].concat())
}
fn unseal(cipher: &Aes256Gcm, key: &[u8], bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() < 28 {
        bail!("Invalid encrypted metadata");
    }
    cipher
        .decrypt(
            Nonce::from_slice(&bytes[..12]),
            Payload {
                msg: &bytes[12..],
                aad: key,
            },
        )
        .map_err(|_| anyhow::anyhow!("Cannot decrypt metadata"))
}
impl Engine {
    pub async fn open(config: Config, initialize: bool, recover: Option<&str>) -> Result<Self> {
        config.validate()?;
        let key =
            hex::decode(std::str::from_utf8(&private_file(&config.encryption_key_file)?)?.trim())?;
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| anyhow::anyhow!("Expected a 32-byte encryption key"))?;
        let mut builder = AmazonS3Builder::from_env()
            .with_endpoint(&config.s3.endpoint)
            .with_region(&config.s3.region)
            .with_bucket_name(&config.s3.bucket)
            .with_virtual_hosted_style_request(false)
            .with_allow_http(config.insecure_loopback || config.s3.allow_loopback_http);
        match (&config.s3.access_key_id, &config.s3.secret_access_key) {
            (Some(id), Some(secret)) => {
                builder = builder
                    .with_access_key_id(id)
                    .with_secret_access_key(secret);
            }
            (None, None) => {}
            _ => bail!("Configure object credentials together"),
        }
        let store: Arc<dyn ObjectStore> = Arc::new(builder.build()?);
        let path = Path::from(format!("{}/control/installation.json", config.s3.prefix));
        let expected = Installation {
            format: 1,
            authority_id: config.authority_id.clone(),
            installation_id: config.installation_id.clone(),
            environment: config.environment.clone(),
            encryption_key_id: config.encryption_key_id.clone(),
            key_check: STANDARD.encode(seal(
                &cipher,
                path.as_ref().as_bytes(),
                b"workspace-meta-v1",
            )?),
        };
        match store.get(&path).await {
            Ok(object) => {
                let got: Installation = serde_json::from_slice(&object.bytes().await?)?;
                if got.format != expected.format
                    || got.authority_id != expected.authority_id
                    || got.installation_id != expected.installation_id
                    || got.environment != expected.environment
                    || got.encryption_key_id != expected.encryption_key_id
                    || unseal(
                        &cipher,
                        path.as_ref().as_bytes(),
                        &STANDARD.decode(got.key_check)?,
                    )? != b"workspace-meta-v1"
                {
                    bail!("Installation mismatch");
                }
            }
            Err(slatedb::object_store::Error::NotFound { .. }) if initialize => {
                use futures::TryStreamExt;
                if store
                    .list(Some(&Path::from(config.s3.prefix.clone())))
                    .try_next()
                    .await?
                    .is_some()
                {
                    bail!("Cannot initialize a nonempty storage root");
                }
                store
                    .put_opts(
                        &path,
                        serde_json::to_vec(&expected)?.into(),
                        PutOptions {
                            mode: PutMode::Create,
                            ..Default::default()
                        },
                    )
                    .await?;
            }
            Err(_) => {
                bail!("Metadata unavailable or uninitialized; explicit initialization required")
            }
        }
        let owner = Owner {
            id: Uuid::new_v4().to_string(),
            installation_id: config.installation_id.clone(),
            released: false,
        };
        let path = Path::from(format!("{}/control/owner.json", config.s3.prefix));
        let mode = match store.get(&path).await {
            Ok(object) => {
                let version = UpdateVersion {
                    e_tag: object.meta.e_tag.clone(),
                    version: object.meta.version.clone(),
                };
                if version.e_tag.is_none() {
                    bail!("Conditional ownership is unsupported");
                }
                let previous: Owner = serde_json::from_slice(&object.bytes().await?)?;
                if previous.installation_id != owner.installation_id
                    || (!previous.released && recover != Some(previous.id.as_str()))
                {
                    bail!("Owner active/uncertain: stop it before explicit recovery");
                }
                PutMode::Update(version)
            }
            Err(slatedb::object_store::Error::NotFound { .. }) => PutMode::Create,
            Err(_) => bail!("Ownership unavailable"),
        };
        store
            .put_opts(
                &path,
                serde_json::to_vec(&owner)?.into(),
                PutOptions {
                    mode,
                    ..Default::default()
                },
            )
            .await?;
        let db = Db::builder(format!("{}/slatedb", config.s3.prefix), store.clone())
            .build()
            .await?;
        Ok(Self {
            config,
            db,
            store,
            cipher,
            owner,
            healthy: AtomicBool::new(true),
            closed: AtomicBool::new(false),
            lifecycle: RwLock::new(()),
        })
    }
    pub async fn barrier(&self) -> Outcome<()> {
        if !self.healthy.load(Ordering::Acquire) {
            return Err(Failure(503, "META_COMMIT_UNKNOWN"));
        }
        if self.closed.load(Ordering::Acquire) {
            return Err(Failure(503, "META_UNAVAILABLE"));
        }
        let path = Path::from(format!("{}/control/owner.json", self.config.s3.prefix));
        let owner: Owner = serde_json::from_slice(
            &self
                .store
                .get(&path)
                .await
                .map_err(unavailable)?
                .bytes()
                .await
                .map_err(unavailable)?,
        )
        .map_err(corrupt)?;
        if owner.id != self.owner.id
            || owner.released
            || owner.installation_id != self.owner.installation_id
        {
            return Err(Failure(503, "META_OWNER_FENCED"));
        }
        if self.db.status().close_reason.is_some() {
            return Err(Failure(503, "META_UNAVAILABLE"));
        }
        Ok(())
    }
    fn prefix(&self, scope: &Scope) -> Outcome<String> {
        if scope.authority_id != self.config.authority_id {
            return Err(Failure(403, "META_AUTHORITY_MISMATCH"));
        }
        if !["system", "organization", "workspace"].contains(&scope.owner_kind.as_str())
            || [&scope.owner_id, &scope.family, &scope.partition_id]
                .iter()
                .any(|v| !valid_id(v))
        {
            return Err(Failure(400, "META_INVALID_SCOPE"));
        }
        Ok(format!(
            "groups/{}/",
            hex::encode(Sha256::digest(serde_json::to_vec(scope).map_err(corrupt)?))
        ))
    }
    async fn get(&self, transaction: &DbTransaction, key: &str) -> Outcome<Option<Value>> {
        transaction
            .get_with_options(
                key,
                &ReadOptions {
                    durability_filter: DurabilityLevel::Remote,
                    ..Default::default()
                },
            )
            .await
            .map_err(unavailable)?
            .map(|b| {
                let aad = format!("{}:{key}", self.config.installation_id);
                serde_json::from_slice(&unseal(&self.cipher, aad.as_bytes(), &b).map_err(corrupt)?)
                    .map_err(corrupt)
            })
            .transpose()
    }
    fn put(&self, transaction: &DbTransaction, key: &str, value: &Value) -> Outcome<()> {
        let aad = format!("{}:{key}", self.config.installation_id);
        transaction
            .put(
                key,
                seal(
                    &self.cipher,
                    aad.as_bytes(),
                    &serde_json::to_vec(value).map_err(corrupt)?,
                )
                .map_err(corrupt)?,
            )
            .map_err(unavailable)?;
        Ok(())
    }
    async fn snapshot(&self, transaction: &DbTransaction, prefix: &str) -> Outcome<Value> {
        let revision = self.get(transaction, &format!("{prefix}revision")).await?;
        let data = format!("{prefix}data/");
        let mut iter = transaction
            .scan_prefix_with_options(
                data.as_bytes(),
                ..,
                &ScanOptions {
                    durability_filter: DurabilityLevel::Remote,
                    ..Default::default()
                },
            )
            .await
            .map_err(unavailable)?;
        let mut records = BTreeMap::new();
        let mut size = 0;
        while let Some(kv) = iter.next().await.map_err(unavailable)? {
            let key = std::str::from_utf8(&kv.key).map_err(corrupt)?;
            let name = key
                .strip_prefix(&data)
                .ok_or(Failure(503, "META_CORRUPT"))?;
            let name =
                String::from_utf8(STANDARD.decode(name).map_err(corrupt)?).map_err(corrupt)?;
            let aad = format!("{}:{key}", self.config.installation_id);
            let clear = unseal(&self.cipher, aad.as_bytes(), &kv.value).map_err(corrupt)?;
            size += clear.len();
            if size > 18 * 1024 * 1024 || records.len() >= 512 {
                return Err(Failure(413, "META_LIMIT_EXCEEDED"));
            }
            records.insert(
                name,
                serde_json::from_slice::<Value>(&clear).map_err(corrupt)?,
            );
        }
        if revision.is_none() && !records.is_empty() {
            return Err(Failure(503, "META_CORRUPT"));
        }
        Ok(json!({"revision":revision,"records":records}))
    }
    async fn transaction(
        &self,
        scope: &Scope,
        gateway: Option<&Gateway>,
    ) -> Outcome<DbTransaction> {
        self.prefix(scope)?;
        if let Some(gateway) = gateway {
            self.prefix(&gateway.scope)?;
        }
        self.barrier().await?;
        let transaction = self
            .db
            .begin(IsolationLevel::SerializableSnapshot)
            .await
            .map_err(unavailable)?;
        // Pin MVCC first, then wait for that exact sequence to become object-durable.
        // A moving Remote filter alone could otherwise mix old revisions with newly durable records.
        let mut status = self.db.subscribe();
        let sequence = transaction.seqnum();
        let closed = tokio::time::timeout(
            Duration::from_secs(30),
            status.wait_for(|s| s.durable_seq >= sequence || s.close_reason.is_some()),
        )
        .await
        .map_err(unavailable)?
        .map_err(unavailable)?
        .close_reason
        .is_some();
        if closed || !self.healthy.load(Ordering::Acquire) {
            return Err(Failure(503, "META_UNAVAILABLE"));
        }
        if let Some(gateway) = gateway {
            if gateway.scope.family != "legacy-gateway"
                || gateway.scope.owner_kind != "system"
                || gateway.scope.owner_id != "compatibility"
                || gateway.scope.partition_id != scope.owner_id
            {
                return Err(Failure(403, "META_INVALID_GATEWAY"));
            }
            let path = format!(
                "{}data/{}",
                self.prefix(&gateway.scope)?,
                STANDARD.encode("ownerId")
            );
            if self.get(&transaction, &path).await? != Some(json!(gateway.owner_id)) {
                return Err(Failure(503, "META_GATEWAY_FENCED"));
            }
        }
        if scope.family == "legacy-document" && gateway.is_none() {
            let gate_scope = Scope {
                authority_id: scope.authority_id.clone(),
                owner_kind: "system".into(),
                owner_id: "compatibility".into(),
                family: "legacy-gateway".into(),
                partition_id: scope.owner_id.clone(),
            };
            let path = format!(
                "{}data/{}",
                self.prefix(&gate_scope)?,
                STANDARD.encode("ownerId")
            );
            if self
                .get(&transaction, &path)
                .await?
                .is_some_and(|v| v.as_str().is_some())
            {
                return Err(Failure(503, "META_GATEWAY_REQUIRED"));
            }
        }
        Ok(transaction)
    }
    async fn replay(
        &self,
        scope: &Scope,
        gateway: Option<&Gateway>,
        receipt_key: &str,
        fingerprint: &str,
    ) -> Outcome<Option<Value>> {
        let transaction = self.transaction(scope, gateway).await?;
        match self.get(&transaction, receipt_key).await? {
            Some(receipt) if receipt["fingerprint"] != fingerprint => {
                Err(Failure(409, "META_MUTATION_MISMATCH"))
            }
            Some(receipt) => Ok(Some(
                json!({"revision":receipt["revision"],"replayed":true}),
            )),
            None => Ok(None),
        }
    }
    pub async fn execute(&self, request: Request) -> Outcome<Value> {
        let _serving = self.lifecycle.read().await;
        let (scope, gateway) = match &request {
            Request::Snapshot { scope, gateway }
            | Request::Commit { scope, gateway, .. }
            | Request::Resolve { scope, gateway, .. } => (scope, gateway.as_ref()),
        };
        let transaction = self.transaction(scope, gateway).await?;
        let result = match request {
            Request::Snapshot { scope, .. } => {
                self.snapshot(&transaction, &self.prefix(&scope)?).await
            }
            Request::Resolve {
                scope, mutation_id, ..
            } => {
                if !valid_id(&mutation_id) {
                    return Err(Failure(400, "META_INVALID_MUTATION"));
                }
                let prefix = self.prefix(&scope)?;
                Ok(
                    match self
                        .get(&transaction, &format!("{prefix}receipts/{mutation_id}"))
                        .await?
                    {
                        Some(v) => json!({"outcome":"committed","revision":v["revision"]}),
                        None => json!({"outcome":"unknown"}),
                    },
                )
            }
            Request::Commit {
                scope,
                expected_revision,
                mutation_id,
                changes,
                gateway,
            } => {
                let prefix = self.prefix(&scope)?;
                if !valid_id(&mutation_id) {
                    return Err(Failure(400, "META_INVALID_MUTATION"));
                }
                let legacy = scope.family == "legacy-document";
                if changes.is_empty()
                    || changes.len() > if legacy { 260 } else { 100 }
                    || serde_json::to_vec(&changes).map_err(corrupt)?.len()
                        > if legacy {
                            18 * 1024 * 1024
                        } else {
                            1024 * 1024
                        }
                {
                    return Err(Failure(413, "META_LIMIT_EXCEEDED"));
                }
                let mut ordered = BTreeMap::new();
                for change in &changes {
                    let obj = change
                        .as_object()
                        .ok_or(Failure(400, "META_INVALID_CHANGE"))?;
                    let key = obj
                        .get("key")
                        .and_then(Value::as_str)
                        .ok_or(Failure(400, "META_INVALID_CHANGE"))?;
                    if key.is_empty()
                        || key.len() > 512
                        || obj.len() != 2
                        || !(obj.contains_key("value")
                            || obj.get("delete") == Some(&Value::Bool(true)))
                        || obj.get("value").is_some_and(|v| {
                            !safe_json(v)
                                || serde_json::to_vec(v).map_or(true, |b| b.len() > 256 * 1024)
                        })
                        || ordered.insert(key.to_owned(), change.clone()).is_some()
                    {
                        return Err(Failure(400, "META_INVALID_CHANGE"));
                    }
                }
                let fingerprint = hex::encode(Sha256::digest(
                    serde_json::to_vec(
                        &json!({"scope":scope,"expected":expected_revision,"changes":ordered}),
                    )
                    .map_err(corrupt)?,
                ));
                let receipt_key = format!("{prefix}receipts/{mutation_id}");
                if let Some(receipt) = self.get(&transaction, &receipt_key).await? {
                    if receipt["fingerprint"] != fingerprint {
                        return Err(Failure(409, "META_MUTATION_MISMATCH"));
                    }
                    self.barrier().await?;
                    return Ok(json!({"revision":receipt["revision"],"replayed":true}));
                }
                if self.get(&transaction, &format!("{prefix}revision")).await?
                    != expected_revision.map(Value::String)
                {
                    return Err(Failure(409, "META_CONFLICT"));
                }
                let snapshot = self.snapshot(&transaction, &prefix).await?;
                let mut projected = snapshot["records"]
                    .as_object()
                    .ok_or(Failure(503, "META_CORRUPT"))?
                    .clone();
                for (key, change) in &ordered {
                    if let Some(value) = change.get("value") {
                        projected.insert(key.clone(), value.clone());
                    } else {
                        projected.remove(key);
                    }
                }
                if projected.len() > 512
                    || serde_json::to_vec(&projected).map_err(corrupt)?.len() > 18 * 1024 * 1024
                {
                    return Err(Failure(413, "META_LIMIT_EXCEEDED"));
                }
                let revision = Uuid::new_v4().to_string();
                for (key, change) in ordered {
                    let path = format!("{prefix}data/{}", STANDARD.encode(key));
                    if let Some(value) = change.get("value") {
                        self.put(&transaction, &path, value)?;
                    } else {
                        transaction.delete(&path).map_err(unavailable)?;
                    }
                }
                self.put(&transaction, &format!("{prefix}revision"), &json!(revision))?;
                self.put(
                    &transaction,
                    &receipt_key,
                    &json!({"revision":revision,"fingerprint":fingerprint}),
                )?;
                let handle = match transaction.commit().await {
                    Ok(Some(handle)) => handle,
                    Err(error) if error.kind() == ErrorKind::Transaction => {
                        // Resolve only the durable receipt after an OCC collision. Never rerun changes or effects.
                        let result = self
                            .replay(&scope, gateway.as_ref(), &receipt_key, &fingerprint)
                            .await?
                            .ok_or(Failure(409, "META_CONFLICT"));
                        self.barrier().await?;
                        return result;
                    }
                    _ => {
                        self.healthy.store(false, Ordering::Release);
                        return Err(Failure(503, "META_COMMIT_UNKNOWN"));
                    }
                };
                if handle.await_durable().await.is_err() {
                    self.healthy.store(false, Ordering::Release);
                    return Err(Failure(503, "META_COMMIT_UNKNOWN"));
                }
                Ok(json!({"revision":revision,"replayed":false}))
            }
        };
        self.barrier().await?;
        result
    }
    pub async fn check_health(&self) -> Outcome<Value> {
        let _serving = self.lifecycle.read().await;
        self.barrier().await?;
        Ok(self.health())
    }
    pub fn health(&self) -> Value {
        json!({"authorityId":self.config.authority_id,"installationId":self.config.installation_id,"engine":"slatedb","engineVersion":"0.17.0","ownerId":self.owner.id,"capabilities":["legacyGatewayFencing"]})
    }
    pub async fn close(&self) -> Result<()> {
        let _drained = self.lifecycle.write().await;
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        self.db.close().await?;
        let path = Path::from(format!("{}/control/owner.json", self.config.s3.prefix));
        let object = self.store.get(&path).await?;
        let version = UpdateVersion {
            e_tag: object.meta.e_tag.clone(),
            version: object.meta.version.clone(),
        };
        let owner: Owner = serde_json::from_slice(&object.bytes().await?)?;
        if owner.id == self.owner.id {
            self.store
                .put_opts(
                    &path,
                    serde_json::to_vec(&Owner {
                        released: true,
                        ..self.owner.clone()
                    })?
                    .into(),
                    PutOptions {
                        mode: PutMode::Update(version),
                        ..Default::default()
                    },
                )
                .await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ciphertext_is_bound_to_record_identity_and_detects_corruption() {
        let cipher = Aes256Gcm::new_from_slice(&[7; 32]).unwrap();
        let bytes = seal(&cipher, b"installation-a:record-a", b"private credential").unwrap();
        assert_eq!(
            unseal(&cipher, b"installation-a:record-a", &bytes).unwrap(),
            b"private credential"
        );
        assert!(unseal(&cipher, b"installation-b:record-a", &bytes).is_err());
        assert!(unseal(&cipher, b"installation-a:record-b", &bytes).is_err());
        let mut changed = bytes;
        changed[13] ^= 1;
        assert!(unseal(&cipher, b"installation-a:record-a", &changed).is_err());
    }
    #[test]
    fn record_values_reject_unsafe_integers_and_prototype_fields() {
        assert!(!safe_json(&json!({"count":9_007_199_254_740_992_u64})));
        assert!(!safe_json(&json!({"nested":{"__proto__":{}}})));
        assert!(safe_json(
            &json!({"count":"9007199254740992","fraction":0.5,"empty":null})
        ));
    }
}
