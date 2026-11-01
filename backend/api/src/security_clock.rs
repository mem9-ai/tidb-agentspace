//! A single-host clock checkpoint, independent of regional S3 metadata. The host clock is
//! trusted; checkpoint loss/rollback needs operator recovery, never automatic recreation.
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
};
use workspace_contracts::{Result, ServiceError};
use workspace_meta_client::private_file;

pub struct Clock {
    directory: PathBuf,
    _lock: File,
    floor: Mutex<i64>,
}
impl Clock {
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checkpoint_survives_restart_locks_one_writer_and_detects_backwards_time() {
        let directory =
            std::env::temp_dir().join(format!("workspace-clock-{}", uuid::Uuid::new_v4()));
        let clock = Clock::open(&directory, true).unwrap();
        assert!(Clock::open(&directory, false).is_err());
        assert!(clock.now().unwrap() > 0);
        drop(clock);
        assert!(Clock::open(&directory, true).is_err());
        let clock = Clock::open(&directory, false).unwrap();
        assert!(clock.now().unwrap() > 0);
        drop(clock);
        fs::write(
            directory.join("time-floor"),
            (chrono::Utc::now().timestamp() + 1000).to_string(),
        )
        .unwrap();
        let clock = Clock::open(&directory, false).unwrap();
        assert_eq!(clock.now().unwrap_err().code, "CLOCK_ROLLBACK");
        drop(clock);
        fs::remove_file(directory.join("time-floor")).unwrap();
        assert!(Clock::open(&directory, false).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
