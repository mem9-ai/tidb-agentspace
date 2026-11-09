//! Wall time shared by the proof signer and both isolated acceptance hosts across restarts.
use anyhow::{Context, Result};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tempfile::NamedTempFile;

pub struct ExpiryClock(PathBuf);

impl ExpiryClock {
    pub fn in_directory(dir: &Path) -> Self {
        Self(dir.join("security-clock-offset"))
    }

    pub fn initialize(&self) -> Result<()> {
        crate::private_write(&self.0, b"0")
    }

    fn wall_seconds() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    pub fn now(&self) -> u64 {
        let offset: u64 = fs::read_to_string(&self.0)
            .expect("read fixture clock")
            .parse()
            .expect("valid fixture clock");
        Self::wall_seconds() + offset
    }

    pub fn advance_past(&self, deadline: u64) -> Result<()> {
        if self.now() <= deadline {
            let mut next = NamedTempFile::new_in(self.0.parent().context("fixture directory")?)?;
            write!(
                next,
                "{}",
                (deadline + 1).saturating_sub(Self::wall_seconds())
            )?;
            next.persist(&self.0)?;
        }
        Ok(())
    }
}
