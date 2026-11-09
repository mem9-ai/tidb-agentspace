//! Acceptance-only entry point for the native host. Production always reads system time.
use anyhow::{Context, Result};
use std::{path::PathBuf, sync::OnceLock};
use workspace_test_support::expiry_clock::ExpiryClock;

static CLOCK: OnceLock<ExpiryClock> = OnceLock::new();

#[tokio::main]
async fn main() -> Result<()> {
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new("serve")) {
        return workspace_backend::run(None).await;
    }
    let plan = PathBuf::from(
        std::env::args_os()
            .nth(3)
            .context("expected serve --config <plan>")?,
    );
    let _ = CLOCK.set(ExpiryClock::in_directory(
        plan.parent().context("fixture directory")?,
    ));
    workspace_backend::run(Some(|| CLOCK.get().unwrap().now() as i64)).await
}
