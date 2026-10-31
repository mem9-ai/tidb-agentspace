use super::err;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures::TryStreamExt;
use serde_json::{Value, json};
use sqlx::{
    Column, ConnectOptions, Connection, Either, Executor, Row, Statement, TypeInfo, ValueRef,
};
use std::time::Duration;
use workspace_contracts::Result;
pub async fn execute_native(b: &Value, sql: &str, setup: bool) -> Result<Value> {
    tokio::time::timeout(Duration::from_secs(15), execute(b, sql, setup))
        .await
        .map_err(|_| err(504, "SQL_TIMEOUT"))?
}
pub async fn execute_native_read_only(b: &Value, sql: &str, read_only: bool) -> Result<Value> {
    if !read_only {
        return execute_native(b, sql, false).await;
    }
    tokio::time::timeout(Duration::from_secs(15), async {
        if b["kind"] == "mysql" {
            return super::mysql::execute(b, sql).await;
        }
        postgres_queries_mode(connect_postgres(b).await?, &[sql], false, true)
            .await
            .map(|mut v| v.remove(0))
    })
    .await
    .map_err(|_| err(504, "SQL_TIMEOUT"))?
}
async fn execute(b: &Value, sql: &str, setup: bool) -> Result<Value> {
    if b["kind"] == "mysql" {
        super::mysql::execute(b, sql).await
    } else {
        postgres_query(connect_postgres(b).await?, sql, setup).await
    }
}
async fn connect_postgres(b: &Value) -> Result<sqlx::PgConnection> {
    let options = sqlx::postgres::PgConnectOptions::new_without_pgpass()
        .host(
            b["host"]
                .as_str()
                .ok_or_else(|| err(503, "DATABASE_NOT_CONFIGURED"))?,
        )
        .port(b["port"].as_u64().unwrap_or(0) as u16)
        .username(b["user"].as_str().unwrap_or(""))
        .password(b["password"].as_str().unwrap_or(""))
        .database(b["database"].as_str().unwrap_or(""))
        .ssl_mode(sqlx::postgres::PgSslMode::VerifyFull)
        .application_name("agent-workspace")
        .disable_statement_logging();
    sqlx::PgConnection::connect_with(&options)
        .await
        .map_err(|e| safe_at("connect", e))
}
pub(super) async fn execute_postgres_catalog(
    b: &Value,
    statements: &[String],
) -> Result<Vec<Value>> {
    tokio::time::timeout(Duration::from_secs(15), async {
        let conn = connect_postgres(b).await?;
        let statements = statements.iter().map(String::as_str).collect::<Vec<_>>();
        postgres_queries(conn, &statements, false).await
    })
    .await
    .map_err(|_| err(504, "SQL_TIMEOUT"))?
}
async fn postgres_query(conn: sqlx::PgConnection, sql: &str, setup: bool) -> Result<Value> {
    Ok(postgres_queries(conn, &[sql], setup).await?.remove(0))
}
async fn postgres_queries(
    conn: sqlx::PgConnection,
    statements: &[&str],
    setup: bool,
) -> Result<Vec<Value>> {
    postgres_queries_mode(conn, statements, setup, false).await
}
async fn postgres_queries_mode(
    mut conn: sqlx::PgConnection,
    statements: &[&str],
    setup: bool,
    read_only: bool,
) -> Result<Vec<Value>> {
    let result = async {
        if !setup {
            conn.execute(if read_only {
                "SET search_path TO pg_catalog, workspace"
            } else {
                "SET search_path TO workspace, pg_catalog"
            })
            .await
            .map_err(safe)?;
        }
        conn.execute("SET statement_timeout = 15000")
            .await
            .map_err(safe)?;
        if read_only {
            conn.execute("START TRANSACTION READ ONLY")
                .await
                .map_err(safe)?;
        }
        let mut results = vec![];
        let mut bytes = 0;
        let mut rows = 0;
        for sql in statements {
            let result = postgres_statement(&mut conn, sql).await?;
            bytes += result.to_string().len();
            rows += result["rowCount"].as_u64().unwrap_or(0);
            if statements.len() > 1 && (bytes > 1024 * 1024 || rows > 1000) {
                return Err(err(422, "RESULT_TOO_LARGE"));
            }
            results.push(result);
        }
        if read_only {
            conn.execute("ROLLBACK").await.map_err(safe)?;
        }
        Ok(results)
    }
    .await;
    // Send protocol Terminate on completed requests. Closing must not overwrite a confirmed write result.
    if let Ok(Err(e)) = tokio::time::timeout(Duration::from_secs(1), conn.close()).await {
        let _ = safe_at("close", e);
    }
    result
}
async fn postgres_statement(conn: &mut sqlx::PgConnection, sql: &str) -> Result<Value> {
    // Prepare validates one statement and obtains fields without SQLx's EXPLAIN/nullability probes.
    let description = conn.prepare(sql).await.map_err(safe)?;
    let names = names_unique(
        description
            .columns()
            .iter()
            .map(|c| c.name().to_owned())
            .collect(),
    );
    let mut rows = vec![];
    let mut affected = 0;
    let mut retained = json!(names).to_string().len();
    let mut stream = sqlx::raw_sql(sql).fetch_many(&mut *conn);
    while let Some(next) = stream.try_next().await.map_err(safe)? {
        match next {
            Either::Left(r) => affected = r.rows_affected(),
            Either::Right(row) => {
                let mut values = vec![];
                for i in 0..row.len() {
                    let raw = row.try_get_raw(i).map_err(safe)?;
                    let t = row.columns()[i].type_info().name();
                    let v = if raw.is_null() {
                        Value::Null
                    } else {
                        match t {
                            "BOOL" => json!(row.try_get::<bool, _>(i).map_err(safe)?),
                            "INT2" | "INT4" => json!(
                                raw.as_str()
                                    .map_err(|_| err(502, "SQL_EXECUTION_FAILED"))?
                                    .parse::<i64>()
                                    .map_err(|_| err(502, "SQL_EXECUTION_FAILED"))?
                            ),
                            "FLOAT4" | "FLOAT8" => json!(
                                raw.as_str()
                                    .map_err(|_| err(502, "SQL_EXECUTION_FAILED"))?
                                    .parse::<f64>()
                                    .map_err(|_| err(502, "SQL_EXECUTION_FAILED"))?
                            ),
                            "BYTEA" => {
                                json!(STANDARD.encode(row.try_get::<Vec<u8>, _>(i).map_err(safe)?))
                            }
                            _ if t.ends_with("[]") => pg_array(
                                raw.as_str().map_err(|_| err(502, "SQL_EXECUTION_FAILED"))?,
                                t.trim_end_matches("[]"),
                            )?,
                            _ => json!(raw.as_str().map_err(|_| err(502, "SQL_EXECUTION_FAILED"))?),
                        }
                    };
                    values.push(v);
                }
                append(&names, &mut rows, values, &mut retained)?;
            }
        }
    }
    if !names.is_empty() {
        affected = 0;
    }
    Ok(json!({"columns":names,"rowCount":rows.len(),"rows":rows,"affectedRows":affected}))
}
pub(super) fn names_unique(names: Vec<String>) -> Vec<String> {
    let mut used = std::collections::BTreeSet::new();
    names
        .into_iter()
        .map(|name| {
            let mut key = name.clone();
            let mut n = 2;
            while used.contains(&key) {
                key = format!("{name}_{n}");
                n += 1;
            }
            used.insert(key.clone());
            key
        })
        .collect()
}
pub(super) fn append(
    columns: &[String],
    rows: &mut Vec<Value>,
    values: Vec<Value>,
    retained: &mut usize,
) -> Result<()> {
    let row: serde_json::Map<_, _> = columns.iter().cloned().zip(values).collect();
    let row = Value::Object(row);
    let bytes = *retained + row.to_string().len();
    if rows.len() >= 1000 || bytes > 1024 * 1024 {
        return Err(err(422, "RESULT_TOO_LARGE"));
    }
    *retained = bytes;
    rows.push(row);
    Ok(())
}
fn safe(e: impl Into<sqlx::Error>) -> workspace_contracts::ServiceError {
    safe_at("query", e.into())
}
fn safe_at(phase: &str, e: sqlx::Error) -> workspace_contracts::ServiceError {
    let category = match &e {
        sqlx::Error::Database(d) => {
            let code = d.code().unwrap_or_default();
            if code.len() == 5 && code.bytes().all(|b| b.is_ascii_alphanumeric()) {
                code.into_owned()
            } else {
                "database".into()
            }
        }
        sqlx::Error::Io(e) => format!("io:{:?}", e.kind()),
        sqlx::Error::Tls(_) => "tls".into(),
        sqlx::Error::Protocol(_) => "protocol".into(),
        _ => "client".into(),
    };
    eprintln!("PostgreSQL {phase} failed ({category}); no SQL retry performed.");
    if let Some(d) = e.as_database_error() {
        let code = d.code().unwrap_or_default();
        return match code.as_ref() {
            "42P07" => err(409, "SQL_TABLE_EXISTS"),
            "42601" => err(422, "SQL_SYNTAX_ERROR"),
            "42501" | "25006" => err(403, "SQL_PERMISSION_DENIED"),
            "42P01" | "42703" | "42883" => err(422, "SQL_OBJECT_NOT_FOUND"),
            "23505" => err(409, "SQL_CONFLICT"),
            "57014" => err(504, "SQL_TIMEOUT"),
            _ => err(502, "SQL_EXECUTION_FAILED"),
        };
    }
    err(502, "SQL_EXECUTION_FAILED")
}

// PostgreSQL sends text arrays with quoting/escaping and optional lower-bound dimensions.
// Keep int8 elements as strings, matching pg's default array parser.
fn pg_array(text: &str, kind: &str) -> Result<Value> {
    fn level(
        chars: &mut std::iter::Peekable<std::str::Chars<'_>>,
        kind: &str,
        depth: usize,
    ) -> Result<Value> {
        if depth > 16 || chars.next() != Some('{') {
            return Err(err(502, "SQL_EXECUTION_FAILED"));
        }
        let mut out = vec![];
        if chars.peek() == Some(&'}') {
            chars.next();
            return Ok(json!(out));
        }
        loop {
            let value = if chars.peek() == Some(&'{') {
                level(chars, kind, depth + 1)?
            } else {
                let quoted = chars.peek() == Some(&'"');
                if quoted {
                    chars.next();
                }
                let mut token = String::new();
                let mut closed = !quoted;
                while let Some(&c) = chars.peek() {
                    if c == '\\' {
                        chars.next();
                        token.push(
                            chars
                                .next()
                                .ok_or_else(|| err(502, "SQL_EXECUTION_FAILED"))?,
                        );
                    } else if quoted && c == '"' {
                        chars.next();
                        closed = true;
                        break;
                    } else if !quoted && [',', '}'].contains(&c) {
                        break;
                    } else {
                        token.push(c);
                        chars.next();
                    }
                }
                if !closed {
                    return Err(err(502, "SQL_EXECUTION_FAILED"));
                }
                if !quoted && token == "NULL" {
                    Value::Null
                } else {
                    match kind {
                        "BOOL" => json!(token == "t"),
                        "INT2" | "INT4" | "FLOAT4" | "FLOAT8" | "NUMERIC" => json!(
                            token
                                .parse::<f64>()
                                .map_err(|_| err(502, "SQL_EXECUTION_FAILED"))?
                        ),
                        "JSON" | "JSONB" => serde_json::from_str(&token)
                            .map_err(|_| err(502, "SQL_EXECUTION_FAILED"))?,
                        _ => json!(token),
                    }
                }
            };
            out.push(value);
            match chars.next() {
                Some(',') => {}
                Some('}') => break,
                _ => return Err(err(502, "SQL_EXECUTION_FAILED")),
            }
        }
        Ok(json!(out))
    }
    let start = if text.starts_with('[') {
        text.find('=')
            .map(|i| i + 1)
            .ok_or_else(|| err(502, "SQL_EXECUTION_FAILED"))?
    } else {
        0
    };
    let mut chars = text[start..].chars().peekable();
    let result = level(&mut chars, kind, 0)?;
    if chars.next().is_some() {
        return Err(err(502, "SQL_EXECUTION_FAILED"));
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pg_arrays_keep_nulls_dimensions_escaping_and_int8_precision() {
        assert_eq!(
            pg_array("[0:1]={9007199254740993,NULL}", "INT8").unwrap(),
            json!(["9007199254740993", null])
        );
        assert_eq!(
            pg_array("{{1,2},{3,4}}", "INT4").unwrap(),
            json!([[1.0, 2.0], [3.0, 4.0]])
        );
        assert_eq!(
            pg_array(r#"{"a,b","NULL","a\\b"}"#, "TEXT").unwrap(),
            json!(["a,b", "NULL", "a\\b"])
        );
        assert!(pg_array("{unclosed", "TEXT").is_err());
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    async fn send(stream: &mut tokio::net::TcpStream, tag: u8, body: &[u8]) {
        stream.write_u8(tag).await.unwrap();
        stream.write_u32((body.len() + 4) as u32).await.unwrap();
        stream.write_all(body).await.unwrap();
    }
    async fn fields(stream: &mut tokio::net::TcpStream, text: bool) {
        let mut b = 1u16.to_be_bytes().to_vec();
        b.extend(b"checked\0");
        b.extend(0u32.to_be_bytes());
        b.extend(0u16.to_be_bytes());
        b.extend(if text { 25u32 } else { 23u32 }.to_be_bytes());
        b.extend(if text { -1i16 } else { 4i16 }.to_be_bytes());
        b.extend(u32::MAX.to_be_bytes());
        b.extend(0u16.to_be_bytes());
        send(stream, b'T', &b).await;
    }
    #[tokio::test]
    async fn pg_wire_keeps_empty_fields_avoids_explain_and_terminates_connections() {
        for (empty, batch, failing, row_count, row_bytes, read_only) in [
            (false, false, false, 1, 1u32, false),
            (false, false, false, 1, 1u32, true),
            (true, false, false, 1, 1, false),
            (false, true, false, 1, 1, false),
            (false, true, true, 1, 1, false),
            (false, true, false, 600, 1, false),
            (false, true, false, 1, 600_000, false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let n = socket.read_u32().await.unwrap();
                let mut start = vec![0; n as usize - 4];
                socket.read_exact(&mut start).await.unwrap();
                send(&mut socket, b'R', &0u32.to_be_bytes()).await;
                send(&mut socket, b'S', b"client_encoding\0UTF8\0").await;
                send(&mut socket, b'S', b"server_version\x0016.0\0").await;
                send(&mut socket, b'K', &[0; 8]).await;
                send(&mut socket, b'Z', b"I").await;
                let mut statements = vec![];
                let mut terminated = false;
                while let Ok(tag) = socket.read_u8().await {
                    let n = socket.read_u32().await.unwrap();
                    let mut body = vec![0; n as usize - 4];
                    socket.read_exact(&mut body).await.unwrap();
                    match tag {
                        b'P' => {
                            let mut parts = body.split(|b| *b == 0);
                            parts.next();
                            let sql = String::from_utf8(parts.next().unwrap().to_vec()).unwrap();
                            statements.push(sql);
                            send(&mut socket, b'1', &[]).await;
                        }
                        b'D' => {
                            send(&mut socket, b't', &0u16.to_be_bytes()).await;
                            fields(&mut socket, row_bytes > 1).await;
                        }
                        b'S' => send(&mut socket, b'Z', b"I").await,
                        b'Q' => {
                            let sql = std::str::from_utf8(&body[..body.len() - 1])
                                .unwrap()
                                .to_owned();
                            statements.push(sql.clone());
                            if sql.starts_with("SET ")
                                || sql == "START TRANSACTION READ ONLY"
                                || sql == "ROLLBACK"
                            {
                                send(&mut socket, b'C', b"SET\0").await;
                            } else if sql.contains("metadata_failure") {
                                send(&mut socket, b'E', b"SERROR\0C42P01\0Mfixture failure\0\0")
                                    .await;
                            } else if sql.starts_with("EXPLAIN") {
                                send(
                                    &mut socket,
                                    b'E',
                                    b"SERROR\0C0A000\0Munsupported introspection\0\0",
                                )
                                .await;
                            } else {
                                fields(&mut socket, row_bytes > 1).await;
                                for _ in 0..if empty { 0 } else { row_count } {
                                    let mut row = 1u16.to_be_bytes().to_vec();
                                    row.extend(row_bytes.to_be_bytes());
                                    row.extend(vec![
                                        if row_bytes > 1 { b'x' } else { b'1' };
                                        row_bytes as usize
                                    ]);
                                    send(&mut socket, b'D', &row).await;
                                }
                                send(
                                    &mut socket,
                                    b'C',
                                    if empty { b"SELECT 0\0" } else { b"SELECT 1\0" },
                                )
                                .await;
                            }
                            send(&mut socket, b'Z', b"I").await;
                        }
                        b'C' => send(&mut socket, b'3', &[]).await,
                        b'X' => {
                            terminated = true;
                            break;
                        }
                        _ => panic!("unexpected frontend protocol tag {tag}"),
                    }
                }
                (statements, terminated)
            });
            // TLS is disabled only for this internal loopback protocol fixture, never through product configuration.
            let opts = sqlx::postgres::PgConnectOptions::new_without_pgpass()
                .host("127.0.0.1")
                .port(port)
                .username("fixture")
                .database("fixture")
                .ssl_mode(sqlx::postgres::PgSslMode::Disable);
            let conn = sqlx::PgConnection::connect_with(&opts).await.unwrap();
            let result = if batch {
                postgres_queries(
                    conn,
                    &[
                        "SELECT 1 AS checked",
                        if failing {
                            "SELECT metadata_failure"
                        } else {
                            "SELECT 2 AS checked"
                        },
                        "SELECT 3 AS checked",
                    ],
                    false,
                )
                .await
            } else if read_only {
                postgres_queries_mode(conn, &["SELECT 1 AS checked"], false, true).await
            } else {
                postgres_query(
                    conn,
                    if empty {
                        "SELECT 1 AS checked WHERE false"
                    } else {
                        "SELECT 1 AS checked"
                    },
                    false,
                )
                .await
                .map(|v| vec![v])
            };
            let overflow = row_count == 600 || row_bytes > 1;
            if failing || overflow {
                assert_eq!(
                    result.unwrap_err().code,
                    if overflow {
                        "RESULT_TOO_LARGE"
                    } else {
                        "SQL_OBJECT_NOT_FOUND"
                    }
                );
            } else {
                let results = result.unwrap();
                assert_eq!(results.len(), if batch { 3 } else { 1 });
                for result in results {
                    assert_eq!(result["columns"], json!(["checked"]));
                    assert_eq!(
                        result["rows"],
                        if empty {
                            json!([])
                        } else {
                            json!([{"checked":1}])
                        }
                    );
                }
            }
            let (statements, terminated) = tokio::time::timeout(Duration::from_secs(2), server)
                .await
                .unwrap()
                .unwrap();
            assert!(terminated);
            assert_eq!(
                statements
                    .iter()
                    .filter(|sql| sql.as_str()
                        == if read_only {
                            "SET search_path TO pg_catalog, workspace"
                        } else {
                            "SET search_path TO workspace, pg_catalog"
                        })
                    .count(),
                1
            );
            if read_only {
                assert_eq!(
                    statements,
                    vec![
                        "SET search_path TO pg_catalog, workspace",
                        "SET statement_timeout = 15000",
                        "START TRANSACTION READ ONLY",
                        "SELECT 1 AS checked",
                        "SELECT 1 AS checked",
                        "ROLLBACK"
                    ]
                );
            }
            if batch {
                assert_eq!(
                    statements
                        .iter()
                        .filter(|sql| sql.starts_with("SELECT "))
                        .count(),
                    if failing || overflow { 4 } else { 6 }
                );
                if failing || overflow {
                    assert!(!statements.iter().any(|sql| sql == "SELECT 3 AS checked"));
                }
            }
            assert!(!statements.iter().any(|sql| sql.starts_with("EXPLAIN")));
        }
    }
}
