//! Authority-local security clock. Meta mode reserves a durable time window in object storage;
//! the legacy file mode uses an independent single-host checkpoint. Neither mode silently
//! recreates missing state. The host clock must be trusted.
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
};
use workspace_contracts::{MetaRequest, Metadata, Result, Scope, ServiceError};
use workspace_meta_client::private_file;
const META_LEASE_SECONDS: i64 = 5;

pub struct FileClock {
    directory: PathBuf,
    _lock: File,
    floor: Mutex<i64>,
}
impl FileClock {
    pub fn open(directory: &Path, initialize: bool) -> anyhow::Result<Self> {
        anyhow::ensure!(
            directory.is_absolute(),
            "Absolute clock checkpoint directory required"
        );
        if initialize {
            fs::create_dir(directory)?;
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        }
        let metadata = fs::symlink_metadata(directory)?;
        anyhow::ensure!(
            metadata.is_dir()
                && !metadata.file_type().is_symlink()
                && metadata.permissions().mode() & 0o077 == 0,
            "Private clock checkpoint directory required"
        );
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(directory.join("owner.lock"))?;
        lock.try_lock()?;
        let path = directory.join("time-floor");
        if initialize {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)?;
            file.write_all(chrono::Utc::now().timestamp().to_string().as_bytes())?;
            file.sync_all()?;
            File::open(directory)?.sync_all()?;
        }
        let floor = String::from_utf8(private_file(&path)?)?.parse::<i64>()?;
        anyhow::ensure!(floor > 0, "Invalid clock checkpoint");
        Ok(Self {
            directory: directory.into(),
            _lock: lock,
            floor: Mutex::new(floor),
        })
    }
    pub fn now(&self) -> Result<i64> {
        let failed = || ServiceError::new(503, "TRUSTED_CLOCK_UNAVAILABLE");
        let now = chrono::Utc::now().timestamp();
        let mut floor = self.floor.lock().map_err(|_| failed())?;
        if now < *floor {
            return Err(ServiceError::new(503, "CLOCK_ROLLBACK"));
        }
        if now > *floor {
            let path = self
                .directory
                .join(format!("time-{}", uuid::Uuid::new_v4()));
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&path)
                .map_err(|_| failed())?;
            file.write_all(now.to_string().as_bytes())
                .map_err(|_| failed())?;
            file.sync_all().map_err(|_| failed())?;
            fs::rename(path, self.directory.join("time-floor")).map_err(|_| failed())?;
            File::open(&self.directory)
                .and_then(|f| f.sync_all())
                .map_err(|_| failed())?;
            *floor = now;
        }
        Ok(now)
    }
}

/// Each authority owns its own durable time floor. The filesystem variant remains available
/// only for explicitly configured older local installations.
pub enum Clock {
    File(FileClock),
    Meta {
        metadata: Arc<dyn Metadata>,
        scope: Scope,
        read_time: fn() -> i64,
        state: tokio::sync::Mutex<(i64, Value)>,
        reserved_until: AtomicI64,
        last_observed: AtomicI64,
    },
}

impl Clock {
    pub fn open(directory: &Path, initialize: bool) -> anyhow::Result<Self> {
        Ok(Self::File(FileClock::open(directory, initialize)?))
    }

    pub async fn open_meta(
        metadata: Arc<dyn Metadata>,
        authority: &str,
        initialize: bool,
    ) -> anyhow::Result<Self> {
        Self::open_meta_with_time(metadata, authority, initialize, None).await
    }

    pub async fn open_meta_with_time(
        metadata: Arc<dyn Metadata>,
        authority: &str,
        initialize: bool,
        time_source: Option<fn() -> i64>,
    ) -> anyhow::Result<Self> {
        let read_time = time_source.unwrap_or(|| chrono::Utc::now().timestamp());
        let scope = Scope::system(
            authority,
            "control-plane",
            "runtime-state",
            "security-clock",
        );
        let read = || MetaRequest::Get {
            scope: scope.clone(),
            guard: None,
            keys: vec!["time-floor".into()],
        };
        let existing = metadata.execute(read()).await?;
        let mut record = existing["records"]["time-floor"].clone();
        if initialize {
            anyhow::ensure!(record.is_null(), "Security clock already initialized");
            let now = read_time();
            anyhow::ensure!(now > 0, "Invalid security clock");
            metadata
                .execute(MetaRequest::Commit {
                    scope: scope.clone(),
                    guard: None,
                    mutation_id: uuid::Uuid::new_v4().to_string(),
                    changes: vec![
                        json!({"key":"time-floor","expectedVersion":null,"value":{"seconds":now}}),
                    ],
                })
                .await?;
            record = metadata.execute(read()).await?["records"]["time-floor"].clone();
        }
        let floor = record["value"]["seconds"]
            .as_i64()
            .filter(|v| *v > 0)
            .ok_or_else(|| anyhow::anyhow!("Security clock missing or invalid"))?;
        let version = record["version"].clone();
        anyhow::ensure!(!version.is_null(), "Security clock version missing");
        let now = read_time();
        anyhow::ensure!(
            floor <= now.saturating_add(META_LEASE_SECONDS),
            "Security clock rollback"
        );
        if floor > now {
            tokio::time::sleep(std::time::Duration::from_secs((floor - now) as u64)).await;
        }
        let now = read_time();
        anyhow::ensure!(now >= floor, "Security clock rollback");
        Ok(Self::Meta {
            metadata,
            scope,
            read_time,
            state: tokio::sync::Mutex::new((floor, version)),
            reserved_until: AtomicI64::new(floor),
            last_observed: AtomicI64::new(now),
        })
    }

    fn observe_with(last: &AtomicI64, mut read_time: impl FnMut() -> i64) -> Result<i64> {
        let mut previous = last.load(Ordering::Acquire);
        loop {
            // Resample after a failed CAS: another request may have observed the next
            // second while this task was paused, without the system clock moving back.
            let now = read_time();
            if now < previous {
                return Err(ServiceError::new(503, "CLOCK_ROLLBACK"));
            }
            match last.compare_exchange_weak(previous, now, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return Ok(now),
                Err(actual) => previous = actual,
            }
        }
    }

    pub fn snapshot(&self) -> Result<i64> {
        match self {
            Self::File(clock) => clock.now(),
            Self::Meta {
                reserved_until,
                read_time,
                last_observed,
                ..
            } => {
                let now = Self::observe_with(last_observed, read_time)?;
                if now > reserved_until.load(Ordering::Acquire) {
                    return Err(ServiceError::new(503, "TRUSTED_CLOCK_UNAVAILABLE"));
                }
                Ok(now)
            }
        }
    }

    pub async fn now(&self) -> Result<i64> {
        match self {
            Self::File(clock) => clock.now(),
            Self::Meta {
                metadata,
                scope,
                state,
                reserved_until,
                read_time,
                last_observed,
            } => {
                // A reservation is usable only after its Meta commit is durable. While it
                // remains valid, the synchronous authorization snapshot and this async path
                // need neither an object-store request nor the renewal mutex.
                let now = Self::observe_with(last_observed, read_time)?;
                if now < reserved_until.load(Ordering::Acquire) {
                    return Ok(now);
                }
                let mut state = state.lock().await;
                for _ in 0..4 {
                    let now = Self::observe_with(last_observed, read_time)?;
                    if now < state.0 {
                        return Ok(now);
                    }
                    let reservation = now
                        .checked_add(META_LEASE_SECONDS)
                        .ok_or_else(|| ServiceError::new(503, "TRUSTED_CLOCK_UNAVAILABLE"))?;
                    match metadata.execute(MetaRequest::Commit { scope: scope.clone(), guard: None, mutation_id: uuid::Uuid::new_v4().to_string(), changes: vec![json!({"key":"time-floor","expectedVersion":state.1,"value":{"seconds":reservation}})] }).await {
                        Ok(result) if !result["version"].is_null() => { *state = (reservation, result["version"].clone()); reserved_until.store(reservation, Ordering::Release); continue; }
                        Err(e) if e.code == "META_CONFLICT" || e.code == "META_COMMIT_UNKNOWN" => {
                            let result = metadata.execute(MetaRequest::Get { scope: scope.clone(), guard: None, keys: vec!["time-floor".into()] }).await?;
                            let record = &result["records"]["time-floor"];
                            let floor = record["value"]["seconds"].as_i64().filter(|v| *v > 0).ok_or_else(|| ServiceError::new(503, "TRUSTED_CLOCK_UNAVAILABLE"))?;
                            if record["version"].is_null() { return Err(ServiceError::new(503, "TRUSTED_CLOCK_UNAVAILABLE")); }
                            if floor > now.saturating_add(META_LEASE_SECONDS) { return Err(ServiceError::new(503, "CLOCK_ROLLBACK")); }
                            *state = (floor, record["version"].clone());
                            reserved_until.store(floor, Ordering::Release);
                        }
                        _ => return Err(ServiceError::new(503, "TRUSTED_CLOCK_UNAVAILABLE")),
                    }
                }
                Err(ServiceError::new(503, "TRUSTED_CLOCK_UNAVAILABLE"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::atomic::AtomicBool;
    use workspace_contracts::Call;

    struct Store {
        records: Mutex<BTreeMap<String, Value>>,
        unavailable: AtomicBool,
    }

    #[test]
    fn concurrent_time_observation_resamples_instead_of_reporting_rollback() {
        let last = AtomicI64::new(100);
        let mut first = true;
        let observed = Clock::observe_with(&last, || {
            if first {
                first = false;
                // Another request records the next second before our CAS.
                last.store(101, Ordering::Release);
                100
            } else {
                101
            }
        });
        assert_eq!(observed.unwrap(), 101);
    }
    impl Metadata for Store {
        fn health(&self) -> Call<'_> {
            Box::pin(async { Ok(json!({})) })
        }
        fn execute(&self, request: MetaRequest) -> Call<'_> {
            Box::pin(async move {
                if self.unavailable.load(Ordering::Acquire) {
                    return Err(ServiceError::new(503, "META_UNAVAILABLE"));
                }
                let mut records = self.records.lock().unwrap();
                match request {
                    MetaRequest::Get { scope, .. } => Ok(
                        json!({"records":{"time-floor":records.get(&scope.authority_id).cloned().unwrap_or(Value::Null)}}),
                    ),
                    MetaRequest::Commit { scope, changes, .. } => {
                        let previous = records
                            .get(&scope.authority_id)
                            .cloned()
                            .unwrap_or(Value::Null);
                        if previous["version"] != changes[0]["expectedVersion"] {
                            return Err(ServiceError::new(409, "META_CONFLICT"));
                        }
                        let version = uuid::Uuid::new_v4().to_string();
                        records.insert(
                            scope.authority_id,
                            json!({"version":version,"value":changes[0]["value"]}),
                        );
                        Ok(json!({"version":version}))
                    }
                    _ => panic!("unexpected clock request"),
                }
            })
        }
    }

    #[tokio::test]
    async fn meta_clock_reserves_time_and_fails_closed_on_loss_or_rollback() {
        let store = Arc::new(Store {
            records: Mutex::new(BTreeMap::new()),
            unavailable: AtomicBool::new(false),
        });
        assert!(
            Clock::open_meta(store.clone(), "global", false)
                .await
                .is_err()
        );
        let clock = Clock::open_meta(store.clone(), "global", true)
            .await
            .unwrap();
        let now = clock.now().await.unwrap();
        let (version, floor) = {
            let records = store.records.lock().unwrap();
            (
                records["global"]["version"].clone(),
                records["global"]["value"]["seconds"].as_i64().unwrap(),
            )
        };
        assert!(floor >= now && floor <= now + META_LEASE_SECONDS);
        assert!(clock.snapshot().unwrap() >= now);
        if let Clock::Meta { state, .. } = &clock {
            let _renewal = state.lock().await;
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(100), clock.now())
                    .await
                    .expect("valid reservation must not wait for the renewal mutex")
                    .is_ok()
            );
        }
        for _ in 0..20 {
            clock.now().await.unwrap();
        }
        assert_eq!(store.records.lock().unwrap()["global"]["version"], version);
        assert!(
            Clock::open_meta(store.clone(), "global", true)
                .await
                .is_err()
        );
        if let Clock::Meta {
            state,
            reserved_until,
            last_observed,
            ..
        } = &clock
        {
            let mut saved = state.lock().await;
            saved.0 = now - 1;
            reserved_until.store(now - 1, Ordering::Release);
            last_observed.store(now, Ordering::Release);
            drop(saved);
            store.unavailable.store(true, Ordering::Release);
            assert_eq!(
                clock.now().await.unwrap_err().code,
                "TRUSTED_CLOCK_UNAVAILABLE"
            );
            assert_eq!(
                clock.snapshot().unwrap_err().code,
                "TRUSTED_CLOCK_UNAVAILABLE"
            );
            store.unavailable.store(false, Ordering::Release);
            last_observed.store(chrono::Utc::now().timestamp() + 10, Ordering::Release);
            assert_eq!(clock.snapshot().unwrap_err().code, "CLOCK_ROLLBACK");
        }
        store.records.lock().unwrap().get_mut("global").unwrap()["value"]["seconds"] =
            json!(chrono::Utc::now().timestamp() + 60);
        assert!(Clock::open_meta(store, "global", false).await.is_err());
    }
    #[test]
    fn checkpoint_survives_restart_locks_one_writer_and_detects_backwards_time() {
        let directory =
            std::env::temp_dir().join(format!("workspace-clock-{}", uuid::Uuid::new_v4()));
        let clock = FileClock::open(&directory, true).unwrap();
        assert!(FileClock::open(&directory, false).is_err());
        assert!(clock.now().unwrap() > 0);
        drop(clock);
        assert!(FileClock::open(&directory, true).is_err());
        let clock = FileClock::open(&directory, false).unwrap();
        assert!(clock.now().unwrap() > 0);
        drop(clock);
        fs::write(
            directory.join("time-floor"),
            (chrono::Utc::now().timestamp() + 1000).to_string(),
        )
        .unwrap();
        let clock = FileClock::open(&directory, false).unwrap();
        assert_eq!(clock.now().unwrap_err().code, "CLOCK_ROLLBACK");
        drop(clock);
        fs::remove_file(directory.join("time-floor")).unwrap();
        assert!(FileClock::open(&directory, false).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
