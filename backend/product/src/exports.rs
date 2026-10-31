use super::files::{FileJob, LocalWrite};
use super::*;
#[derive(Default)]
struct DatabaseExportOptions<'a> {
    types: Option<&'a [String]>,
    preparation: Option<&'a str>,
    file_source: bool,
    database_import: bool,
}
use sha2::{Digest, Sha256};
#[derive(Clone)]
pub(super) struct Preparation {
    pub(super) actor: String,
    pub(super) destination: Option<String>,
    source: Value,
    version: String,
    parsed: Value,
    pub(super) expires: i64,
    used: bool,
}
fn invalid() -> ServiceError {
    err(400, "INVALID_EXPORT")
}
fn exact(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|v| v.len() == keys.len() && v.keys().all(|k| keys.contains(&k.as_str())))
}
fn known(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|v| v.keys().all(|k| keys.contains(&k.as_str())))
}
fn cell_text(v: &Value) -> String {
    v.as_str().map(str::to_owned).unwrap_or_else(|| {
        if v.is_number() {
            v.as_f64().unwrap_or(0.0).to_string()
        } else {
            v.to_string()
        }
    })
}
fn validate_result(result: &Value) -> Result<()> {
    if !exact(result, &["columns", "rows"]) {
        return Err(invalid());
    }
    let columns = result["columns"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 100)
        .ok_or_else(invalid)?;
    let mut names = BTreeSet::new();
    for c in columns {
        let c = c.as_str().filter(|v| !v.is_empty()).ok_or_else(invalid)?;
        if !names.insert(c) {
            return Err(invalid());
        }
    }
    let rows = result["rows"]
        .as_array()
        .filter(|v| v.len() <= 1000)
        .ok_or_else(invalid)?;
    fn valid(v: &Value, depth: usize) -> bool {
        depth <= 16
            && match v {
                Value::Array(a) => a.iter().all(|v| valid(v, depth + 1)),
                Value::Object(a) => a.values().all(|v| valid(v, depth + 1)),
                _ => true,
            }
    }
    for row in rows {
        if row
            .as_object()
            .is_none_or(|o| o.len() != names.len() || o.keys().any(|k| !names.contains(k.as_str())))
            || !valid(row, 0)
        {
            return Err(invalid());
        }
    }
    Ok(())
}
fn serialized(result: &Value, format: &str) -> Result<Value> {
    let columns = result["columns"].as_array().ok_or_else(invalid)?;
    let rows = result["rows"].as_array().ok_or_else(invalid)?;
    let jsonrow = |row: &Value| {
        format!(
            "{{{}}}",
            columns
                .iter()
                .map(|c| format!("{}:{}", c, row[c.as_str().unwrap_or("")]))
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    let csv = |v: &Value| {
        if v.is_null() {
            return String::new();
        }
        let mut text = cell_text(v);
        if v.is_string()
            && (text.starts_with(['\t', '\r', '\n'])
                || text
                    .trim_start_matches(|c: char| {
                        (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
                    })
                    .starts_with(['=', '+', '@', '-']))
        {
            text = format!("'{text}");
        }
        format!("\"{}\"", text.replace('"', "\"\""))
    };
    let content = match format {
        "json" => format!(
            "[{}]\n",
            rows.iter().map(jsonrow).collect::<Vec<_>>().join(",\n")
        ),
        "jsonl" => rows.iter().map(|r| jsonrow(r) + "\n").collect::<String>(),
        "csv" => {
            let mut lines = vec![columns.iter().map(csv).collect::<Vec<_>>().join(",")];
            for row in rows {
                lines.push(
                    columns
                        .iter()
                        .map(|c| csv(&row[c.as_str().unwrap_or("")]))
                        .collect::<Vec<_>>()
                        .join(","),
                );
            }
            lines.join("\r\n") + "\r\n"
        }
        _ => return Err(invalid()),
    };
    if content.len() > 4 * 1024 * 1024 {
        return Err(err(413, "EXPORT_TOO_LARGE"));
    }
    Ok(
        json!({"content":content,"bytes":content.len(),"format":format,"filename":format!("query-results.{format}"),"mimeType":match format{"csv"=>"text/csv;charset=utf-8","jsonl"=>"application/x-ndjson",_=>"application/json"}}),
    )
}
fn identifier(s: &str) -> Result<()> {
    if s.is_empty() || s.len() > 63 || s.chars().any(|c| c < ' ' || c == '\u{7f}') {
        return Err(invalid());
    }
    Ok(())
}
fn convert(v: &Value, t: &str) -> Result<Value> {
    if v.is_null() {
        return Ok(Value::Null);
    }
    let invalid = || err(400, "INVALID_IMPORT_FIELDS");
    match t {
        "TEXT" => Ok(json!(cell_text(v))),
        "BOOLEAN" => {
            if let Some(b) = v.as_bool() {
                Ok(json!(b))
            } else {
                match v.as_str().unwrap_or("").trim().to_lowercase().as_str() {
                    "true" => Ok(json!(true)),
                    "false" => Ok(json!(false)),
                    _ => Err(invalid()),
                }
            }
        }
        "BIGINT" => {
            if v.is_number()
                && v.as_f64()
                    .is_none_or(|n| n.fract() != 0.0 || n.abs() > 9007199254740991.0)
            {
                return Err(invalid());
            }
            Ok(json!(
                cell_text(v)
                    .trim()
                    .parse::<i64>()
                    .map_err(|_| invalid())?
                    .to_string()
            ))
        }
        "DOUBLE" => {
            let n = cell_text(v).trim().parse::<f64>().map_err(|_| invalid())?;
            if !n.is_finite() {
                return Err(invalid());
            }
            Ok(json!(n))
        }
        _ => Err(invalid()),
    }
}
fn plan(
    result: &Value,
    table: &str,
    kind: &str,
    types: Option<&[String]>,
) -> Result<(Value, String, Option<String>)> {
    identifier(table)?;
    let columns = result["columns"].as_array().ok_or_else(invalid)?;
    let rows = result["rows"].as_array().ok_or_else(invalid)?;
    if !["mysql", "postgresql", "duckdb"].contains(&kind) {
        return Err(invalid());
    }
    let quote = |s: &str| {
        if kind == "mysql" {
            format!("`{}`", s.replace('`', "``"))
        } else {
            format!("\"{}\"", s.replace('"', "\"\""))
        }
    };
    let mut folded = BTreeSet::new();
    let mut defs = vec![];
    for (i, c) in columns.iter().enumerate() {
        let name = c.as_str().ok_or_else(invalid)?;
        identifier(name)?;
        if !folded.insert(name.to_lowercase()) {
            return Err(invalid());
        }
        let values = rows
            .iter()
            .map(|r| &r[name])
            .filter(|v| !v.is_null())
            .collect::<Vec<_>>();
        let t = if let Some(types) = types {
            types.get(i).cloned().ok_or_else(invalid)?
        } else if !values.is_empty() && values.iter().all(|v| v.is_boolean()) {
            "BOOLEAN".into()
        } else if !values.is_empty() && values.iter().all(|v| v.is_number()) {
            if values.iter().all(|v| {
                v.as_f64()
                    .is_some_and(|v| v.fract() == 0.0 && v.abs() <= 9007199254740991.0)
            }) {
                "BIGINT".into()
            } else {
                "DOUBLE".into()
            }
        } else {
            "TEXT".into()
        };
        if !["TEXT", "BIGINT", "DOUBLE", "BOOLEAN"].contains(&t.as_str()) {
            return Err(invalid());
        }
        let native_type = if t == "TEXT" {
            match kind {
                "mysql" => "LONGTEXT",
                "duckdb" => "VARCHAR",
                _ => "TEXT",
            }
        } else if t == "DOUBLE" && kind == "postgresql" {
            "DOUBLE PRECISION"
        } else {
            &t
        };
        defs.push(json!({"name":name,"type":native_type}));
    }
    let create = format!(
        "CREATE TABLE {} ({});",
        quote(table),
        defs.iter()
            .map(|c| format!(
                "{} {}",
                quote(c["name"].as_str().unwrap_or("")),
                c["type"].as_str().unwrap_or("")
            ))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let mut literals = vec![];
    for row in rows {
        let mut fields = vec![];
        for (i, c) in columns.iter().enumerate() {
            let mut value = row[c.as_str().unwrap_or("")].clone();
            if let Some(types) = types {
                value = convert(&value, &types[i])?;
            }
            let t = defs[i]["type"].as_str().unwrap_or("");
            fields.push(if value.is_null() {
                "NULL".into()
            } else if t == "BOOLEAN" {
                if value == true { "TRUE" } else { "FALSE" }.into()
            } else if ["BIGINT", "DOUBLE", "DOUBLE PRECISION"].contains(&t) {
                cell_text(&value)
            } else {
                let text = cell_text(&value);
                if text.contains('\0') {
                    return Err(invalid());
                }
                let hex = hex::encode(text.as_bytes());
                match kind {
                    "mysql" => format!("CONVERT(X'{hex}' USING utf8mb4)"),
                    "postgresql" => format!("convert_from(decode('{hex}', 'hex'), 'UTF8')"),
                    _ => format!("decode(from_hex('{hex}'))"),
                }
            });
        }
        literals.push(format!("({})", fields.join(", ")));
    }
    let insert = if rows.is_empty() {
        None
    } else {
        Some(format!(
            "INSERT INTO {} ({}) VALUES {};",
            quote(table),
            columns
                .iter()
                .map(|c| quote(c.as_str().unwrap_or("")))
                .collect::<Vec<_>>()
                .join(", "),
            literals.join(", ")
        ))
    };
    if create.len() > 65536 || insert.as_ref().is_some_and(|s| s.len() > 65536) {
        return Err(err(413, "EXPORT_TOO_LARGE"));
    }
    Ok((json!(defs), create, insert))
}
impl Product {
    pub(super) async fn export_authorize(
        &self,
        credential: &Credential,
        source_id: &str,
        target: &Value,
        read_only: bool,
        file_source: bool,
    ) -> Result<(Principal, Value)> {
        let state = self.workspace.repository().read().await?;
        Self::export_authorize_state(
            &state,
            credential,
            source_id,
            target,
            read_only,
            file_source,
        )
    }
    fn export_authorize_state(
        state: &Value,
        credential: &Credential,
        source_id: &str,
        target: &Value,
        read_only: bool,
        file_source: bool,
    ) -> Result<(Principal, Value)> {
        let p = principal(state, credential)?;
        let source = p.resource(state, source_id, None)?;
        if file_source && source["kind"] != "filesystem" {
            return Err(err(400, "INVALID_EXPORT_SOURCE"));
        }
        for scope in if source["kind"] == "filesystem" {
            if read_only {
                vec!["files:read"]
            } else {
                vec!["files:read", "files:analyze"]
            }
        } else {
            vec!["queries:execute"]
        } {
            p.scope(scope)?;
        }
        if file_source && source["status"] != "active" {
            return Err(err(409, "FILESYSTEM_UNAVAILABLE"));
        }
        if target["kind"] == "download" {
            return Ok((p, source));
        }
        let destination = p.resource(
            state,
            text(target, "resourceId").map_err(|_| invalid())?,
            None,
        )?;
        if target["kind"] == "filesystem" {
            p.scope("files:write")?;
            if destination["kind"] != "filesystem"
                || !["local", DRIVE9].contains(&destination["provider"].as_str().unwrap_or("local"))
            {
                return Err(err(400, "INVALID_EXPORT_TARGET"));
            }
        } else {
            p.scope("queries:execute")?;
            if ![ZERO, DB9, DUCKDB].contains(&destination["provider"].as_str().unwrap_or(""))
                || destination["kind"] == "filesystem"
            {
                return Err(err(400, "INVALID_EXPORT_TARGET"));
            }
        }
        if destination["status"] != "active" {
            return Err(err(409, "EXPORT_TARGET_UNAVAILABLE"));
        }
        Ok((p, destination))
    }
    async fn export_file(
        &self,
        credential: &Credential,
        source: &str,
        target: &Value,
        content: &[u8],
        read_only: bool,
        file_source: bool,
    ) -> Result<Value> {
        let (p, r) = self
            .export_authorize(credential, source, target, read_only, file_source)
            .await?;
        let path = clean_path(text(target, "path")?)?;
        if path == "/" || path.chars().any(|c| c < ' ' || c == '\u{7f}') {
            return Err(invalid());
        }
        let id = text(&r, "id")?;
        let limit = if r["provider"] == DRIVE9 {
            1024 * 1024
        } else {
            256 * 1024
        };
        if content.len() > limit {
            return Err(err(413, "FILE_TOO_LARGE"));
        }
        if r["provider"] == DRIVE9 {
            self.providers
                .file_write(id, &path, content.to_vec(), true, || async {
                    self.export_authorize(credential, source, target, read_only, file_source)
                        .await?;
                    Ok(())
                })
                .await
                .map_err(|e| {
                    if ["FILE_CHANGED", "FILE_CONFLICT"].contains(&e.code.as_str()) {
                        err(409, "EXPORT_TARGET_EXISTS")
                    } else {
                        e
                    }
                })?;
        } else {
            self.write_local_authorized(
                credential,
                &r,
                LocalWrite {
                    path: &path,
                    kind: "file",
                    content: std::str::from_utf8(content)
                        .map_err(|_| err(422, "LOCAL_BINARY_UNSUPPORTED"))?,
                    create_only: true,
                },
                |state| {
                    Self::export_authorize_state(
                        state,
                        credential,
                        source,
                        target,
                        read_only,
                        file_source,
                    )?;
                    Ok(())
                },
            )
            .await?;
        }
        self.record(
            if file_source {
                "file.exported"
            } else {
                "result.exported"
            },
            &path,
            &p.actor,
            Some(id),
        )
        .await
        .map_err(|_| err(500, "EXPORT_RECORD_FAILED"))?;
        Ok(json!({"kind":"filesystem","resourceId":id,"path":path,"bytes":content.len()}))
    }
    pub(super) async fn export(
        &self,
        credential: &Credential,
        actor: &str,
        route: &str,
        input: Value,
    ) -> Result<Value> {
        if route == "/result-exports" {
            if !known(&input, &["sourceResourceId", "result", "target"])
                || !input["sourceResourceId"].is_string()
            {
                return Err(invalid());
            }
            validate_result(&input["result"])?;
            if input.to_string().len() > 1024 * 1024 {
                return Err(err(413, "EXPORT_TOO_LARGE"));
            }
            let target = &input["target"];
            let source = text(&input, "sourceResourceId")?;
            let kind = text(target, "kind").map_err(|_| invalid())?;
            let keys = match kind {
                "download" => vec!["kind", "format"],
                "filesystem" => vec!["kind", "resourceId", "path", "format"],
                "database" => vec!["kind", "resourceId", "table"],
                _ => return Err(invalid()),
            };
            if !exact(target, &keys) {
                return Err(invalid());
            }
            let (_, resource) = self
                .export_authorize(credential, source, target, false, false)
                .await?;
            if kind == "database" {
                return self
                    .export_database(
                        credential,
                        source,
                        target,
                        &input["result"],
                        DatabaseExportOptions::default(),
                    )
                    .await;
            }
            let artifact = serialized(
                &input["result"],
                text(target, "format").map_err(|_| invalid())?,
            )?;
            let count = input["result"]["rows"].as_array().expect("rows").len();
            if kind == "download" {
                let mut v = artifact;
                v["kind"] = json!("download");
                v["rowCount"] = json!(count);
                return Ok(v);
            }
            let _ = resource;
            let mut v = self
                .export_file(
                    credential,
                    source,
                    target,
                    text(&artifact, "content")?.as_bytes(),
                    false,
                    false,
                )
                .await?;
            v["format"] = target["format"].clone();
            v["rowCount"] = json!(count);
            return Ok(v);
        }
        if input.get("preparationId").is_some() {
            if !exact(&input, &["preparationId", "confirmed", "fields", "target"])
                || input["confirmed"] != true
                || !exact(&input["target"], &["kind", "resourceId", "table"])
                || input["target"]["kind"] != "database"
            {
                return Err(invalid());
            }
            let id = text(&input, "preparationId")?;
            let entry = {
                let map = self.preparations.lock().await;
                map.get(id)
                    .filter(|e| {
                        e.actor == actor && e.expires > chrono::Utc::now().timestamp_millis()
                    })
                    .cloned()
                    .ok_or_else(|| err(409, "IMPORT_PREPARATION_UNAVAILABLE"))?
            };
            if entry.used {
                return Err(err(409, "IMPORT_ALREADY_COMMITTED"));
            }
            if entry
                .destination
                .as_ref()
                .is_some_and(|id| input["target"]["resourceId"].as_str() != Some(id))
            {
                return Err(err(409, "IMPORT_TARGET_MISMATCH"));
            }
            let file_source = entry.source["kind"] != "upload";
            let source = text(&entry.source, "resourceId")?;
            self.export_authorize(credential, source, &input["target"], false, file_source)
                .await?;
            let (fields, result, types) = mapped_fields(&entry.parsed, &input["fields"])?;
            let _ = fields;
            if entry.source["kind"] == "original" {
                let (_, r) = self
                    .export_authorize(credential, source, &json!({"kind":"download"}), false, true)
                    .await?;
                let (_, bytes) = self
                    .snapshot(
                        credential,
                        &r,
                        text(&entry.source, "path")?,
                        false,
                        16 * 1024 * 1024,
                    )
                    .await?;
                if hex::encode(Sha256::digest(bytes)) != entry.version {
                    return Err(err(409, "FILE_CHANGED"));
                }
            }
            return self
                .export_database(
                    credential,
                    source,
                    &input["target"],
                    &result,
                    DatabaseExportOptions {
                        types: Some(&types),
                        preparation: Some(id),
                        file_source,
                        database_import: entry.destination.is_some(),
                    },
                )
                .await;
        }
        let prepare = route == "/file-exports/prepare";
        if !exact(
            &input,
            if prepare {
                &["source", "parsing"]
            } else {
                &["source", "target"]
            },
        ) {
            return Err(invalid());
        }
        let mut source = input["source"].clone();
        let original = source["kind"] == "original";
        if original {
            if !exact(&source, &["kind", "resourceId", "path"]) {
                return Err(invalid());
            }
            source["path"] = json!(clean_path(text(&source, "path")?)?);
        } else if source["kind"] != "output"
            || !exact(&source, &["kind", "resourceId", "stream", "text"])
            || !["stdout", "stderr"].contains(&source["stream"].as_str().unwrap_or(""))
            || !source["text"].is_string()
        {
            return Err(invalid());
        }
        let source_id = text(&source, "resourceId")?;
        let download_target = json!({"kind":"download"});
        let (_, resource) = self
            .export_authorize(
                credential,
                source_id,
                if prepare {
                    &download_target
                } else {
                    &input["target"]
                },
                original && !prepare,
                true,
            )
            .await?;
        if prepare {
            let parsing = &input["parsing"];
            let format = text(parsing, "format").map_err(|_| invalid())?;
            match format {
                "csv" => {
                    if !exact(parsing, &["format", "header", "delimiter"])
                        || !parsing["header"].is_boolean()
                        || ![",", "\t", ";", "|"]
                            .contains(&parsing["delimiter"].as_str().unwrap_or(""))
                    {
                        return Err(invalid());
                    }
                }
                "lines" | "parquet" => {
                    if !exact(parsing, &["format"]) || (!original && format == "parquet") {
                        return Err(invalid());
                    }
                }
                _ => return Err(invalid()),
            }
            let _slot = self
                .execute
                .analysis_slots
                .try_acquire()
                .map_err(|_| err(429, "ANALYSIS_BUSY"))?;
            let path = if original {
                text(&source, "path")?
            } else {
                "/command-output.txt"
            };
            let bytes = if original {
                self.snapshot(credential, &resource, path, false, 16 * 1024 * 1024)
                    .await?
                    .1
            } else {
                let bytes = text(&source, "text")?.as_bytes().to_vec();
                if bytes.len() > 1024 * 1024 {
                    return Err(err(413, "EXPORT_TOO_LARGE"));
                }
                bytes
            };
            return self
                .prepare_import_rows(actor, source.clone(), path, bytes, parsing.clone(), None)
                .await;
        }
        let target = &input["target"];
        if target["kind"] == "download" {
            if original || !exact(target, &["kind"]) {
                return Err(invalid());
            }
            let content = text(&source, "text")?;
            if content.len() > 1024 * 1024 {
                return Err(err(413, "EXPORT_TOO_LARGE"));
            }
            return Ok(
                json!({"kind":"download","filename":format!("command-{}.txt",text(&source,"stream")?),"mimeType":"text/plain;charset=utf-8","content":content,"bytes":content.len()}),
            );
        }
        if target["kind"] != "filesystem" || !exact(target, &["kind", "resourceId", "path"]) {
            return Err(invalid());
        }
        let content = if original {
            self.snapshot(
                credential,
                &resource,
                text(&source, "path")?,
                false,
                1024 * 1024,
            )
            .await?
            .1
        } else {
            text(&source, "text")?.as_bytes().to_vec()
        };
        self.export_file(credential, source_id, target, &content, original, true)
            .await
    }
    pub(super) async fn prepare_import_rows(
        &self,
        actor: &str,
        source: Value,
        path: &str,
        bytes: Vec<u8>,
        parsing: Value,
        destination: Option<String>,
    ) -> Result<Value> {
        let source_id = text(&source, "resourceId")?;
        let format = text(&parsing, "format")?;
        let parsed = self
            .execute_file(FileJob {
                resource_id: source_id,
                path,
                bytes,
                mode: "import",
                engine: "duckdb",
                format,
                script: "",
                parsing: Some(parsing.clone()),
            })
            .await?;
        validate_result(&json!({"columns":parsed["columns"],"rows":parsed["rows"]}))?;
        let fields = suggested_fields(&parsed, format);
        let expires = chrono::Utc::now().timestamp_millis() + 300000;
        let id = uuid::Uuid::new_v4().to_string();
        let version = text(&parsed, "fileVersion")?.to_owned();
        let entry = Preparation {
            actor: actor.into(),
            destination,
            source: source.clone(),
            version: version.clone(),
            parsed: parsed.clone(),
            expires,
            used: false,
        };
        let mut map = self.preparations.lock().await;
        map.retain(|_, v| v.expires > chrono::Utc::now().timestamp_millis());
        while map.len() >= 8 {
            if let Some(key) = map
                .iter()
                .min_by_key(|(_, e)| e.expires)
                .map(|(k, _)| k.clone())
            {
                map.remove(&key);
            }
        }
        map.insert(id.clone(), entry);
        Ok(
            json!({"preparationId":id,"expiresAt":chrono::DateTime::from_timestamp_millis(expires).map(|d|d.to_rfc3339_opts(chrono::SecondsFormat::Millis,true)),"fields":fields,"rows":parsed["rows"].as_array().expect("rows").iter().take(20).collect::<Vec<_>>(),"rowCount":parsed["rows"].as_array().expect("rows").len(),"sourceVersion":version,"inputBytes":parsed["inputBytes"],"format":format}),
        )
    }
    async fn export_database(
        &self,
        credential: &Credential,
        source: &str,
        target: &Value,
        result: &Value,
        options: DatabaseExportOptions<'_>,
    ) -> Result<Value> {
        let DatabaseExportOptions {
            types,
            preparation,
            file_source,
            database_import,
        } = options;
        let (p, r) = self
            .export_authorize(credential, source, target, false, file_source)
            .await?;
        let table = text(target, "table")?;
        let (columns, create, insert) = plan(result, table, text(&r, "kind")?, types)?;
        if let Some(id) = preparation {
            let mut map = self.preparations.lock().await;
            let entry = map
                .get_mut(id)
                .ok_or_else(|| err(409, "IMPORT_PREPARATION_UNAVAILABLE"))?;
            if entry.used {
                return Err(err(409, "IMPORT_ALREADY_COMMITTED"));
            }
            if entry.expires <= chrono::Utc::now().timestamp_millis() {
                return Err(err(409, "IMPORT_PREPARATION_UNAVAILABLE"));
            }
            entry.used = true;
        }
        if let Err(e) = self
            .execute_database_with_mode(&r, &create, false, json!([]), database_import)
            .await
        {
            if e.code == "SQL_TABLE_EXISTS"
                && let Some(id) = preparation
                && let Some(entry) = self.preparations.lock().await.get_mut(id)
            {
                entry.used = false;
            }
            return Err(e);
        }
        if let Some(insert) = insert {
            let inserted = async {
                self.export_authorize(credential, source, target, false, file_source)
                    .await?;
                self.execute_database_with_mode(&r, &insert, false, json!([]), database_import)
                    .await
            }
            .await;
            if inserted.is_err() {
                return Err(err(502, "EXPORT_INCOMPLETE"));
            }
        }
        self.record(
            if database_import {
                "database.imported"
            } else if file_source {
                "file.exported"
            } else {
                "result.exported"
            },
            table,
            &p.actor,
            Some(text(&r, "id")?),
        )
        .await
        .map_err(|_| err(500, "EXPORT_RECORD_FAILED"))?;
        Ok(
            json!({"kind":"database","resourceId":r["id"],"table":table,"columns":columns,"rowCount":result["rows"].as_array().map(Vec::len).unwrap_or(0)}),
        )
    }
}
fn suggested_fields(parsed: &Value, format: &str) -> Value {
    let integer = regex::Regex::new(r"^(0|-?[1-9]\d*)$").expect("regex");
    json!(
        parsed["columns"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let values = parsed["rows"]
                    .as_array()
                    .unwrap_or(&vec![])
                    .iter()
                    .map(|r| r[c.as_str().unwrap_or("")].clone())
                    .filter(|v| !v.is_null())
                    .collect::<Vec<_>>();
                let hint = parsed["columnTypes"][i].as_str().unwrap_or("");
                let t = if (format == "parquet" && hint == "BOOLEAN")
                    || (!values.is_empty()
                        && values
                            .iter()
                            .all(|v| v.is_boolean() || [json!("true"), json!("false")].contains(v)))
                {
                    "BOOLEAN"
                } else if (!values.is_empty()
                    || (format == "parquet"
                        && [
                            "TINYINT",
                            "SMALLINT",
                            "INTEGER",
                            "BIGINT",
                            "UTINYINT",
                            "USMALLINT",
                            "UINTEGER",
                        ]
                        .contains(&hint)))
                    && values
                        .iter()
                        .all(|v| integer.is_match(&cell_text(v)) && convert(v, "BIGINT").is_ok())
                {
                    "BIGINT"
                } else if format == "parquet"
                    && ["FLOAT", "DOUBLE", "REAL"].contains(&hint)
                    && values.iter().all(Value::is_number)
                {
                    "DOUBLE"
                } else {
                    "TEXT"
                };
                json!({"source":c,"name":c,"type":t})
            })
            .collect::<Vec<_>>()
    )
}
fn mapped_fields(parsed: &Value, fields: &Value) -> Result<(Value, Value, Vec<String>)> {
    let input = fields
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 100)
        .ok_or_else(|| err(400, "INVALID_IMPORT_FIELDS"))?;
    let known = parsed["columns"].as_array().ok_or_else(invalid)?;
    let mut sources = BTreeSet::new();
    let mut names = BTreeSet::new();
    let mut columns = vec![];
    let mut types = vec![];
    for f in input {
        if !exact(f, &["source", "name", "type"]) {
            return Err(err(400, "INVALID_IMPORT_FIELDS"));
        }
        let source = text(f, "source")?;
        let name = text(f, "name")?;
        let t = text(f, "type")?;
        if !known.contains(&json!(source))
            || !sources.insert(source)
            || name.trim().is_empty()
            || identifier(name).is_err()
            || !names.insert(name.to_lowercase())
            || !["TEXT", "BIGINT", "DOUBLE", "BOOLEAN"].contains(&t)
        {
            return Err(err(400, "INVALID_IMPORT_FIELDS"));
        }
        columns.push(name);
        types.push(t.to_owned());
    }
    let mut rows = vec![];
    for row in parsed["rows"].as_array().ok_or_else(invalid)? {
        let mut mapped = serde_json::Map::new();
        for f in input {
            mapped.insert(
                text(f, "name")?.into(),
                convert(&row[text(f, "source")?], text(f, "type")?)?,
            );
        }
        rows.push(Value::Object(mapped));
    }
    Ok((
        fields.clone(),
        json!({"columns":columns,"rows":rows}),
        types,
    ))
}
