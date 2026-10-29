use super::*;
impl Product {
    pub(super) async fn execute_database(
        &self,
        r: &Value,
        sql: &str,
        read_only: bool,
        sources: Value,
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
        if r["provider"] == DUCKDB {
            let id = text(r, "id")?;
            let b = self.providers.binding("duckdb", id).await?;
            if b["state"] != "ready" {
                return Err(err(409, "DATABASE_UNAVAILABLE"));
            }
            let c = self
                .providers
                .file_connection(text(&b, "storageId")?)
                .await?;
            self.compute.database(id, c, sql, sources, read_only).await
        } else if [ZERO, DB9].contains(&r["provider"].as_str().unwrap_or("")) {
            self.providers.execute(r, sql).await
        } else if r["provider"].is_null() || r["provider"] == "local" {
            let state = self.workspace.repository().read().await?;
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
        let id = text(input, "resourceId")?;
        let (_, resource) = self
            .context(credential, "queries:execute", Some((id, None)))
            .await?;
        if resource["kind"] == "filesystem" {
            return Err(err(404, "NOT_FOUND"));
        }
        let sql = text(input, "sql").map_err(|_| err(400, "INVALID_SQL"))?;
        let sources = input["sources"].as_array();
        if !input["sources"].is_null() && sources.is_none() {
            return Err(err(400, "INVALID_SOURCES"));
        }
        let sources = sources.cloned().unwrap_or_default();
        if sources.len() > 4 {
            return Err(err(400, "INVALID_SOURCES"));
        }
        if !sources.is_empty() && resource["provider"] != DUCKDB {
            return Err(err(400, "SOURCES_REQUIRE_DUCKDB"));
        }
        let mut names = BTreeSet::new();
        let mut selected = vec![];
        let source_name = regex::Regex::new(r"^[a-z][a-z0-9_]{0,31}$").expect("regex");
        for s in sources {
            if s.as_object().is_none_or(|v| {
                v.len() != 3
                    || v.keys()
                        .any(|k| !["name", "resourceId", "path"].contains(&k.as_str()))
            }) {
                return Err(err(400, "INVALID_SOURCES"));
            }
            let name = text(&s, "name").map_err(|_| err(400, "INVALID_SOURCES"))?;
            let path = text(&s, "path").map_err(|_| err(400, "INVALID_SOURCES"))?;
            if !source_name.is_match(name)
                || !names.insert(name.to_owned())
                || path.chars().any(|c| c < ' ' || "\\*?[]{}".contains(c))
            {
                return Err(err(400, "INVALID_SOURCES"));
            }
            let path = clean_path(path).map_err(|_| err(400, "INVALID_SOURCES"))?;
            let format = path.rsplit('.').next().unwrap_or("").to_lowercase();
            if !["csv", "json", "jsonl", "ndjson", "parquet"].contains(&format.as_str()) {
                return Err(err(415, "SOURCE_FORMAT_UNSUPPORTED"));
            }
            let sid = text(&s, "resourceId")?;
            let (_, r) = self
                .context(credential, "files:read", Some((sid, Some("filesystem"))))
                .await?;
            self.context(credential, "files:analyze", Some((sid, Some("filesystem"))))
                .await?;
            if r["status"] != "active" {
                return Err(err(409, "SOURCE_UNAVAILABLE"));
            }
            selected.push((r, path, name.to_owned(), format));
        }
        if resource["provider"] == DUCKDB {
            self.compute.verify()?;
        }
        let directory = tempfile::tempdir().map_err(|_| err(503, "SOURCE_UNAVAILABLE"))?;
        let mut staged = vec![];
        let mut size = 0;
        for (index, (r, path, name, format)) in selected.iter().enumerate() {
            let (_, bytes) = self
                .snapshot(credential, r, path, false, 16 * 1024 * 1024 - size)
                .await?;
            size += bytes.len();
            if size > 16 * 1024 * 1024 {
                return Err(err(413, "SOURCE_TOO_LARGE"));
            }
            let file = directory.path().join(format!("source-{index}.{format}"));
            write_private(&file, &bytes)?;
            staged.push(json!({"name":name,"format":format,"path":file}));
        }
        self.context(credential, "queries:execute", Some((id, None)))
            .await?;
        for (r, _, _, _) in &selected {
            self.context(
                credential,
                "files:read",
                Some((text(r, "id")?, Some("filesystem"))),
            )
            .await?;
            self.context(
                credential,
                "files:analyze",
                Some((text(r, "id")?, Some("filesystem"))),
            )
            .await?;
        }
        let result = self
            .execute_database(&resource, sql, false, json!(staged))
            .await?;
        for (r, _, _, _) in &selected {
            self.context(
                credential,
                "files:read",
                Some((text(r, "id")?, Some("filesystem"))),
            )
            .await?;
            self.context(
                credential,
                "files:analyze",
                Some((text(r, "id")?, Some("filesystem"))),
            )
            .await?;
        }
        self.workspace
            .repository()
            .transaction(|state| {
                let principal = principal(state, credential)?;
                principal.scope("queries:execute")?;
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
            })
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
        let pg = r["kind"] == "postgresql";
        let duck = r["kind"] == "duckdb";
        let mode = if native { "live" } else { "demo" };
        let select = if pg {
            "SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_catalog = current_database() AND table_schema = 'workspace'"
        } else if duck {
            "SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_catalog = current_database() AND table_schema = 'main'"
        } else {
            "SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()"
        };
        if action == "tables" {
            let data = if native {
                self.execute_database(
                    r,
                    &format!(
                        "{select} ORDER BY {} LIMIT 501",
                        if pg || duck {
                            "table_name"
                        } else {
                            "TABLE_NAME"
                        }
                    ),
                    true,
                    json!([]),
                )
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
        let table_query = if pg {
            format!(
                "SELECT * FROM \"workspace\".\"{}\" LIMIT 100;",
                name.replace('"', "\"\"")
            )
        } else if duck {
            format!(
                "SELECT * FROM \"main\".\"{}\" LIMIT 100;",
                name.replace('"', "\"\"")
            )
        } else {
            format!("SELECT * FROM `{}` LIMIT 100;", name.replace('`', "``"))
        };
        let filter = if pg {
            format!(" AND table_name = {}", pg_literal(name))
        } else if duck {
            format!(" AND table_name = {}", literal(name))
        } else {
            format!(
                " AND TABLE_NAME = CONVERT(X'{}' USING utf8mb4)",
                hex::encode(name.as_bytes())
            )
        };
        let candidates = if native {
            self.execute_database(r, &format!("{select}{filter} LIMIT 1"), true, json!([]))
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
                let state = self.workspace.repository().read().await?;
                return Ok(
                    json!({"columns":demo_columns(),"rows":demo_rows(&state),"rowCount":3,"mode":"demo","durationMs":0}),
                );
            }
            return self
                .execute_database(r, &table_query, true, json!([]))
                .await;
        }
        if !native {
            return Ok(
                json!({"name":table["name"],"type":table["type"],"columns":demo_columns().iter().map(|n|json!({"name":n,"type":if *n=="id"{"int"}else if *n=="created_at"{"datetime"}else{"varchar(255)"},"nullable":false,"default":null,"key":if *n=="id"{"PRI"}else{""},"extra":""})).collect::<Vec<_>>(),"indexes":[{"name":"PRIMARY","unique":true,"columns":[{"name":"id","position":1,"prefixLength":null}]}],"query":"SELECT * FROM agent_events LIMIT 100;","mode":"demo"}),
            );
        }
        let columns_sql = if pg {
            format!(
                "SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS \"defaultValue\", ordinal_position AS position FROM information_schema.columns WHERE table_catalog = current_database() AND table_schema = 'workspace' AND table_name = {} ORDER BY ordinal_position",
                pg_literal(name)
            )
        } else if duck {
            format!(
                "SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS defaultValue, ordinal_position AS position FROM information_schema.columns WHERE table_catalog=current_database() AND table_schema='main' AND table_name={} ORDER BY ordinal_position",
                literal(name)
            )
        } else {
            format!(
                "SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue, COLUMN_KEY AS columnKey, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE(){filter} ORDER BY ORDINAL_POSITION"
            )
        };
        let columns = self
            .execute_database(r, &columns_sql, true, json!([]))
            .await?["rows"]
            .as_array()
            .cloned()
            .ok_or_else(|| err(502, "INVALID_METADATA"))?;
        let index_sql = if pg {
            format!(
                "SELECT i.relname AS name, x.indisunique AS \"uniqueValue\", x.indisprimary AS \"primaryValue\", x.indkey::text AS \"positionKeys\" FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class t ON t.oid = x.indrelid JOIN pg_catalog.pg_namespace s ON s.oid = t.relnamespace JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid WHERE s.nspname = 'workspace' AND t.relname = {} ORDER BY i.relname",
                pg_literal(name)
            )
        } else if duck {
            format!(
                "SELECT index_name AS name, is_unique AS uniqueValue, CAST(expressions AS VARCHAR[]) AS expressions FROM duckdb_indexes() WHERE database_name=current_database() AND schema_name='main' AND table_name={} ORDER BY index_name",
                literal(name)
            )
        } else {
            format!(
                "SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS columnName, SEQ_IN_INDEX AS position, SUB_PART AS prefixLength FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE(){filter} ORDER BY INDEX_NAME, SEQ_IN_INDEX"
            )
        };
        let parts = self
            .execute_database(r, &index_sql, true, json!([]))
            .await?["rows"]
            .as_array()
            .cloned()
            .ok_or_else(|| err(502, "INVALID_METADATA"))?;
        let mut indexes = vec![];
        let mut primary = BTreeSet::new();
        let mut unique = BTreeSet::new();
        if pg {
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
        } else if duck {
            let constraints=self.execute_database(r,&format!("SELECT constraint_type AS type, constraint_column_names AS names, constraint_index AS position FROM duckdb_constraints() WHERE database_name=current_database() AND schema_name='main' AND table_name={} AND constraint_type IN ('PRIMARY KEY','UNIQUE') ORDER BY constraint_index",literal(name)),true,json!([])).await?["rows"].as_array().cloned().unwrap_or_default();
            for c in constraints {
                let names = c["names"].as_array().cloned().unwrap_or_default();
                for n in &names {
                    if c["type"] == "PRIMARY KEY" {
                        primary.insert(n.as_str().unwrap_or("").to_owned());
                    }
                    unique.insert(n.as_str().unwrap_or("").to_owned());
                }
                indexes.push(json!({"name":if c["type"]=="PRIMARY KEY"{"PRIMARY".to_owned()}else{format!("UNIQUE_{}",c["position"].as_str().unwrap_or("0"))},"unique":true,"columns":names.iter().enumerate().map(|(i,n)|json!({"name":n,"position":i+1,"prefixLength":null})).collect::<Vec<_>>()}));
            }
            for p in parts {
                indexes.push(json!({"name":p["name"],"unique":p["uniqueValue"]==true,"columns":p["expressions"].as_array().unwrap_or(&vec![]).iter().enumerate().map(|(i,n)|{let s=n.as_str().unwrap_or("");
let s=if s.starts_with('"')&&s.ends_with('"'){s[1..s.len()-1].replace("\"\"","\"")}else{s.into()};json!({"name":s,"position":i+1,"prefixLength":null})}).collect::<Vec<_>>()}));
            }
        } else {
            let mut map: BTreeMap<String, Value> = BTreeMap::new();
            for p in parts {
                let name = text(&p, "name")?.to_owned();
                let item = map.entry(name.clone()).or_insert(
                    json!({"name":name,"unique":number(&p["nonUnique"])==0,"columns":[]}),
                );
                item["columns"].as_array_mut().expect("columns").push(json!({"name":p["columnName"],"position":number(&p["position"]),"prefixLength":if p["prefixLength"].is_null(){Value::Null}else{json!(number(&p["prefixLength"]))}}));
            }
            indexes = map.into_values().collect();
        }
        Ok(
            json!({"name":table["name"],"type":table["type"],"columns":columns.iter().map(|c|{let name=c["name"].as_str().unwrap_or("");json!({"name":name,"type":c["type"],"nullable":c["nullable"]=="YES","default":if c["defaultValue"].is_null(){Value::Null}else{json!(c["defaultValue"].as_str().map(str::to_owned).unwrap_or(c["defaultValue"].to_string()))},"key":if pg||duck{if primary.contains(name){"PRI"}else if unique.contains(name){"UNI"}else{""}}else{c["columnKey"].as_str().unwrap_or("")},"extra":c["extra"].as_str().unwrap_or("")})}).collect::<Vec<_>>(),"indexes":indexes,"query":table_query,"mode":"live"}),
        )
    }
}
fn number(v: &Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}
pub(super) fn literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
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
pub(super) fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| err(503, "SOURCE_UNAVAILABLE"))?;
    file.write_all(bytes)
        .map_err(|_| err(503, "SOURCE_UNAVAILABLE"))?;
    Ok(())
}
