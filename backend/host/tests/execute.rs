use serde_json::{Value, json};
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn execute(mode: &str, input: &[u8]) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_workspace-backend"))
        .arg(mode)
        .env_clear()
        .env("PATH", "/no-external-runtime")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn execute_and_legacy_worker_run_the_same_native_task_without_deployment_or_node() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("snapshot.csv");
    let original = "name,n\nalice,1\n";
    std::fs::write(&source, original).unwrap();
    let input = json!({"mode":"analysis","engine":"bash","sourcePath":source,"workspacePath":"/reports/sales.csv","script":"cat \"$FILE\""});
    let bytes = serde_json::to_vec(&input).unwrap();
    for mode in ["execute", "worker"] {
        let result = execute(mode, &bytes);
        assert_eq!(result["result"]["stdout"], original);
        assert_eq!(result["result"]["exitCode"], 0);
        let mut readonly = input.clone();
        readonly["script"] = json!("printf changed > \"$FILE\"");
        let denied = execute(mode, &serde_json::to_vec(&readonly).unwrap());
        assert_eq!(denied["error"], json!({"status":422,"code":"EROFS"}));
        assert_eq!(std::fs::read_to_string(&source).unwrap(), original);
    }
}

#[test]
fn execute_and_legacy_worker_keep_duckdb_preview_and_error_envelopes() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("snapshot.csv");
    std::fs::write(&source, "name,n\nalice,1\n").unwrap();
    for mode in ["execute", "worker"] {
        let result = execute(
            mode,
            &serde_json::to_vec(&json!({"mode":"preview","sourcePath":source,"format":"csv"}))
                .unwrap(),
        );
        assert_eq!(result["result"]["columns"], json!(["name", "n"]));
        assert_eq!(result["result"]["rows"][0]["name"], "alice");
        assert_eq!(result["result"]["rowCount"], 1);
        let error = execute(mode, &serde_json::to_vec(&json!({"mode":"analysis","sourcePath":source,"format":"csv","script":"SELECT * FROM missing"})).unwrap());
        assert_eq!(
            error["error"],
            json!({"status":422,"code":"ANALYSIS_FAILED"})
        );
    }
}
