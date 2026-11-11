use crate::cache::database_builder;
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
    lifecycle: RwLock<CloseProgress>,
}
#[derive(Clone, Copy)]
enum CloseProgress {
    Serving,
    ClosingDatabase,
    ReleasingOwnership,
    Released,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Owner {
    id: String,
    installation_id: String,
    released: bool,
}
pub use workspace_contracts::{MetaRequest as Request, Scope, WriterGuard};
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
fn record_key(key: &str, prefix: bool) -> bool {
    (prefix || !key.is_empty())
        && key.len() <= 512
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_-.:".contains(&b))
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
            format: 2,
            authority_id: config.authority_id.clone(),
            installation_id: config.installation_id.clone(),
            environment: config.environment.clone(),
            encryption_key_id: config.encryption_key_id.clone(),
            key_check: STANDARD.encode(seal(
                &cipher,
                path.as_ref().as_bytes(),
                b"workspace-meta-records-v2",
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
                    )? != b"workspace-meta-records-v2"
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
                    return Err(anyhow::Error::new(workspace_contracts::ServiceError::new(
                        409,
                        "META_OWNER_ACTIVE_OR_UNCERTAIN",
                    ))
                    .context("Owner active/uncertain: stop it before explicit recovery"));
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
        let mut builder = database_builder(
            format!("{}/slatedb", config.s3.prefix),
            store.clone(),
            config.block_cache_mib.unwrap_or(0),
        );
        // An HTTP object store is validated to be loopback-only. Isolated test
        // stores can flush smaller WAL batches without paying hosted PUT costs.
        if config.environment == "test" && config.s3.endpoint.starts_with("http://") {
            builder = builder.with_settings(slatedb::config::Settings {
                flush_interval: Some(Duration::from_millis(10)),
                ..Default::default()
            });
        }
        let db = builder.build().await?;
        Ok(Self {
            config,
            db,
            store,
            cipher,
            owner,
            healthy: AtomicBool::new(true),
            closed: AtomicBool::new(false),
            lifecycle: RwLock::new(CloseProgress::Serving),
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
            "records/v2/{}/",
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
    async fn transaction(&self, scope: &Scope) -> Outcome<DbTransaction> {
        self.prefix(scope)?;
        self.barrier().await?;
        let transaction = self
            .db
            .begin(IsolationLevel::SerializableSnapshot)
            .map_err(unavailable)?;
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
        Ok(transaction)
    }

    /// Read related workspace scopes at one durable snapshot, with the same owner barrier
    /// and per-scope writer checks as separate reads. No snapshot survives this call.
    pub async fn read_workspace_scopes(
        &self,
        reads: Vec<workspace_contracts::MetaRead>,
    ) -> Outcome<Value> {
        workspace_contracts::validate_meta_reads(&reads)
            .map_err(|_| Failure(400, "META_INVALID_REQUEST"))?;
        let _serving = self.lifecycle.read().await;
        let prefixes = reads
            .iter()
            .map(|read| {
                if read.keys.iter().any(|key| !record_key(key, false)) {
                    return Err(Failure(400, "META_INVALID_REQUEST"));
                }
                self.prefix(&read.scope)
            })
            .collect::<Outcome<Vec<_>>>()?;
        let tx = self.transaction(&reads[0].scope).await?;
        let mut results = Vec::with_capacity(reads.len());
        let mut bytes = 0;
        for (read, prefix) in reads.into_iter().zip(prefixes) {
            self.guard(
                &tx,
                &prefix,
                read.guard.as_ref(),
                read.keys.iter().all(|key| key == "system/writer"),
            )
            .await?;
            let mut records = serde_json::Map::new();
            for key in read.keys {
                let value = self
                    .get(&tx, &Self::record_path(&prefix, &key))
                    .await?
                    .unwrap_or(Value::Null);
                bytes += serde_json::to_vec(&value).map_err(corrupt)?.len();
                if bytes > 18 * 1024 * 1024 {
                    return Err(Failure(413, "META_LIMIT_EXCEEDED"));
                }
                records.insert(key, value);
            }
            results.push(json!({"records": records}));
        }
        self.barrier().await?;
        Ok(json!({"results": results}))
    }
    fn record_path(prefix: &str, key: &str) -> String {
        format!("{prefix}data/{}", hex::encode(key))
    }
    async fn guard(
        &self,
        transaction: &DbTransaction,
        prefix: &str,
        guard: Option<&WriterGuard>,
        management: bool,
    ) -> Outcome<()> {
        let owner = self
            .get(transaction, &Self::record_path(prefix, "system/writer"))
            .await?;
        let active = owner.as_ref().and_then(|r| r["value"]["ownerId"].as_str());
        if let Some(guard) = guard {
            if active != Some(guard.owner_id.as_str()) {
                return Err(Failure(503, "META_WRITER_FENCED"));
            }
        } else if active.is_some() && !management {
            return Err(Failure(503, "META_WRITER_REQUIRED"));
        }
        Ok(())
    }
    async fn receipt(
        &self,
        scope: &Scope,
        guard: Option<&WriterGuard>,
        receipt_key: &str,
        fingerprint: &str,
        management: bool,
    ) -> Outcome<Option<Value>> {
        let tx = self.transaction(scope).await?;
        self.guard(&tx, &self.prefix(scope)?, guard, management)
            .await?;
        match self.get(&tx, receipt_key).await? {
            Some(v) if v["fingerprint"] != fingerprint => {
                Err(Failure(409, "META_MUTATION_MISMATCH"))
            }
            Some(v) => Ok(Some(json!({"version":v["version"],"replayed":true}))),
            None => Ok(None),
        }
    }
    pub async fn execute(&self, request: Request) -> Outcome<Value> {
        let _serving = self.lifecycle.read().await;
        let scope = match &request {
            Request::Get { scope, .. }
            | Request::List { scope, .. }
            | Request::Commit { scope, .. }
            | Request::Resolve { scope, .. } => scope,
        };
        let prefix = self.prefix(scope)?;
        let tx = self.transaction(scope).await?;
        let result = match request {
            Request::Get { keys, guard, .. } => {
                if keys.is_empty() || keys.len() > 512 || keys.iter().any(|k| !record_key(k, false))
                {
                    return Err(Failure(400, "META_INVALID_REQUEST"));
                }
                self.guard(
                    &tx,
                    &prefix,
                    guard.as_ref(),
                    keys.iter().all(|k| k == "system/writer"),
                )
                .await?;
                let mut records = serde_json::Map::new();
                let mut bytes = 0;
                for key in keys {
                    let value = self
                        .get(&tx, &Self::record_path(&prefix, &key))
                        .await?
                        .unwrap_or(Value::Null);
                    bytes += serde_json::to_vec(&value).map_err(corrupt)?.len();
                    if bytes > 18 * 1024 * 1024 {
                        return Err(Failure(413, "META_LIMIT_EXCEEDED"));
                    }
                    records.insert(key, value);
                }
                json!({"records":records})
            }
            Request::List {
                prefix: selected,
                after,
                limit,
                guard,
                ..
            } => {
                if !record_key(&selected, true)
                    || !(1..=512).contains(&limit)
                    || after
                        .as_ref()
                        .is_some_and(|k| !record_key(k, false) || !k.starts_with(&selected))
                {
                    return Err(Failure(400, "META_INVALID_REQUEST"));
                }
                self.guard(&tx, &prefix, guard.as_ref(), false).await?;
                let data = Self::record_path(&prefix, &selected);
                let start = after
                    .as_ref()
                    .map(|k| {
                        std::ops::Bound::Excluded(hex::encode(&k[selected.len()..]).into_bytes())
                    })
                    .unwrap_or(std::ops::Bound::Unbounded);
                let mut iter = tx
                    .scan_prefix_with_options(
                        data.as_bytes(),
                        (start, std::ops::Bound::<Vec<u8>>::Unbounded),
                        &ScanOptions {
                            durability_filter: DurabilityLevel::Remote,
                            ..Default::default()
                        },
                    )
                    .await
                    .map_err(unavailable)?;
                let mut records = Vec::new();
                let mut size = 0;
                let mut cursor: Option<String> = None;
                let mut more = false;
                while let Some(kv) = iter.next().await.map_err(unavailable)? {
                    if records.len() >= limit {
                        more = true;
                        break;
                    }
                    let path = std::str::from_utf8(&kv.key).map_err(corrupt)?;
                    let key = String::from_utf8(
                        hex::decode(
                            path.strip_prefix(&format!("{prefix}data/"))
                                .ok_or(Failure(503, "META_CORRUPT"))?,
                        )
                        .map_err(corrupt)?,
                    )
                    .map_err(corrupt)?;
                    let clear = unseal(
                        &self.cipher,
                        format!("{}:{path}", self.config.installation_id).as_bytes(),
                        &kv.value,
                    )
                    .map_err(corrupt)?;
                    if size + clear.len() > 18 * 1024 * 1024 {
                        more = true;
                        break;
                    }
                    size += clear.len();
                    let value: Value = serde_json::from_slice(&clear).map_err(corrupt)?;
                    records
                        .push(json!({"key":key,"version":value["version"],"value":value["value"]}));
                    cursor = Some(key);
                }
                json!({"records":records,"nextCursor":if more {cursor} else {None}})
            }
            Request::Resolve {
                mutation_id, guard, ..
            } => {
                if !valid_id(&mutation_id) {
                    return Err(Failure(400, "META_INVALID_REQUEST"));
                }
                self.guard(&tx, &prefix, guard.as_ref(), false).await?;
                match self
                    .get(&tx, &format!("{prefix}receipts/{mutation_id}"))
                    .await?
                {
                    Some(r) => json!({"outcome":"committed","version":r["version"]}),
                    None => json!({"outcome":"unknown"}),
                }
            }
            Request::Commit {
                scope,
                mutation_id,
                changes,
                guard,
            } => {
                if !valid_id(&mutation_id)
                    || changes.is_empty()
                    || changes.len() > 4096
                    || serde_json::to_vec(&changes).map_err(corrupt)?.len() > 18 * 1024 * 1024
                {
                    return Err(Failure(400, "META_INVALID_REQUEST"));
                }
                let mut ordered = BTreeMap::new();
                for change in changes {
                    let map = change
                        .as_object()
                        .ok_or(Failure(400, "META_INVALID_REQUEST"))?;
                    let key = change["key"]
                        .as_str()
                        .filter(|k| record_key(k, false))
                        .ok_or(Failure(400, "META_INVALID_REQUEST"))?
                        .to_owned();
                    let expected = map
                        .get("expectedVersion")
                        .ok_or(Failure(400, "META_INVALID_REQUEST"))?;
                    if !(expected.is_null() || expected.as_str().is_some_and(valid_id))
                        || map.keys().any(|k| {
                            !["key", "value", "delete", "expectedVersion"].contains(&k.as_str())
                        })
                        || (map.contains_key("value") == (change["delete"] == true))
                        || map.get("delete").is_some_and(|v| v != true)
                        || !safe_json(&change)
                        || map.get("value").is_some_and(|v| {
                            serde_json::to_vec(v).map_or(true, |b| b.len() > 12 * 1024 * 1024)
                        })
                        || ordered.insert(key, change).is_some()
                    {
                        return Err(Failure(400, "META_INVALID_REQUEST"));
                    }
                }
                let management = ordered.keys().all(|k| k == "system/writer");
                self.guard(&tx, &prefix, guard.as_ref(), management).await?;
                let fingerprint = hex::encode(Sha256::digest(
                    serde_json::to_vec(&ordered).map_err(corrupt)?,
                ));
                let receipt_key = format!("{prefix}receipts/{mutation_id}");
                if let Some(receipt) = self.get(&tx, &receipt_key).await? {
                    if receipt["fingerprint"] != fingerprint {
                        return Err(Failure(409, "META_MUTATION_MISMATCH"));
                    }
                    self.barrier().await?;
                    return Ok(json!({"version":receipt["version"],"replayed":true}));
                }
                let version = Uuid::new_v4().to_string();
                for (key, change) in ordered {
                    let path = Self::record_path(&prefix, &key);
                    let current = self.get(&tx, &path).await?;
                    let actual = current
                        .as_ref()
                        .map(|r| r["version"].clone())
                        .unwrap_or(Value::Null);
                    if actual != change["expectedVersion"] {
                        return Err(Failure(409, "META_CONFLICT"));
                    }
                    if let Some(value) = change.get("value") {
                        self.put(&tx, &path, &json!({"version":version,"value":value}))?;
                    } else {
                        tx.delete(&path).map_err(unavailable)?;
                    }
                }
                self.put(
                    &tx,
                    &receipt_key,
                    &json!({"version":version,"fingerprint":fingerprint}),
                )?;
                let handle = match tx.commit().await {
                    Ok(Some(handle)) => handle,
                    Err(e) if e.kind() == ErrorKind::Transaction => {
                        let result = self
                            .receipt(
                                &scope,
                                guard.as_ref(),
                                &receipt_key,
                                &fingerprint,
                                management,
                            )
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
                json!({"version":version,"replayed":false})
            }
        };
        self.barrier().await?;
        Ok(result)
    }
    pub async fn check_health(&self) -> Outcome<Value> {
        let _serving = self.lifecycle.read().await;
        self.barrier().await?;
        Ok(self.health())
    }
    pub fn health(&self) -> Value {
        json!({"authorityId":self.config.authority_id,"installationId":self.config.installation_id,"engine":"slatedb","engineVersion":"0.18.0","ownerId":self.owner.id,"capabilities":["recordsV1","workspaceWriterFencing"]})
    }
    pub async fn close(&self) -> Result<()> {
        let mut progress = self.lifecycle.write().await;
        match *progress {
            CloseProgress::Released => return Ok(()),
            CloseProgress::ClosingDatabase => {
                bail!("Previous SlateDB close was not confirmed; preserve ownership for recovery")
            }
            CloseProgress::Serving => {
                self.closed.store(true, Ordering::Release);
                *progress = CloseProgress::ClosingDatabase;
                self.db.close().await?;
                // SlateDB close is not repeatable. Only the conditional owner release
                // may be retried once the database shutdown returned successfully.
                *progress = CloseProgress::ReleasingOwnership;
            }
            CloseProgress::ReleasingOwnership => {}
        }
        let path = Path::from(format!("{}/control/owner.json", self.config.s3.prefix));
        let object = self.store.get(&path).await?;
        let version = UpdateVersion {
            e_tag: object.meta.e_tag.clone(),
            version: object.meta.version.clone(),
        };
        let owner: Owner = serde_json::from_slice(&object.bytes().await?)?;
        if owner.id == self.owner.id && !owner.released {
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
        *progress = CloseProgress::Released;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ciphertext_is_bound_to_record_identity_and_detects_corruption() {
        // Production loads the key from its private key file; generate a fresh
        // test key so no cryptographic value is hard-coded.
        let key = Aes256Gcm::generate_key(OsRng);
        let cipher = Aes256Gcm::new(&key);
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
