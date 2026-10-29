use super::err;
use duckdb::{Config, Connection, types::Value as DValue};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc, time::Duration};
use workspace_contracts::Result;
pub fn safe_error(e: impl std::fmt::Display) -> workspace_contracts::ServiceError {
    let s = e.to_string();
    if s.contains("already exists") {
        err(409, "SQL_TABLE_EXISTS")
    } else if s.contains("Parser Error") {
        err(422, "SQL_SYNTAX_ERROR")
    } else if [
        "Permission Error",
        "configuration is locked",
        "external access",
        "disabled by configuration",
        "read-only",
        "read only",
    ]
    .iter()
    .any(|p| s.contains(p))
    {
        err(403, "SQL_PERMISSION_DENIED")
    } else if s.contains("Catalog Error") || s.contains("Binder Error") {
        err(422, "SQL_OBJECT_NOT_FOUND")
    } else if s.contains("Constraint Error") || s.contains("TransactionContext Error") {
        err(409, "SQL_CONFLICT")
    } else {
        err(502, "SQL_EXECUTION_FAILED")
    }
}
/// Count statement boundaries before duckdb-rs prepare (which otherwise executes earlier statements).
pub fn one_statement(sql: &str) -> bool {
    let b = sql.as_bytes();
    let (mut i, mut ended, mut seen) = (0, false, false);
    while i < b.len() {
        if b[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if b[i..].starts_with(b"--") {
            i += 2;
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b[i..].starts_with(b"/*") {
            i += 2;
            let mut depth = 1;
            while i < b.len() && depth > 0 {
                if b[i..].starts_with(b"/*") {
                    depth += 1;
                    i += 2;
                } else if b[i..].starts_with(b"*/") {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if depth > 0 {
                return false;
            }
            continue;
        }
        if ended {
            return false;
        }
        if b[i] == b';' {
            ended = true;
            i += 1;
            continue;
        }
        seen = true;
        if b"'\"`".contains(&b[i]) {
            let quote = b[i];
            let escape = quote == b'\''
                && i > 0
                && b"eE".contains(&b[i - 1])
                && (i == 1 || !b[i - 2].is_ascii_alphanumeric());
            i += 1;
            let mut closed = false;
            while i < b.len() {
                if escape && b[i] == b'\\' {
                    i += 2;
                    continue;
                }
                if b[i] == quote {
                    if i + 1 < b.len() && b[i + 1] == quote {
                        i += 2;
                        continue;
                    }
                    closed = true;
                    i += 1;
                    break;
                }
                i += 1;
            }
            if !closed {
                return false;
            }
            continue;
        }
        if b[i] == b'$' {
            let start = i;
            i += 1;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
            if i < b.len() && b[i] == b'$' {
                let delimiter = &b[start..=i];
                i += 1;
                if let Some(end) = b[i..].windows(delimiter.len()).position(|v| v == delimiter) {
                    i += end + delimiter.len();
                } else {
                    return false;
                }
                continue;
            }
            i = start;
        }
        i += 1;
    }
    seen
}
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}
fn setup() -> Result<Connection> {
    let cfg = Config::default()
        .with("threads", "1")
        .and_then(|c| c.with("memory_limit", "128MB"))
        .and_then(|c| c.with("max_temp_directory_size", "0B"))
        .and_then(|c| c.with("autoload_known_extensions", "false"))
        .and_then(|c| c.with("autoinstall_known_extensions", "false"))
        .and_then(|c| c.with("allow_persistent_secrets", "false"))
        .and_then(|c| c.with("allow_unredacted_secrets", "false"))
        .and_then(|c| c.with("allow_unsigned_extensions", "true"))
        .map_err(safe_error)?;
    Connection::open_in_memory_with_flags(cfg).map_err(safe_error)
}
fn run(conn: &Connection, sql: &str) -> Result<()> {
    conn.execute_batch(sql).map_err(safe_error)
}
fn read_prefix(sql: &str) -> bool {
    let clean = regex::Regex::new(r"(?s)^(?:\s|--[^\n]*(?:\n|$)|/\*.*?\*/)*")
        .expect("regex")
        .replace(sql, "");
    regex::Regex::new(r"(?i)^(SELECT|WITH|FROM|VALUES|SHOW|DESCRIBE)\b")
        .expect("regex")
        .is_match(&clean)
}
fn read_statement(conn: &Connection, sql: &str) -> Result<bool> {
    if !read_prefix(sql) {
        return Ok(false);
    }
    let clean = regex::Regex::new(r"(?s)^(?:\s|--[^\n]*(?:\n|$)|/\*.*?\*/)*")
        .expect("regex")
        .replace(sql, "");
    if !clean.to_ascii_uppercase().starts_with("WITH") {
        return Ok(true);
    }
    // DuckDB's own parser distinguishes a CTE SELECT from a CTE mutation before execution.
    let ast: String = conn
        .query_row("SELECT json_serialize_sql(?)", [sql], |r| r.get(0))
        .map_err(safe_error)?;
    let ast: Value = serde_json::from_str(&ast).map_err(|_| err(422, "SQL_SYNTAX_ERROR"))?;
    Ok(ast["error"] == false)
}
fn allowed(sql: &str) -> bool {
    let clean = regex::Regex::new(r"(?s)^(?:\s|--[^\n]*(?:\n|$)|/\*.*?\*/)*")
        .expect("regex")
        .replace(sql, "");
    read_prefix(sql)||regex::Regex::new(r"(?i)^(INSERT|UPDATE|DELETE|MERGE|CHECKPOINT)\b|^CREATE\s+(OR\s+REPLACE\s+)?((TEMP|TEMPORARY)\s+)?(TABLE|VIEW|(UNIQUE\s+)?INDEX)\b|^(ALTER\s+TABLE|DROP\s+(TABLE|VIEW|INDEX))\b").expect("regex").is_match(&clean)
}
fn value(conn: &Connection, v: DValue, depth: usize) -> Result<Value> {
    if depth > 16 {
        return Err(err(422, "RESULT_TOO_LARGE"));
    }
    fn number(n: f64) -> Value {
        if n.is_finite() {
            json!(n)
        } else if n.is_nan() {
            json!("NaN")
        } else if n > 0.0 {
            json!("Infinity")
        } else {
            json!("-Infinity")
        }
    }
    Ok(match v {
        DValue::Null => Value::Null,
        DValue::Boolean(v) => json!(v),
        DValue::TinyInt(v) => json!(v), DValue::SmallInt(v) => json!(v), DValue::Int(v) => json!(v),
        DValue::UTinyInt(v) => json!(v), DValue::USmallInt(v) => json!(v), DValue::UInt(v) => json!(v),
        DValue::BigInt(v) => json!(v.to_string()), DValue::UBigInt(v) => json!(v.to_string()),
        DValue::HugeInt(v) => json!(v.to_string()), DValue::UHugeInt(v) => json!(v.to_string()),
        DValue::Float(v) => number(v as f64), DValue::Double(v) => number(v),
        DValue::Decimal(v) => json!(v.to_string()),
        DValue::Text(v) | DValue::Enum(v) => json!(v),
        DValue::List(v) | DValue::Array(v) => Value::Array(v.into_iter().map(|v|value(conn,v,depth+1)).collect::<Result<Vec<_>>>()?),
        DValue::Struct(v) => Value::Object(v.iter().map(|(k,v)|Ok((k.clone(),value(conn,v.clone(),depth+1)?))).collect::<Result<serde_json::Map<_,_>>>()?),
        DValue::Map(v) => Value::Array(v.iter().map(|(k,v)|Ok(json!({"key":value(conn,k.clone(),depth+1)?,"value":value(conn,v.clone(),depth+1)?}))).collect::<Result<Vec<_>>>()?),
        DValue::Union(v) => value(conn,*v,depth+1)?,
        DValue::Interval {months,days,nanos} => json!({"months":months,"days":days,"micros":(nanos/1000).to_string()}),
        v => json!(conn.query_row("SELECT CAST(? AS VARCHAR)",[v],|row|row.get::<_,String>(0)).map_err(safe_error)?),
    })
}
fn type_name(t: &duckdb::core::LogicalTypeHandle) -> String {
    use duckdb::core::LogicalTypeId as I;
    if let Some(alias) = t.get_alias() {
        return alias;
    }
    match t.id() {
        I::TimestampS => "TIMESTAMP_S".into(),
        I::TimestampMs => "TIMESTAMP_MS".into(),
        I::TimestampNs => "TIMESTAMP_NS".into(),
        I::TimeNs => "TIME_NS".into(),
        I::TimeTZ => "TIME WITH TIME ZONE".into(),
        I::TimestampTZ => "TIMESTAMP WITH TIME ZONE".into(),
        I::List => format!("{}[]", type_name(&t.child(0))),
        I::Map => format!(
            "MAP({}, {})",
            type_name(&t.child(0)),
            type_name(&t.child(1))
        ),
        I::Boolean => "BOOLEAN".into(),
        I::Tinyint => "TINYINT".into(),
        I::Smallint => "SMALLINT".into(),
        I::Integer => "INTEGER".into(),
        I::Bigint => "BIGINT".into(),
        I::UTinyint => "UTINYINT".into(),
        I::USmallint => "USMALLINT".into(),
        I::UInteger => "UINTEGER".into(),
        I::UBigint => "UBIGINT".into(),
        I::Float => "FLOAT".into(),
        I::Double => "DOUBLE".into(),
        I::Varchar => "VARCHAR".into(),
        I::Decimal => format!("DECIMAL({},{})", t.decimal_width(), t.decimal_scale()),
        _ => format!("{:?}", t.id()).to_uppercase(),
    }
}
fn query(conn: &Connection, sql: &str, limit: usize, bytes: usize, extra: bool) -> Result<Value> {
    query_bounded(conn, sql, limit, bytes, extra, false)
}
fn query_bounded(
    conn: &Connection,
    sql: &str,
    limit: usize,
    bytes: usize,
    extra: bool,
    import: bool,
) -> Result<Value> {
    if !one_statement(sql) {
        return Err(err(400, "INVALID_SQL"));
    }
    let mut statement = conn.prepare(sql).map_err(safe_error)?;
    let affected = statement.execute([]).map_err(safe_error)?;
    let mut native = statement.raw_query();
    let mut rows = vec![];
    let mut size = 0;
    let mut names: Vec<String> = vec![];
    let mut types = vec![];
    while let Some(row) = native.next().map_err(safe_error)? {
        if names.is_empty() {
            let stmt = row.as_ref();
            let mut used = std::collections::BTreeSet::new();
            for i in 0..stmt.column_count() {
                let name = stmt.column_name(i).map_err(safe_error)?.clone();
                let mut name2 = name.clone();
                let mut suffix = 2;
                while used.contains(&name2) {
                    name2 = if extra {
                        format!("{name}:{}", suffix - 1)
                    } else {
                        format!("{name}_{suffix}")
                    };
                    suffix += 1;
                }
                used.insert(name2.clone());
                names.push(name2);
                types.push(type_name(&stmt.column_logical_type(i)));
            }
        }
        let mut object = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            object.insert(
                name.clone(),
                value(conn, row.get::<_, DValue>(i).map_err(safe_error)?, 0)?,
            );
        }
        let object = Value::Object(object);
        size += object.to_string().len();
        if size > bytes || rows.len() >= limit {
            return Err(err(
                if import { 413 } else { 422 },
                if import {
                    if rows.len() >= limit {
                        "IMPORT_ROW_LIMIT"
                    } else {
                        "IMPORT_OUTPUT_LIMIT"
                    }
                } else if extra {
                    "ANALYSIS_OUTPUT_LIMIT"
                } else {
                    "RESULT_TOO_LARGE"
                },
            ));
        }
        rows.push(object);
    }
    drop(native);
    if names.is_empty() {
        names = statement.column_names();
        types = (0..names.len())
            .map(|i| type_name(&statement.column_logical_type(i)))
            .collect();
    }
    let mut result =
        json!({"columns":names,"rows":rows,"rowCount":rows.len(),"affectedRows":affected});
    if extra {
        result["columnTypes"] = json!(types);
        result
            .as_object_mut()
            .expect("result")
            .remove("affectedRows");
    }
    Ok(result)
}
pub fn duckdb(input: &Value) -> Result<Value> {
    let conn = setup()?;
    let mode = input["mode"].as_str().unwrap_or("analysis");
    if mode == "probe" {
        run(
            &conn,
            &format!(
                "LOAD {}",
                quote(
                    input["extensionPath"]
                        .as_str()
                        .ok_or_else(|| err(503, "DUCKDB_RUNTIME_UNAVAILABLE"))?
                )
            ),
        )?;
        return Ok(json!({"available":true}));
    }
    if mode == "database" {
        let extension = input["extensionPath"]
            .as_str()
            .ok_or_else(|| err(503, "DUCKDB_RUNTIME_UNAVAILABLE"))?;
        run(&conn, &format!("LOAD {}", quote(extension)))?;
        let c = &input["connection"];
        run(
            &conn,
            &format!(
                "CREATE TEMPORARY SECRET workspace_storage (TYPE tidbfs, ENDPOINT {}, TOKEN {})",
                quote(
                    c["endpoint"]
                        .as_str()
                        .ok_or_else(|| err(503, "PROVIDER_BINDING_MISSING"))?
                ),
                quote(
                    c["apiKey"]
                        .as_str()
                        .ok_or_else(|| err(503, "PROVIDER_BINDING_MISSING"))?
                )
            ),
        )?;
        let read_only =
            input["readOnly"] == true || input["sources"].as_array().is_some_and(|v| !v.is_empty());
        run(
            &conn,
            &format!(
                "ATTACH 'tidbfs+db:///workspace.duckdb' AS workspace{}; USE workspace",
                if read_only { " (READ_ONLY)" } else { "" }
            ),
        )?;
        if let Some(sources) = input["sources"].as_array().filter(|v| !v.is_empty()) {
            run(&conn, "ATTACH ':memory:' AS files")?;
            let source_name = regex::Regex::new(r"^[a-z][a-z0-9_]{0,31}$").expect("regex");
            for source in sources {
                let name = source["name"]
                    .as_str()
                    .ok_or_else(|| err(422, "SOURCE_INVALID"))?;
                if !source_name.is_match(name) {
                    return Err(err(422, "SOURCE_INVALID"));
                }
                let reader = match source["format"].as_str() {
                    Some("csv") => "read_csv",
                    Some("json" | "jsonl" | "ndjson") => "read_json_auto",
                    Some("parquet") => "read_parquet",
                    _ => return Err(err(422, "SOURCE_INVALID")),
                };
                run(
                    &conn,
                    &format!(
                        "CREATE TABLE files.\"{name}\" AS SELECT * FROM {reader}({})",
                        quote(
                            source["path"]
                                .as_str()
                                .ok_or_else(|| err(422, "SOURCE_INVALID"))?
                        )
                    ),
                )?;
            }
        }
        run(
            &conn,
            "SET enable_external_access=false; SET lock_configuration=true",
        )?;
        database_query(
            &conn,
            input["sql"]
                .as_str()
                .ok_or_else(|| err(400, "INVALID_SQL"))?,
            read_only,
        )
    } else {
        let path = input["sourcePath"]
            .as_str()
            .ok_or_else(|| err(400, "INVALID_WORKER_INPUT"))?;
        if mode == "import" && input["parsing"]["format"] == "lines" {
            let bytes = std::fs::read(path).map_err(|_| err(422, "IMPORT_FORMAT"))?;
            let text = std::str::from_utf8(&bytes).map_err(|_| err(422, "IMPORT_FORMAT"))?;
            if bytes
                .iter()
                .any(|b| (*b < 32 && ![9, 10, 13].contains(b)) || *b == 127)
            {
                return Err(err(422, "IMPORT_FORMAT"));
            }
            let rows: Vec<_> = text
                .replace("\r\n", "\n")
                .replace('\r', "\n")
                .split_terminator('\n')
                .map(|s| json!({"line":s}))
                .collect();
            if rows.len() > 1000 {
                return Err(err(413, "IMPORT_ROW_LIMIT"));
            }
            if rows.iter().map(|r| r.to_string().len()).sum::<usize>() > 1024 * 1024 {
                return Err(err(413, "IMPORT_OUTPUT_LIMIT"));
            }
            return Ok(
                json!({"columns":["line"],"columnTypes":["VARCHAR"],"rowCount":rows.len(),"rows":rows}),
            );
        }
        let format = input["format"].as_str().unwrap_or("csv");
        let reader = if mode == "import" {
            if input["parsing"]["format"] == "parquet" {
                format!("read_parquet({})", quote(path))
            } else {
                let d = input["parsing"]["delimiter"].as_str().unwrap_or(",");
                if ![",", "\t", ";", "|"].contains(&d) {
                    return Err(err(400, "INVALID_EXPORT"));
                }
                format!(
                    "read_csv({},header={},delim={},all_varchar=true,strict_mode=true,allow_quoted_nulls=false,quote='\"',escape='\"')",
                    quote(path),
                    input["parsing"]["header"] == true,
                    quote(d)
                )
            }
        } else {
            format!(
                "{}({})",
                if format == "parquet" {
                    "read_parquet"
                } else {
                    "read_csv_auto"
                },
                quote(path)
            )
        };
        let preview = mode == "preview";
        run(
            &conn,
            &format!(
                "CREATE {} \"file\" AS SELECT * FROM {reader}",
                if preview || mode == "import" {
                    "VIEW"
                } else {
                    "TABLE"
                }
            ),
        )?;
        let schema = query(&conn, "DESCRIBE \"file\"", 1000, 1024 * 1024, false)?["rows"].clone();
        let rows_limit = if preview { 21 } else { 1000 };
        let mut total = Value::Null;
        if preview && format == "parquet" {
            total = query(
                &conn,
                &format!(
                    "SELECT num_rows FROM parquet_file_metadata({})",
                    quote(path)
                ),
                1,
                4096,
                false,
            )?["rows"][0]["num_rows"]
                .clone();
        }
        if mode == "analysis" {
            run(
                &conn,
                "SET enable_external_access=false; SET lock_configuration=true",
            )?;
        }

        let sql = if preview {
            format!("SELECT * FROM \"file\" LIMIT {rows_limit}")
        } else if mode == "import" {
            "SELECT * FROM \"file\"".into()
        } else {
            input["script"].as_str().unwrap_or("").to_owned()
        };
        if !one_statement(&sql) || !read_statement(&conn, &sql)? {
            return Err(err(422, "READ_ONLY_SQL"));
        }
        if mode == "import" && schema.as_array().is_some_and(|v| v.len() > 100) {
            return Err(err(413, "IMPORT_COLUMN_LIMIT"));
        }
        let mut result = query_bounded(
            &conn,
            &sql,
            rows_limit,
            if preview { 128 * 1024 } else { 1024 * 1024 },
            true,
            mode == "import",
        )?;
        if mode == "import" && result["columns"].as_array().is_some_and(|v| v.len() > 100) {
            return Err(err(413, "IMPORT_COLUMN_LIMIT"));
        }
        if preview {
            if result["columns"].as_array().is_some_and(|v| v.len() > 50) {
                return Err(err(422, "PREVIEW_COLUMN_LIMIT"));
            }
            let rows = result["rows"].as_array_mut().expect("rows");
            let truncated = rows.len() > 20;
            rows.truncate(20);
            result["rowCount"] = json!(rows.len());
            result["truncated"] = json!(truncated);
            result["totalRows"] = total;
            result["typesInferred"] = json!(format == "csv");
        } else if mode != "import" {
            result["stdout"] = json!("");
            result["stderr"] = json!("");
            result["exitCode"] = json!(0);
        }
        if mode != "import" {
            result["schema"] = schema;
        }
        Ok(result)
    }
}
pub async fn bash(input: &Value) -> Result<Value> {
    use bashkit::ReadOnlyFs;
    use bashkit::{Bash, ExecutionLimits, FileSystem, InMemoryFs};
    let path = input["workspacePath"]
        .as_str()
        .ok_or_else(|| err(400, "INVALID_ANALYSIS"))?;
    let bytes = std::fs::read(
        input["sourcePath"]
            .as_str()
            .ok_or_else(|| err(400, "INVALID_ANALYSIS"))?,
    )
    .map_err(|_| err(422, "ANALYSIS_FAILED"))?;
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let _text = std::str::from_utf8(bytes).map_err(|_| err(422, "ANALYSIS_BINARY_TEXT"))?;
    if bytes.iter().any(|b| *b < 9 || (*b > 13 && *b < 32)) {
        return Err(err(422, "ANALYSIS_BINARY_TEXT"));
    }
    let fs = Arc::new(InMemoryFs::new());
    fs.mkdir(Path::new(path).parent().unwrap_or(Path::new("/")), true)
        .await
        .map_err(|_| err(422, "ANALYSIS_FAILED"))?;
    fs.mkdir(Path::new("/workspace"), true)
        .await
        .map_err(|_| err(422, "ANALYSIS_FAILED"))?;
    fs.write_file(Path::new(path), bytes)
        .await
        .map_err(|_| err(422, "ANALYSIS_FAILED"))?;
    let alias = "/workspace/input.log";
    if path != alias
        && !path.starts_with(&(alias.to_owned() + "/"))
        && !alias.starts_with(&(path.to_owned() + "/"))
    {
        fs.symlink(Path::new(path), Path::new(alias))
            .await
            .map_err(|_| err(422, "ANALYSIS_FAILED"))?;
    }
    let limits = ExecutionLimits {
        max_commands: 1000,
        max_loop_iterations: 10000,
        max_total_loop_iterations: 10000,
        max_function_depth: 20,
        max_input_bytes: 65536,
        max_stdout_bytes: 1024 * 1024,
        max_stderr_bytes: 1024 * 1024,
        max_live_intermediate_bytes: 64 * 1024 * 1024,
        timeout: Duration::from_secs(15),
        ..Default::default()
    };
    let mut shell = Bash::builder()
        .fs(Arc::new(ReadOnlyFs::new(fs)))
        .rootfs(false)
        .cwd("/workspace")
        .env("FILE", path)
        .limits(limits)
        .builtin_filter(|name| {
            [
                "cat", "grep", "head", "tail", "wc", "sort", "uniq", "cut", "awk", "sed", "tr",
                "echo", "printf", "pwd", "ls", "find", "basename", "dirname", "test", "[", "true",
                "false", "seq",
            ]
            .contains(&name)
        })
        .build();
    let result = shell
        .exec(input["script"].as_str().unwrap_or(""))
        .await
        .map_err(|_| err(422, "ANALYSIS_FAILED"))?;
    if result.stderr.contains("filesystem is read-only") {
        return Err(err(422, "EROFS"));
    }
    if result.stdout.len() + result.stderr.len() > 1024 * 1024 {
        return Err(err(422, "ANALYSIS_OUTPUT_LIMIT"));
    }
    Ok(
        json!({"columns":[],"columnTypes":[],"schema":[],"rows":[],"rowCount":0,"stdout":result.stdout,"stderr":result.stderr,"exitCode":result.exit_code}),
    )
}

fn database_query(conn: &Connection, sql: &str, read_only: bool) -> Result<Value> {
    if sql.trim().is_empty() || sql.len() > 65536 || !one_statement(sql) {
        return Err(err(400, "INVALID_SQL"));
    }
    let read = read_statement(conn, sql)?;
    if !allowed(sql) || (read_only && !read) {
        return Err(err(403, "SQL_PERMISSION_DENIED"));
    }
    let unquoted = regex::Regex::new(r#"(?s)'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|/\*.*?\*/"#)
        .expect("regex")
        .replace_all(sql, "");
    let returning = regex::Regex::new(r"(?i)\bRETURNING\b")
        .expect("regex")
        .is_match(&unquoted);
    if read || returning {
        query(conn, sql, 1000, 1024 * 1024, false)
    } else {
        let n = conn.execute(sql, []).map_err(safe_error)?;
        Ok(json!({"columns":[],"rows":[],"rowCount":0,"affectedRows":n}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn statements_do_not_execute_prefixes_or_misread_literals() {
        for sql in [
            "SELECT 1; DROP TABLE t",
            "CREATE TABLE injected(a INT); SELECT 1",
            "/* unterminated",
            "SELECT 'unterminated",
        ] {
            assert!(!one_statement(sql), "{sql}");
        }
        for sql in [
            "SELECT ';' AS x; -- end",
            "SELECT $$;$$",
            "/* one /* nested */ end */ SELECT 1",
            "SELECT E'\\\';' AS value",
            "SELECT 1 /* ; */",
        ] {
            assert!(one_statement(sql), "{sql}");
        }
        let conn = setup().unwrap();
        assert_eq!(
            database_query(&conn, "CREATE TABLE injected(a INT); SELECT 1", false)
                .unwrap_err()
                .code,
            "INVALID_SQL"
        );
        assert!(conn.prepare("SELECT * FROM injected").is_err());
    }
    #[test]
    fn native_database_preserves_values_and_persists_without_node() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.duckdb");
        let conn = Connection::open(&path).unwrap();
        database_query(
            &conn,
            "CREATE TABLE example(i BIGINT, d DECIMAL(30,8), label VARCHAR)",
            false,
        )
        .unwrap();
        assert_eq!(database_query(&conn,"INSERT INTO example VALUES (9007199254740993, 12345678901234567890.12345678, 'original')",false).unwrap()["affectedRows"],1);
        assert_eq!(
            database_query(&conn, "SELECT i, d, label, i AS label FROM example", false).unwrap()["rows"]
                [0],
            json!({"i":"9007199254740993","d":"12345678901234567890.12345678","label":"original","label_2":"9007199254740993"})
        );
        assert_eq!(
            database_query(
                &conn,
                "WITH x AS (SELECT 1) INSERT INTO example SELECT 2, 1.0, 'new' FROM x",
                true
            )
            .unwrap_err()
            .code,
            "SQL_PERMISSION_DENIED"
        );
        assert_eq!(
            database_query(
                &conn,
                "INSERT INTO example VALUES(3, 1.0, 'returned') RETURNING label",
                false
            )
            .unwrap()["rows"],
            json!([{"label":"returned"}])
        );
        database_query(&conn, "DELETE FROM example WHERE i=3", false).unwrap();
        assert_eq!(
            database_query(&conn, "DELETE FROM example", true)
                .unwrap_err()
                .code,
            "SQL_PERMISSION_DENIED"
        );
        database_query(&conn, "CHECKPOINT", false).unwrap();
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        assert_eq!(
            database_query(&conn, "SELECT count(*) AS n FROM example", true).unwrap()["rows"][0]["n"],
            "1"
        );
        run(
            &conn,
            "SET enable_external_access=false; SET lock_configuration=true",
        )
        .unwrap();
        assert!(database_query(&conn, "SELECT * FROM read_csv('/etc/passwd')", true).is_err());
        assert_eq!(
            database_query(&conn, "SELECT i FROM example WHERE false", true).unwrap()["columns"],
            json!(["i"])
        );
    }
    #[test]
    fn csv_preview_and_import_keep_limits_without_mutating_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("input.csv");
        let csv = "name,n\n\"quoted, name\",1\n";
        std::fs::write(&path, csv).unwrap();
        let preview = duckdb(&json!({"mode":"preview","sourcePath":path,"format":"csv"})).unwrap();
        assert_eq!(preview["rows"][0]["name"], "quoted, name");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), csv);
        std::fs::write(
            &path,
            format!(
                "n\n{}",
                (0..1001).map(|n| format!("{n}\n")).collect::<String>()
            ),
        )
        .unwrap();
        let input = json!({"mode":"import","sourcePath":path,"parsing":{"format":"csv","header":true,"delimiter":","}});
        assert_eq!(duckdb(&input).unwrap_err().code, "IMPORT_ROW_LIMIT");
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                (0..101)
                    .map(|n| format!("c{n}"))
                    .collect::<Vec<_>>()
                    .join(","),
                vec!["1"; 101].join(",")
            ),
        )
        .unwrap();
        assert_eq!(duckdb(&input).unwrap_err().code, "IMPORT_COLUMN_LIMIT");
    }
    #[tokio::test]
    async fn bash_only_sees_selected_read_only_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("snapshot");
        std::fs::write(&path, "\u{feff}hello\n").unwrap();
        let input = json!({"sourcePath":path,"workspacePath":"/nested/original.log","script":"cat \"$FILE\"; cat /workspace/input.log"});
        assert_eq!(bash(&input).await.unwrap()["stdout"], "hello\nhello\n");
        let mut input = input;
        input["script"] = json!("cat /etc/passwd");
        assert_ne!(bash(&input).await.unwrap()["exitCode"], 0);
        input["script"] = json!("printf changed > \"$FILE\"");
        assert_eq!(bash(&input).await.unwrap_err().code, "EROFS");
        input["script"] = json!("curl https://example.com");
        assert_ne!(bash(&input).await.unwrap()["exitCode"], 0);
    }
}
