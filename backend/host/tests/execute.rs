use serde_json::{Value, json};
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn execute(input: &[u8]) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_workspace-backend"))
        .arg("execute")
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
fn execute_runs_native_tasks_without_deployment_or_node() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("snapshot.csv");
    let original = "name,n\nalice,1\n";
    std::fs::write(&source, original).unwrap();
    let input = json!({"mode":"analysis","engine":"bash","sourcePath":source,"workspacePath":"/reports/sales.csv","script":"cat \"$FILE\""});
    let bytes = serde_json::to_vec(&input).unwrap();
    let result = execute(&bytes);
    assert_eq!(result["result"]["stdout"], original);
    assert_eq!(result["result"]["exitCode"], 0);
    let mut readonly = input.clone();
    readonly["script"] = json!("printf changed > \"$FILE\"");
    let denied = execute(&serde_json::to_vec(&readonly).unwrap());
    assert_eq!(denied["error"], json!({"status":422,"code":"EROFS"}));
    assert_eq!(std::fs::read_to_string(&source).unwrap(), original);
}

#[test]
fn execute_runs_duckdb_preview_and_returns_task_errors() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("snapshot.csv");
    std::fs::write(&source, "name,n\nalice,1\n").unwrap();
    let result = execute(
        &serde_json::to_vec(&json!({"mode":"preview","sourcePath":source,"format":"csv"})).unwrap(),
    );
    assert_eq!(result["result"]["columns"], json!(["name", "n"]));
    assert_eq!(result["result"]["rows"][0]["name"], "alice");
    assert_eq!(result["result"]["rowCount"], 1);
    let error = execute( &serde_json::to_vec(&json!({"mode":"analysis","sourcePath":source,"format":"csv","script":"SELECT * FROM missing"})).unwrap());
    assert_eq!(
        error["error"],
        json!({"status":422,"code":"ANALYSIS_FAILED"})
    );
}

#[test]
fn obsolete_worker_command_is_rejected_before_loading_a_deployment() {
    let output = Command::new(env!("CARGO_BIN_EXE_workspace-backend"))
        .arg("worker")
        .env_clear()
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Use workspace-backend serve"));
}

#[test]
fn malformed_execute_task_uses_the_execute_validation_error() {
    let reply = execute(br#"{"mode":"analysis","format":"csv","script":"SELECT 1"}"#);
    assert_eq!(
        reply["error"],
        json!({"status":400,"code":"INVALID_EXECUTE_INPUT"})
    );
}
