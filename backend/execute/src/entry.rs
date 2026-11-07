use super::{err, native};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use workspace_contracts::Result;

pub async fn execute_entry() -> Result<()> {
    let mut bytes = vec![];
    tokio::io::stdin()
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| err(400, "INVALID_EXECUTE_INPUT"))?;
    if bytes.len() > 1024 * 1024 {
        return Err(err(413, "INVALID_EXECUTE_INPUT"));
    }
    let input: Value =
        serde_json::from_slice(&bytes).map_err(|_| err(400, "INVALID_EXECUTE_INPUT"))?;
    let result = if input["engine"] == "bash" {
        native::bash(&input).await
    } else {
        native::duckdb(&input)
    };
    let result = result.map_err(|e| {
        if e.code.starts_with("SQL_") {
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
    write_reply(&mut tokio::io::stdout(), &output).await
}

async fn write_reply<W: tokio::io::AsyncWrite + Unpin>(
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
    use std::time::Duration;
    #[tokio::test]
    async fn execute_reply_is_complete_before_buffered_writer_exit() {
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
            write_reply(&mut writer, &output).await.unwrap();
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
    async fn execute_reply_reports_buffered_flush_failure() {
        let (sender, receiver) = tokio::io::duplex(1024);
        drop(receiver);
        let mut writer = tokio::io::BufWriter::with_capacity(2048, sender);
        assert_eq!(
            write_reply(&mut writer, b"{}").await.unwrap_err().code,
            "ANALYSIS_FAILED"
        );
    }
}
