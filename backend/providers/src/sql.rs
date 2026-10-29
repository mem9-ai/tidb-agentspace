use super::err;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures::TryStreamExt;
use serde_json::{Value, json};
use sqlx::{Column, Connection, Either, Executor, Row, TypeInfo, ValueRef};
use std::time::Duration;
use workspace_contracts::Result;
pub async fn execute_native(b: &Value, sql: &str, setup: bool) -> Result<Value> {
    tokio::time::timeout(Duration::from_secs(15), execute(b, sql, setup))
        .await
        .map_err(|_| err(504, "SQL_TIMEOUT"))?
}
async fn execute(b: &Value, sql: &str, setup: bool) -> Result<Value> {
    let host = b["host"]
        .as_str()
        .ok_or_else(|| err(503, "DATABASE_NOT_CONFIGURED"))?;
    let user = b["user"].as_str().unwrap_or("");
    let password = b["password"].as_str().unwrap_or("");
    let database = b["database"].as_str().unwrap_or("");
    let port = b["port"].as_u64().unwrap_or(0) as u16;
    if b["kind"] == "mysql" {
        super::mysql::execute(b, sql).await
    } else {
        let options = sqlx::postgres::PgConnectOptions::new()
            .host(host)
            .port(port)
            .username(user)
            .password(password)
            .database(database)
            .ssl_mode(sqlx::postgres::PgSslMode::VerifyFull)
            .application_name("agent-workspace");
        let mut conn = sqlx::PgConnection::connect_with(&options)
            .await
            .map_err(safe)?;
        if !setup {
            conn.execute("SET search_path TO workspace, pg_catalog")
                .await
                .map_err(safe)?;
        }
        conn.execute("SET statement_timeout = 15000")
            .await
            .map_err(safe)?;
        let description = conn.describe(sql).await.map_err(safe)?;
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
        let mut stream = sqlx::raw_sql(sql).fetch_many(&mut conn);
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
                                "BYTEA" => json!(
                                    STANDARD.encode(row.try_get::<Vec<u8>, _>(i).map_err(safe)?)
                                ),
                                _ if t.ends_with("[]") => pg_array(
                                    raw.as_str().map_err(|_| err(502, "SQL_EXECUTION_FAILED"))?,
                                    t.trim_end_matches("[]"),
                                )?,
                                _ => json!(
                                    raw.as_str().map_err(|_| err(502, "SQL_EXECUTION_FAILED"))?
                                ),
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
    let e = e.into();
    if let Some(d) = e.as_database_error() {
        let code = d.code().unwrap_or_default();
        return match code.as_ref() {
            "42P07" => err(409, "SQL_TABLE_EXISTS"),
            "42601" => err(422, "SQL_SYNTAX_ERROR"),
            "42501" => err(403, "SQL_PERMISSION_DENIED"),
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
