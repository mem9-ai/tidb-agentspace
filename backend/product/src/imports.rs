use super::*;

fn invalid() -> ServiceError {
    err(400, "INVALID_IMPORT")
}
fn exact(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|v| v.len() == keys.len() && keys.iter().all(|k| v.contains_key(*k)))
}
fn parsing(value: &Value) -> Result<Value> {
    match value["format"].as_str() {
        Some("csv")
            if exact(value, &["format", "header", "delimiter"])
                && value["header"].is_boolean()
                && [",", "\t", ";", "|"].contains(&value["delimiter"].as_str().unwrap_or("")) =>
        {
            Ok(value.clone())
        }
        Some("parquet") if exact(value, &["format"]) => Ok(value.clone()),
        _ => Err(invalid()),
    }
}
pub(super) struct DatabaseImportRequest<'a> {
    pub route: &'a str,
    pub query: &'a BTreeMap<String, String>,
    pub input: Value,
    pub raw: &'a [u8],
    pub upload: bool,
}
impl Product {
    pub(super) async fn database_import(
        &self,
        credential: &Credential,
        actor: &str,
        request: DatabaseImportRequest<'_>,
    ) -> Result<Value> {
        let DatabaseImportRequest {
            route,
            query,
            input,
            raw,
            upload,
        } = request;
        if route == "/database-imports" {
            if !exact(
                &input,
                &[
                    "resourceId",
                    "preparationId",
                    "confirmed",
                    "table",
                    "fields",
                ],
            ) || input["confirmed"] != true
            {
                return Err(invalid());
            }
            let resource_id = text(&input, "resourceId")?;
            let id = text(&input, "preparationId")?;
            {
                let map = self.preparations.lock().await;
                let entry = map
                    .get(id)
                    .filter(|e| {
                        e.actor == actor && e.expires > chrono::Utc::now().timestamp_millis()
                    })
                    .ok_or_else(|| err(409, "IMPORT_PREPARATION_UNAVAILABLE"))?;
                if entry.destination.as_deref() != Some(resource_id) {
                    return Err(err(409, "IMPORT_TARGET_MISMATCH"));
                }
            }
            return self.export(credential,actor,"/file-exports",json!({"preparationId":id,"confirmed":true,"fields":input["fields"],"target":{"kind":"database","resourceId":resource_id,"table":input["table"]}})).await;
        }

        let (resource_id, source, options) = if upload {
            let csv = query.get("format").map(String::as_str) == Some("csv");
            let keys = if csv {
                vec!["resourceId", "filename", "format", "header", "delimiter"]
            } else {
                vec!["resourceId", "filename", "format"]
            };
            if query.len() != keys.len() || !keys.iter().all(|k| query.contains_key(*k)) {
                return Err(invalid());
            }
            let resource_id = query
                .get("resourceId")
                .filter(|s| !s.is_empty())
                .ok_or_else(invalid)?
                .clone();
            let filename = query.get("filename").ok_or_else(invalid)?;
            if filename.is_empty()
                || filename.len() > 255
                || [".", ".."].contains(&filename.as_str())
                || filename
                    .chars()
                    .any(|c| c < ' ' || c == '\u{7f}' || c == '/' || c == '\\')
            {
                return Err(invalid());
            }
            if csv && !["true", "false"].contains(&query["header"].as_str()) {
                return Err(invalid());
            }
            let options = if csv {
                json!({"format":"csv","header":query["header"]=="true","delimiter":query["delimiter"]})
            } else {
                json!({"format":query["format"]})
            };
            let options = parsing(&options)?;
            if raw.len() > 1024 * 1024 {
                return Err(err(413, "FILE_TOO_LARGE"));
            }
            let source = json!({"kind":"upload","resourceId":resource_id,"filename":filename});
            (resource_id, source, options)
        } else {
            if !query.is_empty() {
                return Err(invalid());
            }
            if !exact(&input, &["resourceId", "source", "parsing"])
                || !exact(&input["source"], &["resourceId", "path"])
            {
                return Err(invalid());
            }
            let resource_id = text(&input, "resourceId")?.to_owned();
            let source_id = text(&input["source"], "resourceId")?;
            let path = clean_path(text(&input["source"], "path")?)?;
            (
                resource_id,
                json!({"kind":"original","resourceId":source_id,"path":path}),
                parsing(&input["parsing"])?,
            )
        };
        // Check the destination before reading a source or starting an Execute task.
        self.export_authorize(
            credential,
            &resource_id,
            &json!({"kind":"database","resourceId":resource_id}),
            false,
            false,
        )
        .await?;
        let source_id = text(&source, "resourceId")?;
        let resource = if upload {
            None
        } else {
            Some(
                self.export_authorize(
                    credential,
                    source_id,
                    &json!({"kind":"download"}),
                    false,
                    true,
                )
                .await?
                .1,
            )
        };
        let _slot = self
            .execute
            .analysis_slots
            .try_acquire()
            .map_err(|_| err(429, "ANALYSIS_BUSY"))?;
        let path = if upload {
            format!("/{}", text(&source, "filename")?)
        } else {
            text(&source, "path")?.to_owned()
        };
        let bytes = if let Some(resource) = resource {
            self.snapshot(credential, &resource, &path, false, 16 * 1024 * 1024)
                .await?
                .1
        } else {
            raw.to_vec()
        };
        self.prepare_import_rows(actor, source, &path, bytes, options, Some(resource_id))
            .await
    }
}
