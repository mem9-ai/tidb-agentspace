//! Same-binary execution is a Region implementation detail, not a deployed service.
use super::err;
use serde_json::Value;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};
use workspace_contracts::Result;

pub(super) async fn execute(input: Value) -> Result<Value> {
    let mut command =
        Command::new(std::env::current_exe().map_err(|_| err(503, "ANALYSIS_FAILED"))?);
    command.arg("execute").env_clear();
    run(command, input, Duration::from_secs(15)).await
}

async fn run(mut command: Command, input: Value, deadline: Duration) -> Result<Value> {
    let failure = "ANALYSIS_FAILED";
    tokio::time::timeout(deadline, async {
        let mut child = command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| err(503, failure))?;
        let bytes = serde_json::to_vec(&input).map_err(|_| err(400, failure))?;
        let mut stdin = child.stdin.take().ok_or_else(|| err(503, failure))?;
        stdin
            .write_all(&bytes)
            .await
            .map_err(|_| err(502, failure))?;
        drop(stdin);
        let mut output = vec![];
        child
            .stdout
            .take()
            .ok_or_else(|| err(503, failure))?
            .take(1024 * 1024 + 1)
            .read_to_end(&mut output)
            .await
            .map_err(|_| err(502, failure))?;
        if output.len() > 1024 * 1024 {
            return Err(err(422, "ANALYSIS_OUTPUT_LIMIT"));
        }
        let status = child.wait().await.map_err(|_| err(502, failure))?;
        if !status.success() {
            eprintln!("Execute child exited before a confirmed reply ({status}).");
            return Err(err(422, failure));
        }
        let v: Value = serde_json::from_slice(&output).map_err(|_| {
            eprintln!(
                "Execute child returned invalid JSON ({} bytes).",
                output.len()
            );
            err(422, failure)
        })?;
        if let Some(code) = v["error"]["code"].as_str() {
            return Err(err(
                v["error"]["status"].as_u64().unwrap_or(422) as u16,
                code,
            ));
        }
        Ok(v["result"].clone())
    })
    .await
    .map_err(|_| err(504, "ANALYSIS_TIMEOUT"))?
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn sleeping_child_fixture() {
        if let Some(path) = std::env::var_os("EXECUTE_TEST_READY_FILE") {
            std::fs::write(path, std::process::id().to_string()).unwrap();
            std::thread::sleep(Duration::from_secs(60));
        }
    }

    fn fixture(ready: &Path) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .arg("--exact")
            .arg("exec::tests::sleeping_child_fixture")
            .arg("--nocapture")
            .env_clear()
            .env("EXECUTE_TEST_READY_FILE", ready);
        command
    }

    async fn pid(ready: &Path) -> String {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(value) = tokio::fs::read_to_string(ready).await
                    && value.parse::<u32>().is_ok()
                {
                    return value;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("execution child did not start")
    }

    async fn stopped(pid: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while Command::new("/bin/kill")
                .args(["-0", pid])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .await
                .unwrap()
                .success()
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("execution child survived cancellation/deadline");
    }

    #[tokio::test]
    async fn deadline_stops_the_child_and_preserves_api_error_classes() {
        for (mode, code) in [
            ("analysis", "ANALYSIS_TIMEOUT"),
            ("import", "ANALYSIS_TIMEOUT"),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let ready = directory.path().join("ready");
            let task = tokio::spawn(run(
                fixture(&ready),
                json!({"mode":mode}),
                Duration::from_secs(2),
            ));
            let child = pid(&ready).await;
            let error = task.await.unwrap().unwrap_err();
            assert_eq!((error.status, error.code.as_str()), (504, code));
            stopped(&child).await;
        }
    }

    #[tokio::test]
    async fn dropping_a_request_stops_its_child_without_waiting_for_the_deadline() {
        let directory = tempfile::tempdir().unwrap();
        let ready = directory.path().join("ready");
        let task = tokio::spawn(run(
            fixture(&ready),
            json!({"mode":"analysis"}),
            Duration::from_secs(30),
        ));
        let child = pid(&ready).await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        stopped(&child).await;
    }
}
