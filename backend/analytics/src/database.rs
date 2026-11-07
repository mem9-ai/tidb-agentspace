//! Single-writer analytics SlateDB. No Meta client, owner clock or takeover protocol.
use crate::config::private_file;
use crate::{
    config::Config,
    storage::{Namespace, Request, Storage},
};
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, AeadCore, OsRng, Payload},
};
use anyhow::{Result, ensure};
use futures::TryStreamExt;
use serde_json::{Value, json};
use slatedb::{
    Db, IsolationLevel,
    config::{DurabilityLevel, ReadOptions, ScanOptions},
    db_cache::foyer::{FoyerCache, FoyerCacheOptions},
    object_store::{
        ObjectStore, ObjectStoreExt, PutMode, PutOptions, aws::AmazonS3Builder, path::Path,
    },
};
use std::{collections::BTreeMap, sync::Arc};
use tokio::sync::Mutex;
use workspace_contracts::ServiceError;

pub(crate) struct Database {
    db: Db,
    cipher: Aes256Gcm,
    installation: String,
    serial: Mutex<()>,
}
fn unavailable(_: impl std::fmt::Display) -> ServiceError {
    ServiceError::new(503, "ANALYTICS_STORAGE_UNAVAILABLE")
}
fn seal(cipher: &Aes256Gcm, path: &str, bytes: &[u8]) -> Result<Vec<u8>> {
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let value = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: bytes,
                aad: path.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("Analytics encryption failed"))?;
    Ok([nonce.as_slice(), &value].concat())
}
fn unseal(cipher: &Aes256Gcm, path: &str, bytes: &[u8]) -> Result<Vec<u8>> {
    ensure!(bytes.len() >= 28, "Invalid analytics ciphertext");
    cipher
        .decrypt(
            Nonce::from_slice(&bytes[..12]),
            Payload {
                msg: &bytes[12..],
                aad: path.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("Analytics ciphertext unavailable"))
}
impl Database {
    pub async fn open(config: &Config, initialize: bool) -> Result<Self> {
        config.validate()?;
        let store: Arc<dyn ObjectStore> = if let Some(local) = &config.local {
            let metadata = std::fs::symlink_metadata(&local.directory)?;
            ensure!(
                metadata.is_dir() && !metadata.file_type().is_symlink(),
                "Analytics directory must be an existing ordinary directory"
            );
            Arc::new(
                slatedb::object_store::local::LocalFileSystem::new_with_prefix(&local.directory)?
                    .with_fsync(true),
            )
        } else {
            let s3 = config
                .s3
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Analytics storage required"))?;
            let mut builder = AmazonS3Builder::from_env()
                .with_endpoint(&s3.endpoint)
                .with_region(&s3.region)
                .with_bucket_name(&s3.bucket)
                .with_virtual_hosted_style_request(false)
                .with_allow_http(config.insecure_loopback || s3.allow_loopback_http);
            if let (Some(id), Some(secret)) = (&s3.access_key_id, &s3.secret_access_key) {
                builder = builder
                    .with_access_key_id(id)
                    .with_secret_access_key(secret);
            }
            Arc::new(builder.build()?)
        };
        let prefix = config.storage_prefix();
        let key =
            hex::decode(String::from_utf8(private_file(&config.encryption_key_file)?)?.trim())?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| {
            anyhow::anyhow!("Expected a dedicated 32-byte analytics encryption key")
        })?;
        let descriptor = Path::from(format!("{prefix}/installation.json"));
        match store.get(&descriptor).await {
            Ok(object) => {
                let value: Value = serde_json::from_slice(&object.bytes().await?)?;
                ensure!(
                    value["format"] == "analytics-v1"
                        && value["authority"] == config.authority_id
                        && value["installation"] == config.installation_id,
                    "Analytics installation mismatch"
                );
                let check = hex::decode(value["keyCheck"].as_str().unwrap_or(""))?;
                ensure!(
                    unseal(&cipher, descriptor.as_ref(), &check)? == b"analytics-v1",
                    "Analytics encryption key mismatch"
                );
            }
            Err(slatedb::object_store::Error::NotFound { .. }) if initialize => {
                ensure!(
                    store
                        .list(Some(&Path::from(prefix)))
                        .try_next()
                        .await?
                        .is_none(),
                    "Never initialize analytics over an existing storage root"
                );
                let value = json!({"format":"analytics-v1","authority":config.authority_id,"installation":config.installation_id,"keyCheck":hex::encode(seal(&cipher, descriptor.as_ref(), b"analytics-v1")?)});
                store
                    .put_opts(
                        &descriptor,
                        serde_json::to_vec(&value)?.into(),
                        PutOptions {
                            mode: PutMode::Create,
                            ..Default::default()
                        },
                    )
                    .await?;
            }
            _ => anyhow::bail!("Analytics storage unavailable or uninitialized"),
        }
        let settings = slatedb::config::Settings {
            flush_interval: Some(std::time::Duration::from_secs(1)),
            object_store_max_retries: Some(2),
            ..Default::default()
        };
        let mut builder = Db::builder(format!("{prefix}/database"), store)
            .with_settings(settings)
            .with_db_cache_disabled();
        if let Some(cache_mib) = config.block_cache_mib.filter(|mib| *mib > 0) {
            // A private pool for all SST entries; enabling Foyer must not select its large defaults.
            builder = builder.with_db_cache(
                Arc::new(FoyerCache::new_with_opts(FoyerCacheOptions {
                    max_capacity: cache_mib * 1024 * 1024,
                    shards: 4,
                })),
                0,
            );
        }
        let db = builder.build().await?;
        Ok(Self {
            db,
            cipher,
            installation: config.installation_id.clone(),
            serial: Mutex::new(()),
        })
    }
    pub async fn close(&self) -> Result<()> {
        let _serial = self.serial.lock().await;
        self.db.close().await?;
        Ok(())
    }
    pub fn available(&self) -> bool {
        self.db.status().close_reason.is_none()
    }
    fn prefix(&self, scope: &Namespace) -> String {
        format!("analytics/v1/{}/", hex::encode(&scope.authority_id))
    }
    fn decode(&self, key: &str, value: &[u8]) -> workspace_contracts::Result<Value> {
        serde_json::from_slice(
            &unseal(&self.cipher, &format!("{}:{key}", self.installation), value)
                .map_err(unavailable)?,
        )
        .map_err(unavailable)
    }
    async fn run(&self, request: Request) -> workspace_contracts::Result<Value> {
        let _serial = self.serial.lock().await;
        if self.db.status().close_reason.is_some() {
            return Err(unavailable("closed"));
        }
        let scope = match &request {
            Request::Get { scope, .. }
            | Request::Commit { scope, .. }
            | Request::List { scope, .. } => scope,
        };
        let prefix = self.prefix(scope);
        let tx = self
            .db
            .begin(IsolationLevel::SerializableSnapshot)
            .map_err(unavailable)?;
        let options = ReadOptions {
            durability_filter: DurabilityLevel::Memory,
            ..Default::default()
        };
        match request {
            Request::Get { keys, .. } => {
                let mut records = BTreeMap::new();
                for key in keys {
                    let path = prefix.clone() + &key;
                    let value = tx
                        .get_with_options(&path, &options)
                        .await
                        .map_err(unavailable)?
                        .map(|v| self.decode(&path, &v))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    records.insert(key, value);
                }
                Ok(json!({"records":records}))
            }
            Request::Commit { changes, .. } => {
                for change in changes {
                    let key = change["key"]
                        .as_str()
                        .ok_or_else(|| unavailable("invalid key"))?;
                    let path = prefix.clone() + key;
                    let current = tx
                        .get_with_options(&path, &options)
                        .await
                        .map_err(unavailable)?
                        .map(|v| self.decode(&path, &v))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    if current["version"] != change["expectedVersion"] {
                        return Err(ServiceError::new(409, "ANALYTICS_CONFLICT"));
                    }
                    if change["delete"] == true {
                        tx.delete(&path).map_err(unavailable)?;
                    } else {
                        let value = json!({"version":uuid::Uuid::new_v4().to_string(),"value":change["value"]});
                        tx.put(
                            &path,
                            seal(
                                &self.cipher,
                                &format!("{}:{path}", self.installation),
                                &serde_json::to_vec(&value).map_err(unavailable)?,
                            )
                            .map_err(unavailable)?,
                        )
                        .map_err(unavailable)?;
                    }
                }
                // Commit locally; the independent SlateDB WAL flushes asynchronously.
                // Neither this acknowledgment nor an API producer queue promises durability.
                tx.commit().await.map_err(unavailable)?;
                Ok(json!({"accepted":true,"durability":"queued"}))
            }
            Request::List {
                prefix: selected,
                after,
                limit,
                ..
            } => {
                let start = after
                    .as_ref()
                    .map(|v| std::ops::Bound::Excluded(v.as_bytes()[selected.len()..].to_vec()))
                    .unwrap_or(std::ops::Bound::Unbounded);
                let mut iter = tx
                    .scan_prefix_with_options(
                        format!("{prefix}{selected}"),
                        (start, std::ops::Bound::<Vec<u8>>::Unbounded),
                        &ScanOptions {
                            durability_filter: DurabilityLevel::Memory,
                            ..Default::default()
                        },
                    )
                    .await
                    .map_err(unavailable)?;
                let mut records = Vec::new();
                let mut cursor = None;
                let mut more = false;
                while let Some(kv) = iter.next().await.map_err(unavailable)? {
                    if records.len() == limit {
                        more = true;
                        break;
                    }
                    let path = std::str::from_utf8(&kv.key).map_err(unavailable)?;
                    let key = path
                        .strip_prefix(&prefix)
                        .ok_or_else(|| unavailable("namespace"))?;
                    let value = self.decode(path, &kv.value)?;
                    cursor = Some(key.to_owned());
                    records
                        .push(json!({"key":key,"version":value["version"],"value":value["value"]}));
                }
                Ok(json!({"records":records,"nextCursor":if more {cursor} else {None}}))
            }
        }
    }
}
impl Storage for Database {
    fn execute(
        &self,
        request: Request,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = workspace_contracts::Result<Value>> + Send + '_>,
    > {
        Box::pin(self.run(request))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope(authority: &str) -> Namespace {
        Namespace {
            authority_id: authority.into(),
        }
    }
    #[tokio::test]
    async fn volume_storage_reopens_with_no_cloud_identity_and_rejects_mismatched_installations() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("data");
        std::fs::create_dir(&data).unwrap();
        let key = directory.path().join("key");
        std::fs::write(&key, hex::encode([7; 32])).unwrap();
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).unwrap();
        let mut config: Config = serde_json::from_value(json!({
            "authorityId": "global", "installationId": "analytics-volume-test",
            "bind": "127.0.0.1:7446", "insecureLoopback": true,
            "local": {"directory": data, "prefix": "analytics/test"},
            "encryptionKeyFile": key,
            "pseudonymKeyFile": directory.path().join("pseudonym"),
            "tokenFile": directory.path().join("token")
        }))
        .unwrap();
        assert_eq!(config.block_cache_mib, None);
        config.block_cache_mib = Some(u64::MAX);
        assert!(config.validate().is_err());
        config.block_cache_mib = Some(1);
        assert!(Database::open(&config, false).await.is_err());
        let database = Database::open(&config, true).await.unwrap();
        database
            .execute(Request::Commit {
                scope: scope("global"),
                changes: vec![
                    json!({"key":"retained","expectedVersion":null,"value":"volume-canary"}),
                ],
            })
            .await
            .unwrap();
        database.close().await.unwrap();
        config.installation_id = "different-installation".into();
        assert!(Database::open(&config, true).await.is_err());
        config.installation_id = "analytics-volume-test".into();
        std::fs::write(&key, hex::encode([8; 32])).unwrap();
        assert!(Database::open(&config, true).await.is_err());
        std::fs::write(&key, hex::encode([7; 32])).unwrap();
        config.block_cache_mib = Some(0);
        let database = Database::open(&config, false).await.unwrap();
        let row = database
            .execute(Request::Get {
                scope: scope("global"),
                keys: vec!["retained".into()],
            })
            .await
            .unwrap();
        assert_eq!(row["records"]["retained"]["value"], "volume-canary");
        database.close().await.unwrap();
        let original = config.local.clone();
        config.local.as_mut().unwrap().directory = "/".into();
        assert!(config.validate().is_err());
        config.local = original;
        config.s3 = Some(serde_json::from_value(json!({"endpoint":"https://storage.example","region":"region","bucket":"bucket","prefix":"analytics/test"})).unwrap());
        assert!(config.validate().is_err());
    }
    #[tokio::test]
    async fn independent_database_encrypts_binds_paths_preserves_atomic_conditions_and_reopens() {
        let objects: Arc<dyn ObjectStore> =
            Arc::new(slatedb::object_store::memory::InMemory::new());
        let db = Db::builder("analytics/test/database", objects.clone())
            .build()
            .await
            .unwrap();
        let database = Database {
            db,
            cipher: Aes256Gcm::new_from_slice(&[9; 32]).unwrap(),
            installation: "independent-test".into(),
            serial: Mutex::new(()),
        };
        let change = |key: &str, version: Value, value: &str| json!({"key":key,"expectedVersion":version,"value":value});
        database
            .execute(Request::Commit {
                scope: scope("region:a"),
                changes: vec![change("first", Value::Null, "private-canary")],
            })
            .await
            .unwrap();
        let row = database
            .execute(Request::Get {
                scope: scope("region:a"),
                keys: vec!["first".into()],
            })
            .await
            .unwrap();
        assert_eq!(row["records"]["first"]["value"], "private-canary");
        let denied = database
            .execute(Request::Commit {
                scope: scope("region:a"),
                changes: vec![
                    change("second", Value::Null, "must-not-commit"),
                    change("first", Value::Null, "wrong-version"),
                ],
            })
            .await
            .unwrap_err();
        assert_eq!(denied.status, 409);
        let original = database
            .execute(Request::Get {
                scope: scope("region:a"),
                keys: vec!["first".into(), "second".into()],
            })
            .await
            .unwrap();
        assert_eq!(original["records"]["first"]["value"], "private-canary");
        assert!(original["records"]["second"].is_null());
        let other = database
            .execute(Request::Get {
                scope: scope("region:b"),
                keys: vec!["first".into()],
            })
            .await
            .unwrap();
        assert!(other["records"]["first"].is_null());
        let first = database.prefix(&scope("region:a")) + "first";
        let ciphertext = database.db.get(&first).await.unwrap().unwrap();
        assert!(
            !ciphertext
                .windows("private-canary".len())
                .any(|s| s == b"private-canary")
        );
        let swapped = database.prefix(&scope("region:b")) + "first";
        database.db.put(&swapped, ciphertext).await.unwrap();
        assert!(
            database
                .execute(Request::Get {
                    scope: scope("region:b"),
                    keys: vec!["first".into()]
                })
                .await
                .is_err()
        );
        database.close().await.unwrap();
        let reopened = Database {
            db: Db::builder("analytics/test/database", objects)
                .build()
                .await
                .unwrap(),
            cipher: Aes256Gcm::new_from_slice(&[9; 32]).unwrap(),
            installation: "independent-test".into(),
            serial: Mutex::new(()),
        };
        assert_eq!(
            reopened
                .execute(Request::Get {
                    scope: scope("region:a"),
                    keys: vec!["first".into()]
                })
                .await
                .unwrap()["records"]["first"]["value"],
            "private-canary"
        );
        reopened.close().await.unwrap();
    }
}
