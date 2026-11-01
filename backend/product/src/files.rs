use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::Method;
use sha2::{Digest, Sha256};
use workspace_providers::{bounded, fs_path};
const LIMIT: usize = 16 * 1024 * 1024;
const IMAGE_PREVIEW_LIMIT: usize = 1024 * 1024;

fn image_preview_type(path: &str) -> Option<&'static str> {
    match path.rsplit('.').next()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn matches_image_signature(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    }
}
pub(super) struct FileRequest<'a> {
    pub method: &'a str,
    pub route: &'a str,
    pub query: &'a BTreeMap<String, String>,
    pub input: Value,
    pub raw: &'a [u8],
    pub if_match: Option<&'a str>,
    pub if_none_match: Option<&'a str>,
}
pub(super) struct LocalWrite<'a> {
    pub path: &'a str,
    pub kind: &'a str,
    pub content: &'a str,
    pub create_only: bool,
    pub expected_version: Option<&'a str>,
}
pub(super) struct FileJob<'a> {
    pub resource_id: &'a str,
    pub path: &'a str,
    pub bytes: Vec<u8>,
    pub mode: &'a str,
    pub engine: &'a str,
    pub format: &'a str,
    pub script: &'a str,
    pub parsing: Option<Value>,
}
impl Product {
    pub(super) async fn files(
        &self,
        credential: &Credential,
        p: &Principal,
        request: FileRequest<'_>,
    ) -> Result<(u16, Reply)> {
        let FileRequest {
            method,
            route,
            query: q,
            input,
            raw,
            if_match,
            if_none_match,
        } = request;
        let read = method == "GET";
        if if_match.is_some() && if_none_match.is_some()
            || if_none_match.is_some_and(|v| v != "*")
            || if_match.is_some_and(|v| !valid_etag(v))
        {
            return Err(err(400, "INVALID_PRECONDITION"));
        }
        let create_only = if_none_match == Some("*");
        if method != "PUT" && (if_match.is_some() || if_none_match.is_some()) {
            return Err(err(400, "INVALID_PRECONDITION"));
        }
        let resource_id = if ["/files/content", "/files/entry"].contains(&route) || read {
            q.get("resourceId")
                .map(String::as_str)
                .ok_or_else(|| err(404, "NOT_FOUND"))?
        } else {
            text(&input, "resourceId")?
        };
        let (_, r) = self
            .context(
                credential,
                if read { "files:read" } else { "files:write" },
                Some((resource_id, Some("filesystem"))),
            )
            .await?;
        let _mutation = if !read && r["provider"] == DRIVE9 {
            Some(
                self.file_mutations[resource_locks::stripe(resource_id)]
                    .lock()
                    .await,
            )
        } else {
            None
        };
        if read && route == "/files" {
            let path = q.get("path").map(|p| clean_path(p)).transpose()?;
            if r["provider"] == DRIVE9 {
                return Ok((
                    200,
                    Reply::Json(
                        json!({"data":self.providers.file_list(resource_id,path.as_deref().unwrap_or("/")).await?,"nextCursor":null}),
                    ),
                ));
            }
            let limit = q
                .get("limit")
                .map(|value| value.parse::<usize>())
                .transpose()
                .map_err(|_| err(400, "INVALID_LIMIT"))?
                .unwrap_or(32);
            if !(1..=32).contains(&limit) {
                return Err(err(400, "INVALID_LIMIT"));
            }
            let (files, next) = self
                .workspace
                .repository()
                .local_file_page(
                    resource_id,
                    path.as_deref().unwrap_or("/"),
                    q.get("cursor").map(String::as_str),
                    limit,
                )
                .await?;
            self.context(
                credential,
                "files:read",
                Some((resource_id, Some("filesystem"))),
            )
            .await?;
            let data = files.into_iter().map(file_view).collect::<Vec<_>>();
            return Ok((200, Reply::Json(json!({"data":data,"nextCursor":next}))));
        }
        let path = clean_path(
            if ["/files/content", "/files/metadata", "/files/entry"].contains(&route) {
                q.get("path").map(String::as_str).unwrap_or("")
            } else {
                text(&input, "path")?
            },
        )?;
        if path == "/" {
            return Err(err(400, "INVALID_PATH"));
        }
        if route == "/files/metadata" {
            let mut data = if r["provider"] == DRIVE9 {
                self.providers.file_stat(resource_id, &path).await?
            } else {
                self.workspace
                    .repository()
                    .local_file(resource_id, &path, credential)
                    .await?
            };
            let version = if r["provider"] == DRIVE9 {
                provider_version(&data)
            } else {
                Some(local_version(&data))
            };
            data = json!({"resourceId":resource_id,"path":path,"type":if data["directory"]==true||data["type"]=="directory"{"directory"}else{"file"},"size":if r["provider"]==DRIVE9 {data["size"].clone()}else{json!(data["content"].as_str().unwrap_or("").len())},"version":version,"conditionalWrites":version.is_some()&&data["type"]!="directory"&&data["directory"]!=true});
            return Ok((
                200,
                match version {
                    Some(etag) => Reply::Entity {
                        value: json!({"data":data}),
                        etag,
                    },
                    None => Reply::Json(json!({"data":data})),
                },
            ));
        }
        let expected_revision = if r["provider"] == DRIVE9 && if_match.is_some() {
            let stat = self
                .providers
                .file_stat(resource_id, &path)
                .await
                .map_err(|e| {
                    if e.status == 404 {
                        err(412, "PRECONDITION_FAILED")
                    } else {
                        e
                    }
                })?;
            if stat["directory"] == true {
                return Err(err(400, "DIRECTORY_PRECONDITION_UNSUPPORTED"));
            }
            let version =
                provider_version(&stat).ok_or_else(|| err(409, "FILE_VERSION_UNAVAILABLE"))?;
            if Some(version.as_str()) != if_match {
                return Err(err(412, "PRECONDITION_FAILED"));
            }
            Some(text(&stat, "dataRevision")?.to_owned())
        } else {
            None
        };
        if route == "/files/content" {
            if r["provider"] != DRIVE9 {
                if read && q.get("preview").map(String::as_str) == Some("1") {
                    let file = self
                        .workspace
                        .repository()
                        .local_file(resource_id, &path, credential)
                        .await?;
                    if file["type"] == "directory" {
                        return Err(err(400, "NOT_A_FILE"));
                    }
                    let content = file["content"].as_str().unwrap_or("");
                    return Ok((
                        200,
                        Reply::Json(json!({"size":content.len(),"content":content})),
                    ));
                }
                return Err(err(400, "LOCAL_FILE_API"));
            }
            if read {
                let info = self.providers.file_stat(resource_id, &path).await?;
                if info["directory"] == true {
                    return Err(err(400, "NOT_A_FILE"));
                }
                let size = info["size"].as_u64().unwrap_or(0);
                if q.get("preview").map(String::as_str) == Some("1") {
                    let unavailable = |reason: &str| {
                        Ok((
                            200,
                            Reply::Json(json!({"size":size,"unavailableReason":reason})),
                        ))
                    };
                    let image_type = image_preview_type(&path);
                    let preview_limit = if image_type.is_some() {
                        IMAGE_PREVIEW_LIMIT
                    } else {
                        128 * 1024
                    };
                    if size > preview_limit as u64 {
                        if image_type.is_some() {
                            return unavailable("This image exceeds the 1 MiB preview limit.");
                        }
                        return unavailable(
                            "This file exceeds the 128 KiB preview limit. Download it to view locally.",
                        );
                    }
                    let response = self
                        .providers
                        .file_request(Some(resource_id), &fs_path(&path), Method::GET, None, &[])
                        .await?;
                    let bytes = match bounded(response, preview_limit).await {
                        Ok(v) => v,
                        Err(e) if e.code == "CONTENT_TOO_LARGE" => {
                            return unavailable(
                                "The file grew beyond the preview limit. Download it to view locally.",
                            );
                        }
                        Err(e) => return Err(e),
                    };
                    if let Some(mime) = image_type {
                        if !matches_image_signature(mime, &bytes) {
                            return unavailable(
                                "This image is invalid or does not match its file type.",
                            );
                        }
                        return Ok((
                            200,
                            Reply::Json(
                                json!({"size":bytes.len(),"image":{"mimeType":mime,"base64":STANDARD.encode(&bytes)},"unavailableReason":"This image cannot be displayed by this version. Download it to open in another application."}),
                            ),
                        ));
                    }
                    if bytes.iter().any(|b| *b < 9 || (*b > 13 && *b < 32)) {
                        return unavailable(
                            "This binary file cannot be previewed. Download it to open in another application.",
                        );
                    }
                    let text = match std::str::from_utf8(&bytes) {
                        Ok(t) => t.trim_start_matches('\u{feff}'),
                        Err(_) => {
                            return unavailable(
                                "This binary file cannot be previewed. Download it to open in another application.",
                            );
                        }
                    };
                    return Ok((200, Reply::Json(json!({"size":bytes.len(),"content":text}))));
                }
                let response = self
                    .providers
                    .file_request(Some(resource_id), &fs_path(&path), Method::GET, None, &[])
                    .await?;
                return Ok((
                    200,
                    Reply::Download {
                        response,
                        size,
                        filename: path.rsplit('/').next().unwrap_or("download").into(),
                    },
                ));
            }
            if raw.len() > 1024 * 1024 {
                return Err(err(413, "FILE_TOO_LARGE"));
            }
            self.context(
                credential,
                "files:write",
                Some((resource_id, Some("filesystem"))),
            )
            .await?;
            self.providers
                .file_write(
                    resource_id,
                    &path,
                    raw.to_vec(),
                    create_only,
                    expected_revision.as_deref(),
                    || async {
                        self.context(
                            credential,
                            "files:write",
                            Some((resource_id, Some("filesystem"))),
                        )
                        .await?;
                        Ok(())
                    },
                )
                .await?;
            self.record("file.uploaded", &path, &p.actor, Some(resource_id))
                .await?;
            return Ok((200, Reply::Json(json!({"saved":true,"size":raw.len()}))));
        }
        if method == "DELETE" {
            if r["provider"] == DRIVE9 {
                self.providers
                    .file_request(
                        Some(resource_id),
                        &fs_path(&path),
                        Method::DELETE,
                        None,
                        &[],
                    )
                    .await?;
                self.record("file.deleted", &path, &p.actor, Some(resource_id))
                    .await?;
            } else {
                self.workspace
                    .repository()
                    .local_file_transaction(
                        vec![resource_id.into()],
                        resource_id,
                        vec![path.clone()],
                        credential,
                        |state| {
                            let p = principal(state, credential)?;
                            p.scope("files:write")?;
                            p.resource(state, resource_id, Some("filesystem"))?;
                            let files = state["files"].as_array_mut().expect("files");
                            if !files
                                .iter()
                                .any(|f| f["resourceId"] == resource_id && f["path"] == path)
                            {
                                return Err(err(404, "NOT_FOUND"));
                            }
                            files
                                .retain(|f| !(f["resourceId"] == resource_id && f["path"] == path));
                            event(state, "file.deleted", &path, &p.actor, Some(resource_id));
                            Ok(((), true))
                        },
                    )
                    .await?;
            }
            return Ok((200, Reply::Json(json!({"deleted":true}))));
        }
        let kind = text(&input, "type").map_err(|_| err(400, "INVALID_TYPE"))?;
        if !["file", "directory"].contains(&kind) {
            return Err(err(400, "INVALID_TYPE"));
        }
        let content = input["content"].as_str().unwrap_or("");
        if kind == "file" && (!input["content"].is_string() || content.len() > 256 * 1024) {
            return Err(err(413, "FILE_TOO_LARGE"));
        }
        if kind == "directory" && (if_match.is_some() || create_only) {
            return Err(err(400, "DIRECTORY_PRECONDITION_UNSUPPORTED"));
        }
        if r["provider"] == DRIVE9 {
            if kind == "directory" {
                self.providers
                    .file_request(
                        Some(resource_id),
                        &(fs_path(&path) + "?mkdir=1"),
                        Method::POST,
                        None,
                        &[],
                    )
                    .await?;
            } else {
                self.providers
                    .file_write(
                        resource_id,
                        &path,
                        content.as_bytes().to_vec(),
                        create_only,
                        expected_revision.as_deref(),
                        || async {
                            self.context(
                                credential,
                                "files:write",
                                Some((resource_id, Some("filesystem"))),
                            )
                            .await?;
                            Ok(())
                        },
                    )
                    .await?;
            }
            self.record(
                if kind == "directory" {
                    "directory.created"
                } else {
                    "file.saved"
                },
                &path,
                &p.actor,
                Some(resource_id),
            )
            .await?;
            return Ok((
                200,
                Reply::Json(
                    json!({"data":{"id":format!("{resource_id}:{path}"),"resourceId":resource_id,"path":path,"type":kind,"size":if kind=="file"{content.len()}else{0},"updatedAt":timestamp()}}),
                ),
            ));
        }
        let file = self
            .write_local_authorized(
                credential,
                &r,
                &[],
                LocalWrite {
                    path: &path,
                    kind,
                    content,
                    create_only,
                    expected_version: if_match,
                },
                |_| Ok(()),
            )
            .await
            .map_err(|e| {
                if create_only && e.code == "EXPORT_TARGET_EXISTS" {
                    err(412, "PRECONDITION_FAILED")
                } else {
                    e
                }
            })?;
        Ok((200, Reply::Json(json!({"data":file}))))
    }
    pub(super) async fn write_local_authorized(
        &self,
        credential: &Credential,
        r: &Value,
        related_resource_ids: &[String],
        write: LocalWrite<'_>,
        authorize: impl Fn(&Value) -> Result<()> + Send + Sync,
    ) -> Result<Value> {
        let LocalWrite {
            path,
            kind,
            content,
            create_only,
            expected_version,
        } = write;
        let id = text(r, "id")?;
        let mut selected = related_resource_ids.to_vec();
        selected.push(id.to_owned());
        self.workspace.repository().local_file_transaction(selected, id, vec![path.into(), parent(path)], credential, |state|{authorize(state)?;
let p=principal(state,credential)?;p.scope("files:write")?;p.resource(state,id,Some("filesystem"))?;
let files=state["files"].as_array_mut().expect("files");
let dir=parent(path);
if dir!="/"&&!files.iter().any(|f|f["resourceId"]==id&&f["path"]==dir&&f["type"]=="directory"){return Err(err(404,"PARENT_MISSING"));}
let position=files.iter().position(|f|f["resourceId"]==id&&f["path"]==path);
if expected_version.is_some_and(|v|position.is_none_or(|i|local_version(&files[i])!=v)){return Err(err(412,"PRECONDITION_FAILED"));}
if create_only&&position.is_some(){return Err(err(409,"EXPORT_TARGET_EXISTS"));}
if position.is_some_and(|i|files[i]["type"]!=kind){return Err(err(409,"TYPE_CONFLICT"));}
let mut f=json!({"version":format!("\"{}\"",secret(24)?),"id":position.map(|i|files[i]["id"].clone()).unwrap_or(json!(uuid::Uuid::new_v4().to_string())),"resourceId":id,"path":path,"type":kind,"updatedAt":timestamp()});
if kind=="file"{f["content"]=json!(content);}
if let Some(i)=position{for(k,v)in f.as_object().expect("file"){files[i][k]=v.clone();}f=files[i].clone();}else{files.push(f.clone());}
if !create_only{event(state,if position.is_some(){"file.updated"}else{"file.created"},path,&p.actor,Some(id));}
Ok((file_view(f),true))}).await
    }
    pub(super) async fn snapshot(
        &self,
        credential: &Credential,
        r: &Value,
        path: &str,
        metadata_only: bool,
        limit: usize,
    ) -> Result<(Value, Vec<u8>)> {
        let id = text(r, "id")?;
        self.context(credential, "files:read", Some((id, Some("filesystem"))))
            .await?;
        if r["provider"] == DRIVE9 {
            let before = self.providers.file_stat(id, path).await?;
            if before["directory"] == true {
                return Err(err(400, "NOT_A_FILE"));
            }
            if metadata_only {
                let mut v = before;
                v["versionAvailable"] = json!(v["revision"].is_string());
                return Ok((v, vec![]));
            }
            let size = before["size"].as_u64().unwrap_or(0) as usize;
            if size > limit {
                return Err(err(413, "ANALYSIS_INPUT_LIMIT"));
            }
            let revision = before["revision"]
                .as_str()
                .ok_or_else(|| err(409, "FILE_VERSION_UNAVAILABLE"))?;
            let response = self
                .providers
                .file_request(
                    Some(id),
                    &fs_path(path),
                    Method::GET,
                    None,
                    &[("If-Match", revision.into())],
                )
                .await?;
            let bytes = bounded(response, limit.min(size)).await.map_err(|e| {
                if e.code == "CONTENT_TOO_LARGE" {
                    err(413, "ANALYSIS_INPUT_LIMIT")
                } else {
                    e
                }
            })?;
            let after = self.providers.file_stat(id, path).await?;
            if bytes.len() != size
                || after["size"] != before["size"]
                || after["revision"] != before["revision"]
            {
                return Err(err(409, "FILE_CHANGED"));
            }
            self.context(credential, "files:read", Some((id, Some("filesystem"))))
                .await?;
            return Ok((json!({"size":size}), bytes));
        }
        let file = self
            .workspace
            .repository()
            .local_file(id, path, credential)
            .await?;
        if file["type"] == "directory" {
            return Err(err(400, "NOT_A_FILE"));
        }
        let bytes = file["content"].as_str().unwrap_or("").as_bytes().to_vec();
        if !metadata_only && bytes.len() > limit {
            return Err(err(413, "ANALYSIS_INPUT_LIMIT"));
        }
        Ok((json!({"size":bytes.len()}), bytes))
    }
    pub(super) async fn analysis(
        &self,
        credential: &Credential,
        route: &str,
        input: Value,
    ) -> Result<Value> {
        let resource_id = text(&input, "resourceId")?;
        let (_, resource) = self
            .context(
                credential,
                "files:read",
                Some((resource_id, Some("filesystem"))),
            )
            .await?;
        let path = clean_path(text(&input, "path")?)?;
        if resource["status"] != "active" {
            return Err(err(409, "FILESYSTEM_UNAVAILABLE"));
        }
        let format = format(&path);
        if route == "/file-analyses/capabilities" {
            let (info, _) = self
                .snapshot(credential, &resource, &path, true, LIMIT)
                .await?;
            let size = info["size"].as_u64().unwrap_or(0);
            let reason = if format.is_none() {
                "This file type is not supported for analysis. Download it to use another tool."
            } else if size > LIMIT as u64 {
                "This file exceeds the 16 MiB analysis limit. Download it to analyze locally."
            } else if info["versionAvailable"] == false {
                "The file version cannot be verified. Download it to analyze locally."
            } else {
                ""
            };
            let engines = format
                .as_ref()
                .map(|f| {
                    f.1.iter()
                        .map(|e| {
                            let reason = if reason.is_empty() && size == 0 && *e == "duckdb" {
                                "This file is empty. Add tabular data before running a query."
                            } else {
                                reason
                            };
                            let mut v =
                                json!({"engine":e,"available":reason.is_empty(),"reason":reason});
                            if *e == "bash" {
                                v["input"] = bash_input(&path);
                            }
                            v
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let default = format.as_ref().map(|f| f.1[0]);
            let preferred = engines.first();
            return Ok(
                json!({"engine":default,"engines":engines,"format":format.as_ref().map(|f|f.0),"size":size,"available":preferred.is_some_and(|e|e["available"]==true),"reason":preferred.map(|e|e["reason"].clone()).unwrap_or(json!(reason)),"readOnly":true,"limits":analysis_limits()}),
            );
        }
        let preview = route == "/files/tabular-preview";
        if preview {
            if input.as_object().is_none_or(|v| {
                v.keys()
                    .any(|k| !["resourceId", "path"].contains(&k.as_str()))
            }) {
                return Err(err(400, "INVALID_PREVIEW"));
            }
            if !format
                .as_ref()
                .is_some_and(|f| ["csv", "parquet"].contains(&f.0))
            {
                return Err(err(422, "UNSUPPORTED_PREVIEW"));
            }
        } else {
            self.context(
                credential,
                "files:analyze",
                Some((resource_id, Some("filesystem"))),
            )
            .await?;
        }
        let (format, engines) = format.ok_or_else(|| err(422, "UNSUPPORTED_ANALYSIS"))?;
        let engine = if preview {
            "duckdb"
        } else {
            text(&input, "engine").map_err(|_| err(422, "UNSUPPORTED_ANALYSIS"))?
        };
        if !engines.contains(&engine) {
            return Err(err(422, "UNSUPPORTED_ANALYSIS"));
        }
        let script = if preview {
            ""
        } else {
            let key = if engine == "duckdb" { "sql" } else { "command" };
            if input.as_object().is_none_or(|v| {
                v.keys()
                    .any(|k| !["resourceId", "path", "engine", key].contains(&k.as_str()))
            }) {
                return Err(err(400, "INVALID_ANALYSIS"));
            }

            input[key]
                .as_str()
                .filter(|s| !s.trim().is_empty() && s.len() <= 65536)
                .ok_or_else(|| err(400, "INVALID_ANALYSIS"))?
        };
        let _slot = self
            .execute
            .analysis_slots
            .try_acquire()
            .map_err(|_| err(429, "ANALYSIS_BUSY"))?;
        let started = std::time::Instant::now();
        let (_, bytes) = self
            .snapshot(credential, &resource, &path, false, LIMIT)
            .await?;
        let result = self
            .execute_file(FileJob {
                resource_id,
                path: &path,
                bytes,
                mode: if preview { "preview" } else { "analysis" },
                engine,
                format,
                script,
                parsing: None,
            })
            .await?;
        self.context(
            credential,
            if preview {
                "files:read"
            } else {
                "files:analyze"
            },
            Some((resource_id, Some("filesystem"))),
        )
        .await?;
        let mut result = result;
        result["durationMs"] = json!(started.elapsed().as_millis() as u64);
        if result.to_string().len() > if preview { 128 * 1024 } else { 1024 * 1024 } {
            return Err(err(422, "ANALYSIS_OUTPUT_LIMIT"));
        }
        Ok(result)
    }
    pub(super) async fn execute_file(&self, job: FileJob<'_>) -> Result<Value> {
        let FileJob {
            resource_id,
            path,
            bytes,
            mode,
            engine,
            format,
            script,
            parsing,
        } = job;
        let directory = tempfile::tempdir().map_err(|_| err(503, "ANALYSIS_UNAVAILABLE"))?;
        let source = directory.path().join("selected-snapshot");
        {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&source)
                .map_err(|_| err(503, "ANALYSIS_UNAVAILABLE"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(std::fs::Permissions::from_mode(0o600))
                    .map_err(|_| err(503, "ANALYSIS_UNAVAILABLE"))?;
            }
            file.write_all(&bytes)
                .map_err(|_| err(503, "ANALYSIS_UNAVAILABLE"))?;
        }
        let mut result=self.execute.execute(json!({"mode":mode,"engine":engine,"format":format,"script":script,"sourcePath":source,"workspacePath":path,"parsing":parsing})).await?;
        result["resourceId"] = json!(resource_id);
        result["path"] = json!(path);
        result["readOnly"] = json!(true);
        result["inputBytes"] = json!(bytes.len());
        result["fileVersion"] = json!(hex::encode(Sha256::digest(&bytes)));
        if mode == "analysis" {
            result["engine"] = json!(engine);
        } else {
            result["format"] = json!(format);
        }
        Ok(result)
    }
}
fn parent(path: &str) -> String {
    let p = path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    if p.is_empty() { "/".into() } else { p.into() }
}
pub(super) fn format(path: &str) -> Option<(&'static str, Vec<&'static str>)> {
    let ext = path.rsplit('.').next()?.to_lowercase();
    match ext.as_str() {
        "csv" => Some(("csv", vec!["duckdb", "bash"])),
        "parquet" => Some(("parquet", vec!["duckdb"])),
        "log" | "txt" | "text" | "md" | "json" | "jsonl" | "ndjson" | "yaml" | "yml" | "out"
        | "err" | "tsv" => Some(("text", vec!["bash"])),
        _ => None,
    }
}
pub fn bash_input(path: &str) -> Value {
    let a = "/workspace/input.log";
    json!({"path":path,"workingDirectory":"/workspace","aliases":if path==a||path.starts_with(&(a.to_owned()+"/"))||a.starts_with(&(path.to_owned()+"/")){Vec::<&str>::new()}else{vec![a]},"fileVariable":"FILE"})
}
pub fn analysis_limits() -> Value {
    json!({"inputBytes":LIMIT,"scriptBytes":65536,"outputBytes":1024*1024,"rows":1000,"timeoutMs":15000,"concurrency":2,"workerHeapMiB":128,"duckdbMemoryMB":128})
}

pub(super) fn local_version(file: &Value) -> String {
    file["version"]
        .as_str()
        .filter(|s| valid_etag(s))
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!(
                "\"{}\"",
                hex::encode(Sha256::digest(file.to_string().as_bytes()))
            )
        })
}
fn valid_etag(s: &str) -> bool {
    s.len() >= 3
        && s.len() <= 256
        && s.starts_with('"')
        && s.ends_with('"')
        && s[1..s.len() - 1]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
fn provider_version(stat: &Value) -> Option<String> {
    let revision = stat["dataRevision"].as_str()?;
    if revision.parse::<i64>().ok()? <= 0 {
        return None;
    }
    let identity = stat["resourceIdentity"].as_str()?;
    if identity.is_empty() {
        return None;
    }
    Some(format!(
        "\"{}\"",
        hex::encode(Sha256::digest(format!("{identity}:{revision}").as_bytes()))
    ))
}

#[cfg(test)]
mod image_preview_tests {
    use super::{image_preview_type, matches_image_signature};

    #[test]
    fn image_extensions_and_signatures_must_agree() {
        for (path, mime, bytes) in [
            ("/photo.PNG", "image/png", &b"\x89PNG\r\n\x1a\nrest"[..]),
            ("/photo.jpg", "image/jpeg", &b"\xff\xd8\xffrest"[..]),
            ("/photo.jpeg", "image/jpeg", &b"\xff\xd8\xffrest"[..]),
            ("/image.gif", "image/gif", &b"GIF89arest"[..]),
            ("/image.webp", "image/webp", &b"RIFFxxxxWEBPrest"[..]),
        ] {
            assert_eq!(image_preview_type(path), Some(mime));
            assert!(matches_image_signature(mime, bytes));
            assert!(!matches_image_signature(mime, b"wrong bytes"));
        }
        assert_eq!(image_preview_type("/image.svg"), None);
        assert!(!matches_image_signature("image/webp", b"RIFF"));
    }
}
