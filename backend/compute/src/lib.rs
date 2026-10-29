mod native;
pub use native::{one_statement, safe_error};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use workspace_contracts::{Result, ServiceError};
fn err(status: u16, code: &str) -> ServiceError {
    ServiceError::new(status, code)
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub extension_path: Option<PathBuf>,
    pub extension_sha256: Option<String>,
}
pub struct Compute {
    pub config: Config,
    pub available: bool,
    pub analysis_slots: tokio::sync::Semaphore,
    pub database_slots: tokio::sync::Semaphore,
    pub active: std::sync::Mutex<std::collections::BTreeSet<String>>,
}
impl Compute {
    pub async fn new(config: Config) -> Self {
        let mut result = Self {
            config,
            available: false,
            analysis_slots: tokio::sync::Semaphore::new(2),
            database_slots: tokio::sync::Semaphore::new(4),
            active: std::sync::Mutex::new(std::collections::BTreeSet::new()),
        };
        if result.verify().is_ok() {
            result.available = result
                .worker(json!({"mode":"probe","extensionPath":result.config.extension_path}))
                .await
                .is_ok();
        }
        result
    }
    pub fn verify(&self) -> Result<()> {
        let path = self
            .config
            .extension_path
            .as_ref()
            .ok_or_else(|| err(503, "DUCKDB_RUNTIME_UNAVAILABLE"))?;
        let metadata =
            std::fs::symlink_metadata(path).map_err(|_| err(503, "DUCKDB_RUNTIME_UNAVAILABLE"))?;
        let bytes = std::fs::read(path).map_err(|_| err(503, "DUCKDB_RUNTIME_UNAVAILABLE"))?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || self.config.extension_sha256.as_ref() != Some(&hex::encode(Sha256::digest(bytes)))
        {
            return Err(err(503, "DUCKDB_RUNTIME_UNAVAILABLE"));
        }
        Ok(())
    }
    pub async fn worker(&self, input: Value) -> Result<Value> {
        let analysis = input["mode"] != "database" && input["mode"] != "probe";
        let failure = if analysis {
            "ANALYSIS_FAILED"
        } else {
            "SQL_EXECUTION_FAILED"
        };

        // Only server-generated import writes get a longer cold-storage commit budget.
        let seconds = if input["mode"] == "database" && input["importWrite"] == true {
            30
        } else {
            15
        };
        tokio::time::timeout(Duration::from_secs(seconds), async {
            let mut child = tokio::process::Command::new(
                std::env::current_exe().map_err(|_| err(503, failure))?,
            )
            .arg("worker")
            .env_clear()
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
                return Err(err(
                    422,
                    if analysis {
                        "ANALYSIS_OUTPUT_LIMIT"
                    } else {
                        "RESULT_TOO_LARGE"
                    },
                ));
            }
            let status = child.wait().await.map_err(|_| err(502, failure))?;
            if !status.success() {
                eprintln!("Compute worker exited before a confirmed reply ({status}).");
                return Err(err(422, failure));
            }
            let v: Value = serde_json::from_slice(&output).map_err(|_| {
                eprintln!(
                    "Compute worker returned invalid JSON ({} bytes).",
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
        .map_err(|_| {
            err(
                504,
                if analysis {
                    "ANALYSIS_TIMEOUT"
                } else {
                    "SQL_TIMEOUT"
                },
            )
        })?
    }
    pub async fn database(
        &self,
        id: &str,
        connection: Value,
        sql: &str,
        sources: Value,
        read_only: bool,
    ) -> Result<Value> {
        self.database_job(id, json!({"mode":"database","connection":connection,"extensionPath":self.config.extension_path,"sql":sql,"sources":sources,"readOnly":read_only})).await
    }
    pub async fn import_statement(&self, id: &str, connection: Value, sql: &str) -> Result<Value> {
        self.database_job(id, json!({"mode":"database","connection":connection,"extensionPath":self.config.extension_path,"sql":sql,"sources":[],"readOnly":false,"importWrite":true})).await
    }
    async fn database_job(&self, id: &str, input: Value) -> Result<Value> {
        self.verify()?;
        let _slot = self
            .database_slots
            .try_acquire()
            .map_err(|_| err(429, "SQL_BUSY"))?;
        {
            let mut active = self.active.lock().expect("active query mutex");
            if !active.insert(id.into()) {
                return Err(err(429, "SQL_BUSY"));
            }
        }
        struct Active<'a>(
            &'a std::sync::Mutex<std::collections::BTreeSet<String>>,
            String,
        );
        impl Drop for Active<'_> {
            fn drop(&mut self) {
                self.0.lock().expect("active query mutex").remove(&self.1);
            }
        }
        let _active = Active(&self.active, id.into());
        let start = std::time::Instant::now();
        let result = self.worker(input).await;
        let mut value = result?;
        value["mode"] = json!("live");
        value["durationMs"] = json!(start.elapsed().as_millis() as u64);
        Ok(value)
    }
}
pub async fn worker_entry() -> Result<()> {
    let mut bytes = vec![];
    tokio::io::stdin()
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| err(400, "INVALID_WORKER_INPUT"))?;
    if bytes.len() > 1024 * 1024 {
        return Err(err(413, "INVALID_WORKER_INPUT"));
    }
    let input: Value =
        serde_json::from_slice(&bytes).map_err(|_| err(400, "INVALID_WORKER_INPUT"))?;
    let result = if input["engine"] == "bash" {
        native::bash(&input).await
    } else {
        native::duckdb(&input)
    };
    let result = result.map_err(|e| {
        if input["mode"] != "database" && input["mode"] != "probe" && e.code.starts_with("SQL_") {
            err(422, "ANALYSIS_FAILED")
        } else {
            e
        }
    });
    let value = match result {
        Ok(value) => json!({"result":value}),
        Err(e) => json!({"error":{"status":e.status,"code":e.code}}),
    };
    let output = serde_json::to_vec(&value).map_err(|_| err(422, "ANALYSIS_FAILED"))?;
    write_worker_reply(&mut tokio::io::stdout(), &output).await
}

async fn write_worker_reply<W: tokio::io::AsyncWrite + Unpin>(
    writer: &mut W,
    output: &[u8],
) -> Result<()> {
    let output = if output.len() > 1024 * 1024 {
        b"{\"error\":{\"status\":422,\"code\":\"ANALYSIS_OUTPUT_LIMIT\"}}".as_slice()
    } else {
        output
    };
    writer
        .write_all(output)
        .await
        .map_err(|_| err(500, "ANALYSIS_FAILED"))?;
    // Tokio stdout writes can still be queued on a blocking thread after write_all returns.
    // Complete the same handle's flush before the disposable process/runtime can exit.
    writer
        .flush()
        .await
        .map_err(|_| err(500, "ANALYSIS_FAILED"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn worker_reply_is_complete_before_buffered_writer_exit() {
        for output in [
            br#"{"result":{"stdout":"alice,1\n","exitCode":0}}"#.to_vec(),
            vec![b'x'; 1024 * 1024 + 1],
        ] {
            let expected = if output.len() > 1024 * 1024 {
                br#"{"error":{"status":422,"code":"ANALYSIS_OUTPUT_LIMIT"}}"#.as_slice()
            } else {
                output.as_slice()
            };
            let (sender, mut receiver) = tokio::io::duplex(1024);
            let mut writer = tokio::io::BufWriter::with_capacity(2048, sender);
            write_worker_reply(&mut writer, &output).await.unwrap();
            // The writer stays alive: visibility must come from the reply's flush, not Drop.
            let mut received = vec![0; expected.len()];
            tokio::time::timeout(Duration::from_secs(1), receiver.read_exact(&mut received))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(received, expected);
            let _: Value = serde_json::from_slice(&received).unwrap();
        }
    }
    #[tokio::test]
    async fn worker_reply_reports_buffered_flush_failure() {
        let (sender, receiver) = tokio::io::duplex(1024);
        drop(receiver);
        let mut writer = tokio::io::BufWriter::with_capacity(2048, sender);
        assert_eq!(
            write_worker_reply(&mut writer, b"{}")
                .await
                .unwrap_err()
                .code,
            "ANALYSIS_FAILED"
        );
    }
}
