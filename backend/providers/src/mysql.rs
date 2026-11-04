use super::{
    err,
    sql::{append, names_unique},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures::{StreamExt, stream::FuturesUnordered};
use mysql_async::{
    Conn, OptsBuilder, SslOpts, Value as Native, consts::ColumnType, prelude::Queryable,
};
use serde_json::{Value, json};
use workspace_contracts::{Result, ServiceError};

fn safe(error: mysql_async::Error) -> ServiceError {
    if let mysql_async::Error::Server(e) = error {
        return match e.code {
            1050 => err(409, "SQL_TABLE_EXISTS"),
            1064 | 1065 | 8130 => err(422, "SQL_SYNTAX_ERROR"),
            1044 | 1142 | 1227 => err(403, "SQL_PERMISSION_DENIED"),
            1054 | 1146 => err(422, "SQL_OBJECT_NOT_FOUND"),
            1062 => err(409, "SQL_CONFLICT"),
            _ => err(502, "SQL_EXECUTION_FAILED"),
        };
    }
    err(502, "SQL_EXECUTION_FAILED")
}
async fn first_success<T>(
    attempts: FuturesUnordered<impl std::future::Future<Output = Result<T>>>,
) -> Result<T> {
    let mut attempts = attempts;
    while let Some(result) = attempts.next().await {
        if let Ok(connection) = result {
            return Ok(connection);
        }
    }
    Err(err(502, "SQL_EXECUTION_FAILED"))
}
async fn connect(b: &Value) -> Result<Conn> {
    let host = b["host"]
        .as_str()
        .ok_or_else(|| err(503, "DATABASE_NOT_CONFIGURED"))?;
    let port = b["port"].as_u64().unwrap_or(0) as u16;
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| err(502, "SQL_EXECUTION_FAILED"))?
        .map(|a| a.ip())
        .collect::<std::collections::BTreeSet<_>>();
    let options = OptsBuilder::default()
        .ip_or_hostname(host)
        .tcp_port(port)
        .user(b["user"].as_str())
        .pass(b["password"].as_str())
        .db_name(b["database"].as_str())
        .ssl_opts(
            SslOpts::default()
                .with_danger_accept_invalid_certs(false)
                .with_danger_skip_domain_validation(false),
        )
        .prefer_socket(false)
        .setup(Vec::<String>::new())
        .client_found_rows(true);
    // Race only DNS-derived, allowlisted-host connections. Every TLS handshake retains the original
    // hostname. No customer SQL is sent until one verified connection is selected; SQL is never retried.
    let attempts = addresses
        .into_iter()
        .take(8)
        .map(|ip| {
            let options = options.clone().resolved_ips(Some(vec![ip]));
            async move { Conn::new(options).await.map_err(safe) }
        })
        .collect::<FuturesUnordered<_>>();
    first_success(attempts).await
}
pub async fn execute(b: &Value, sql: &str) -> Result<Value> {
    let mut conn = connect(b).await?;
    // COM_STMT_PREPARE rejects multiple statements without executing any prefix.
    let statement = conn.prep(sql).await.map_err(safe)?;
    conn.close(statement).await.map_err(safe)?;
    let mut result = conn.query_iter(sql).await.map_err(safe)?;
    let columns = result.columns_ref().to_vec();
    let names = names_unique(columns.iter().map(|c| c.name_str().into_owned()).collect());
    let mut retained = json!(names).to_string().len();
    let mut rows = vec![];
    while let Some(row) = result.next().await.map_err(safe)? {
        let values = row
            .unwrap()
            .into_iter()
            .zip(&columns)
            .map(|(v, column)| {
                Ok(match v {
                    Native::NULL => Value::Null,
                    Native::Bytes(bytes) => {
                        let string = || {
                            std::str::from_utf8(&bytes)
                                .map_err(|_| err(502, "SQL_EXECUTION_FAILED"))
                        };
                        match column.column_type() {
                            ColumnType::MYSQL_TYPE_TINY
                            | ColumnType::MYSQL_TYPE_SHORT
                            | ColumnType::MYSQL_TYPE_INT24
                            | ColumnType::MYSQL_TYPE_LONG
                            | ColumnType::MYSQL_TYPE_YEAR => json!(
                                string()?
                                    .parse::<i64>()
                                    .map_err(|_| err(502, "SQL_EXECUTION_FAILED"))?
                            ),
                            ColumnType::MYSQL_TYPE_FLOAT | ColumnType::MYSQL_TYPE_DOUBLE => json!(
                                string()?
                                    .parse::<f64>()
                                    .map_err(|_| err(502, "SQL_EXECUTION_FAILED"))?
                            ),
                            ColumnType::MYSQL_TYPE_BIT => json!(STANDARD.encode(&bytes)),
                            _ if column.character_set() == 63
                                && matches!(
                                    column.column_type(),
                                    ColumnType::MYSQL_TYPE_STRING
                                        | ColumnType::MYSQL_TYPE_VAR_STRING
                                        | ColumnType::MYSQL_TYPE_VARCHAR
                                        | ColumnType::MYSQL_TYPE_TINY_BLOB
                                        | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
                                        | ColumnType::MYSQL_TYPE_LONG_BLOB
                                        | ColumnType::MYSQL_TYPE_BLOB
                                        | ColumnType::MYSQL_TYPE_GEOMETRY
                                ) =>
                            {
                                json!(STANDARD.encode(&bytes))
                            }
                            _ => json!(string()?),
                        }
                    }
                    // Text protocol normally returns bytes; keep defensive native variants precise.
                    Native::Int(n) => json!(n.to_string()),
                    Native::UInt(n) => json!(n.to_string()),
                    Native::Float(n) => json!(n),
                    Native::Double(n) => json!(n),
                    _ => return Err(err(502, "SQL_EXECUTION_FAILED")),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        append(&names, &mut rows, values, &mut retained)?;
    }
    let affected = result.affected_rows();
    result.drop_result().await.map_err(safe)?;
    Ok(json!({"columns":names,"rowCount":rows.len(),"rows":rows,"affectedRows":affected}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "standalone MySQL databases are retired; restore provider verification before enabling"]
    async fn connection_race_ignores_failed_candidates_and_drops_losers_before_sql() {
        let attempts = (0..3)
            .map(|n| async move {
                if n == 0 {
                    Err(err(502, "SQL_EXECUTION_FAILED"))
                } else if n == 1 {
                    Ok(42)
                } else {
                    std::future::pending().await
                }
            })
            .collect::<FuturesUnordered<_>>();
        assert_eq!(first_success(attempts).await.unwrap(), 42);
    }
}
