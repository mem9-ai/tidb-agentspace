use super::*;
impl Product {
    pub(super) async fn execute_database(
        &self,
        r: &Value,
        sql: &str,
        read_only: bool,
    ) -> Result<Value> {
        if sql.trim().is_empty() || sql.len() > 65536 {
            return Err(err(400, "INVALID_SQL"));
        }
        if r["status"] == "expired" {
            return Err(err(410, "DATABASE_EXPIRED"));
        }
        if r["status"] != "active" {
            return Err(err(409, "DATABASE_UNAVAILABLE"));
        }
        if r["provider"] == DB9 {
            self.providers.execute(r, sql, read_only).await
        } else if r["provider"].is_null() || r["provider"] == "local" {
            let state = self
                .workspace
                .repository()
                .view_selected(vec![], false, None)
                .await?;
            let sql = sql.trim().trim_end_matches(';').trim();
            if regex::Regex::new(r"(?i)^select\s+1(?:\s+as\s+connected)?$")
                .expect("regex")
                .is_match(sql)
            {
                return Ok(
                    json!({"columns":["connected"],"rows":[{"connected":1}],"rowCount":1,"durationMs":0,"mode":"demo"}),
                );
            }
            if let Some(c) =
                regex::Regex::new(r"(?i)^select\s+\*\s+from\s+agent_events(?:\s+limit\s+(\d+))?$")
                    .expect("regex")
                    .captures(sql)
            {
                let mut rows = demo_rows(&state);
                if let Some(n) = c.get(1) {
                    rows.as_array_mut()
                        .expect("rows")
                        .truncate(n.as_str().parse::<usize>().unwrap_or(0));
                }
                return Ok(
                    json!({"columns":demo_columns(),"rowCount":rows.as_array().expect("rows").len(),"rows":rows,"durationMs":0,"mode":"demo"}),
                );
            }
            Err(err(422, "DEMO_QUERY_ONLY"))
        } else {
            Err(err(503, "DATABASE_NOT_CONFIGURED"))
        }
    }
    pub(super) async fn query(
        &self,
        credential: &Credential,
        p: &Principal,
        input: &Value,
    ) -> Result<Value> {
        if input.get("readOnly").is_some_and(|v| !v.is_boolean()) {
            return Err(err(400, "INVALID_BODY"));
        }
        let read_only = input["readOnly"] == true || p.scope("queries:execute").is_err();
        let scope = if read_only {
            "queries:read"
        } else {
            "queries:execute"
        };
        let id = text(input, "resourceId")?;
        let (_, resource) = self.context(credential, scope, Some((id, None))).await?;
        if resource["kind"] == "filesystem" {
            return Err(err(404, "NOT_FOUND"));
        }
        let sql = text(input, "sql").map_err(|_| err(400, "INVALID_SQL"))?;
        if read_only {
            read_only::validate(sql)?;
        }
        if input.as_object().is_none_or(|fields| {
            fields
                .keys()
                .any(|key| !matches!(key.as_str(), "resourceId" | "sql" | "readOnly"))
        }) {
            return Err(err(400, "INVALID_BODY"));
        }
        self.context(credential, scope, Some((id, None))).await?;
        let result = self.execute_database(&resource, sql, read_only).await?;
        self.workspace
            .repository()
            .resource_transaction(
                vec![id.to_owned()],
                false,
                false,
                true,
                credential,
                |state| {
                    let principal = principal(state, credential)?;
                    principal.scope(scope)?;
                    principal.resource(state, id, None)?;
                    let count = state["queryCount"].as_u64().unwrap_or(0) + 1;
                    state["queryCount"] = json!(count);
                    if !state["resourceQueryCounts"].is_object() {
                        state["resourceQueryCounts"] = json!({});
                    }
                    let n = state["resourceQueryCounts"][id].as_u64().unwrap_or(0) + 1;
                    state["resourceQueryCounts"][id] = json!(n);
                    event(state, "query.executed", id, &p.actor, Some(id));
                    Ok(((), true))
                },
            )
            .await
            .map_err(|_| err(500, "QUERY_RECORD_FAILED"))?;
        Ok(result)
    }
    pub(super) async fn browse(
        &self,
        _credential: &Credential,
        r: &Value,
        action: &str,
        name: Option<&str>,
    ) -> Result<Value> {
        if r["kind"] == "filesystem" {
            return Err(err(404, "NOT_FOUND"));
        }
        if r["status"] == "expired" {
            return Err(err(410, "DATABASE_EXPIRED"));
        }
        if r["status"] != "active" {
            return Err(err(409, "DATABASE_UNAVAILABLE"));
        }
        let native = live(r);
        let mode = if native { "live" } else { "demo" };
        let select = "SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_catalog = current_database() AND table_schema = 'workspace'";
        if action == "tables" {
            let data = if native {
                self.execute_database(r, &format!("{select} ORDER BY table_name LIMIT 501"), true)
                    .await?["rows"]
                    .clone()
            } else {
                json!([{"name":"agent_events","type":"BASE TABLE"}])
            };
            let rows = data
                .as_array()
                .ok_or_else(|| err(502, "INVALID_METADATA"))?;
            return Ok(
                json!({"data":rows.iter().take(500).collect::<Vec<_>>(),"truncated":rows.len()>500,"mode":mode}),
            );
        }
        let name = name
            .filter(|s| {
                !s.is_empty()
                    && s.chars().count() <= 64
                    && !s.chars().any(|c| c < ' ' || c == '\u{7f}')
            })
            .ok_or_else(|| err(400, "INVALID_TABLE_NAME"))?;
        let table_query = format!(
            "SELECT * FROM \"workspace\".\"{}\" LIMIT 100;",
            name.replace('"', "\"\"")
        );
        let filter = format!(" AND table_name = {}", pg_literal(name));
        let columns_sql = format!(
            "SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS \"defaultValue\", ordinal_position AS position FROM information_schema.columns WHERE table_catalog = current_database() AND table_schema = 'workspace' AND table_name = {} ORDER BY ordinal_position",
            pg_literal(name)
        );
        let index_sql = format!(
            "SELECT i.relname AS name, x.indisunique AS \"uniqueValue\", x.indisprimary AS \"primaryValue\", x.indkey::text AS \"positionKeys\" FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class t ON t.oid = x.indrelid JOIN pg_catalog.pg_namespace s ON s.oid = t.relnamespace JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid WHERE s.nspname = 'workspace' AND t.relname = {} ORDER BY i.relname",
            pg_literal(name)
        );
        // The three metadata reads reuse one fresh native session, not three TLS handshakes.
        let pg_metadata = if native && action == "table" {
            Some(
                self.providers
                    .postgres_catalog(
                        r,
                        &[
                            format!("{select}{filter} LIMIT 1"),
                            columns_sql.clone(),
                            index_sql.clone(),
                        ],
                    )
                    .await?,
            )
        } else {
            None
        };
        let candidates = if let Some(results) = &pg_metadata {
            results[0]["rows"].clone()
        } else if native {
            self.execute_database(r, &format!("{select}{filter} LIMIT 1"), true)
                .await?["rows"]
                .clone()
        } else {
            json!([{"name":"agent_events","type":"BASE TABLE"}])
        };
        let table = candidates
            .as_array()
            .and_then(|v| v.iter().find(|t| t["name"] == name))
            .cloned()
            .ok_or_else(|| err(404, "TABLE_NOT_FOUND"))?;
        if action == "table/rows" {
            if !native {
                let state = self
                    .workspace
                    .repository()
                    .view_selected(vec![], false, None)
                    .await?;
                return Ok(
                    json!({"columns":demo_columns(),"rows":demo_rows(&state),"rowCount":3,"mode":"demo","durationMs":0}),
                );
            }
            return self.execute_database(r, &table_query, true).await;
        }
        if !native {
            return Ok(
                json!({"name":table["name"],"type":table["type"],"columns":demo_columns().iter().map(|n|json!({"name":n,"type":if *n=="id"{"int"}else if *n=="created_at"{"datetime"}else{"varchar(255)"},"nullable":false,"default":null,"key":if *n=="id"{"PRI"}else{""},"extra":""})).collect::<Vec<_>>(),"indexes":[{"name":"PRIMARY","unique":true,"columns":[{"name":"id","position":1,"prefixLength":null}]}],"query":"SELECT * FROM agent_events LIMIT 100;","mode":"demo"}),
            );
        }
        let column_result = if let Some(results) = &pg_metadata {
            results[1].clone()
        } else {
            self.execute_database(r, &columns_sql, true).await?
        };
        let columns = column_result["rows"]
            .as_array()
            .cloned()
            .ok_or_else(|| err(502, "INVALID_METADATA"))?;
        let index_result = if let Some(results) = &pg_metadata {
            results[2].clone()
        } else {
            self.execute_database(r, &index_sql, true).await?
        };
        let parts = index_result["rows"]
            .as_array()
            .cloned()
            .ok_or_else(|| err(502, "INVALID_METADATA"))?;
        let mut indexes = vec![];
        let mut primary = BTreeSet::new();
        let mut unique = BTreeSet::new();
        for part in parts {
            let keys = part["positionKeys"]
                .as_str()
                .unwrap_or("")
                .split_whitespace()
                .map(|s| s.parse::<usize>())
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|_| err(502, "INVALID_METADATA"))?;
            let names = keys
                .iter()
                .enumerate()
                .map(|(i, n)| {
                    columns
                        .iter()
                        .find(|c| number(&c["position"]) == *n as i64)
                        .and_then(|c| c["name"].as_str())
                        .map(str::to_owned)
                        .unwrap_or(format!("Expression {}", i + 1))
                })
                .collect::<Vec<_>>();
            for name in &names {
                if part["primaryValue"] == true {
                    primary.insert(name.clone());
                }
                if part["uniqueValue"] == true {
                    unique.insert(name.clone());
                }
            }
            indexes.push(json!({"name":part["name"],"unique":part["uniqueValue"]==true,"columns":names.iter().enumerate().map(|(i,n)|json!({"name":n,"position":i+1,"prefixLength":null})).collect::<Vec<_>>()}));
        }
        Ok(
            json!({"name":table["name"],"type":table["type"],"columns":columns.iter().map(|c|{let name=c["name"].as_str().unwrap_or("");json!({"name":name,"type":c["type"],"nullable":c["nullable"]=="YES","default":if c["defaultValue"].is_null(){Value::Null}else{json!(c["defaultValue"].as_str().map(str::to_owned).unwrap_or(c["defaultValue"].to_string()))},"key":if primary.contains(name){"PRI"}else if unique.contains(name){"UNI"}else{""},"extra":c["extra"].as_str().unwrap_or("")})}).collect::<Vec<_>>(),"indexes":indexes,"query":table_query,"mode":"live"}),
        )
    }
}
fn number(v: &Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}
fn pg_literal(s: &str) -> String {
    format!("E'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}
fn demo_columns() -> Vec<&'static str> {
    vec!["id", "agent", "event", "status", "created_at"]
}
fn demo_rows(state: &Value) -> Value {
    json!([(1,"research-agent","context.loaded"),(2,"coding-agent","memory.recalled"),(3,"research-agent","output.saved")].iter().map(|(id,agent,event)|json!({"id":id,"agent":agent,"event":event,"status":"completed","created_at":state["workspace"]["createdAt"]})).collect::<Vec<_>>())
}
