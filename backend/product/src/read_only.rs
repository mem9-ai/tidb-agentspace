//! A deliberately constrained read-only SQL language. Fail closed before provider I/O.
use sqlparser::{
    ast::{Expr, Query, Select, Statement, TableFactor, Visit, Visitor},
    dialect::PostgreSqlDialect,
    parser::Parser,
    tokenizer::{Token, Tokenizer},
};
use std::ops::ControlFlow;
use workspace_contracts::Result;
use workspace_providers::err;

pub(super) fn validate(sql: &str) -> Result<()> {
    if sql.len() > 65536 || sql.trim().is_empty() {
        return Err(err(400, "INVALID_SQL"));
    }
    // MySQL executable comments and dialect-specific escapes must not disagree with the parser.
    if sql.contains("/*!") || sql.to_ascii_lowercase().contains("/*m!") || sql.contains('\\') {
        return Err(err(403, "READ_ONLY_SQL_REQUIRED"));
    }
    let dialect = &PostgreSqlDialect {};
    let tokens = Tokenizer::new(dialect, sql)
        .tokenize()
        .map_err(|_| err(403, "READ_ONLY_SQL_REQUIRED"))?;
    if tokens.len() > 1024 {
        return Err(err(403, "READ_ONLY_SQL_REQUIRED"));
    }
    let mut depth = 0usize;
    for token in &tokens {
        if matches!(token, Token::LParen | Token::LBracket | Token::LBrace) {
            depth += 1;
        }
        if depth > 32 {
            return Err(err(403, "READ_ONLY_SQL_REQUIRED"));
        }
        if matches!(token, Token::RParen | Token::RBracket | Token::RBrace) {
            depth = depth.saturating_sub(1);
        }
    }
    let statements = Parser::new(dialect)
        .with_tokens(tokens)
        .parse_statements()
        .map_err(|_| err(403, "READ_ONLY_SQL_REQUIRED"))?;
    if statements.len() != 1 || statements.visit(&mut ReadOnly { depth: 0 }).is_break() {
        return Err(err(403, "READ_ONLY_SQL_REQUIRED"));
    }
    Ok(())
}
struct ReadOnly {
    depth: usize,
}
impl Visitor for ReadOnly {
    type Break = ();
    fn pre_visit_statement(&mut self, s: &Statement) -> ControlFlow<()> {
        if matches!(s, Statement::Query(_)) {
            ControlFlow::Continue(())
        } else {
            ControlFlow::Break(())
        }
    }
    fn pre_visit_query(&mut self, q: &Query) -> ControlFlow<()> {
        if q.locks.is_empty() {
            ControlFlow::Continue(())
        } else {
            ControlFlow::Break(())
        }
    }
    fn pre_visit_select(&mut self, s: &Select) -> ControlFlow<()> {
        if s.into.is_none() {
            ControlFlow::Continue(())
        } else {
            ControlFlow::Break(())
        }
    }
    fn pre_visit_table_factor(&mut self, t: &TableFactor) -> ControlFlow<()> {
        match t {
            TableFactor::Table { args: None, .. }
            | TableFactor::Derived { .. }
            | TableFactor::NestedJoin { .. } => ControlFlow::Continue(()),
            _ => ControlFlow::Break(()),
        }
    }
    fn post_visit_expr(&mut self, _: &Expr) -> ControlFlow<()> {
        self.depth -= 1;
        ControlFlow::Continue(())
    }
    fn pre_visit_expr(&mut self, e: &Expr) -> ControlFlow<()> {
        self.depth += 1;
        if self.depth > 64 {
            return ControlFlow::Break(());
        }
        if let Expr::Function(f) = e {
            // No schema qualification or arbitrary UDFs/table functions. PostgreSQL resolves
            // these builtins in pg_catalog first inside its read-only transaction.
            let name = f.name.to_string().to_ascii_lowercase();
            if !matches!(
                name.as_str(),
                "count"
                    | "sum"
                    | "avg"
                    | "min"
                    | "max"
                    | "abs"
                    | "round"
                    | "ceil"
                    | "ceiling"
                    | "floor"
                    | "coalesce"
                    | "nullif"
                    | "greatest"
                    | "least"
                    | "lower"
                    | "upper"
                    | "length"
                    | "char_length"
                    | "octet_length"
                    | "substring"
                    | "substr"
                    | "trim"
                    | "ltrim"
                    | "rtrim"
                    | "replace"
                    | "concat"
                    | "concat_ws"
                    | "left"
                    | "right"
                    | "row_number"
                    | "rank"
                    | "dense_rank"
                    | "lag"
                    | "lead"
                    | "first_value"
                    | "last_value"
                    | "date_trunc"
                    | "date_part"
                    | "strftime"
                    | "strptime"
                    | "json_extract"
                    | "json_extract_string"
                    | "json_type"
                    | "json_array_length"
                    | "string_agg"
                    | "group_concat"
                    | "array_agg"
                    | "bool_and"
                    | "bool_or"
            ) {
                return ControlFlow::Break(());
            }
        }
        ControlFlow::Continue(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_hidden_writes_functions_and_session_escapes() {
        assert!(validate(&format!("SELECT {}1{}", "(".repeat(100), ")".repeat(100)),).is_err());
        assert!(validate(&format!("SELECT {}1", "1+".repeat(2000))).is_err());
        for sql in [
            "SELECT 1",
            "/* read */ WITH x AS (SELECT 1 AS id) SELECT count(*) FROM x",
            "SELECT 'DELETE; DROP TABLE t' AS text",
            "SELECT * FROM t WHERE id IN (SELECT id FROM u)",
        ] {
            assert!(validate(sql).is_ok(), "{sql}");
        }
        for sql in [
            "DELETE FROM t",
            "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
            "WITH x AS (SELECT 1) UPDATE t SET id=2",
            "SELECT 1; DELETE FROM t",
            "SELECT * INTO copied FROM t",
            "SELECT * FROM t FOR UPDATE",
            "SELECT nextval('seq')",
            "SELECT set_config('transaction_read_only','off',false)",
            "SELECT workspace.count(*)",
            "SELECT * FROM read_csv('https://example.com')",
            "SET TRANSACTION READ WRITE",
            "SELECT 1 /*! INTO OUTFILE '/tmp/file' */",
            "CALL dangerous()",
        ] {
            assert!(validate(sql).is_err(), "{sql}");
        }
    }
}
