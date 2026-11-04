use super::*;
impl Product {
    pub(super) async fn setup_attempt_request(
        &self,
        credential: &Credential,
        method: &str,
        parts: &[&str],
        query: &BTreeMap<String, String>,
        idempotency: Option<&str>,
        input: &Value,
    ) -> Result<(u16, Reply)> {
        let id = parts[1];
        let p = self.workspace.authenticate(credential).await?;
        if method == "POST" {
            p.scope("resources:write")?;
        } else {
            p.scope("resources:read")
                .or_else(|_| p.scope("resources:write"))?;
        }
        let repository = self.workspace.repository();
        let r = repository.resource(id).await?;
        let r = p.resource(&json!({"resources":[r]}), id, None)?;
        if retired_database(&r) {
            return Err(err(404, "NOT_FOUND"));
        }
        if method == "GET" && parts.len() == 4 {
            uuid::Uuid::parse_str(parts[3]).map_err(|_| err(404, "NOT_FOUND"))?;
            let value = repository.setup_attempt(id, parts[3]).await?;
            if value.is_null() {
                return Err(err(404, "NOT_FOUND"));
            }
            return Ok((200, Reply::Json(json!({"data":value}))));
        }
        if method == "GET" && parts.len() == 3 {
            if query
                .keys()
                .any(|k| !["cursor", "limit"].contains(&k.as_str()))
            {
                return Err(err(400, "INVALID_PAGINATION"));
            }
            let cursor = query.get("cursor").map(String::as_str);
            if cursor.is_some_and(|c| uuid::Uuid::parse_str(c).is_err()) {
                return Err(err(400, "INVALID_PAGINATION"));
            }
            let limit = query
                .get("limit")
                .map(|n| n.parse::<usize>())
                .transpose()
                .map_err(|_| err(400, "INVALID_PAGINATION"))?
                .unwrap_or(20);
            if !(1..=100).contains(&limit) {
                return Err(err(400, "INVALID_PAGINATION"));
            }
            return Ok((
                200,
                Reply::Json(repository.setup_attempts(id, cursor, limit).await?),
            ));
        }
        if method != "POST" || parts.len() != 3 {
            return Err(err(404, "NOT_FOUND"));
        }
        if input.as_object().is_none_or(|o| !o.is_empty()) || !query.is_empty() {
            return Err(err(400, "INVALID_BODY"));
        }
        let key = idempotency
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .ok_or_else(|| err(400, "INVALID_IDEMPOTENCY_KEY"))?;
        if ![ZERO, DB9, DUCKDB].contains(&r["provider"].as_str().unwrap_or("")) {
            return Err(err(400, "UNSUPPORTED_PROVIDER"));
        }
        let _admission = self.setup_admission[resource_locks::stripe(id)]
            .lock()
            .await;
        // Admission may have waited behind another setup. Revocation must precede journaling.
        let p = self.workspace.authenticate(credential).await?;
        p.scope("resources:write")?;
        let current = repository.resource(id).await?;
        let r = p.resource(&json!({"resources":[current]}), id, None)?;
        let attempt = json!({"id":uuid::Uuid::new_v4().to_string(),"resourceId":id,"createdAt":timestamp(),"updatedAt":timestamp(),"status":"outcome-unknown","errorCode":null,"resource":r});
        let (attempt, fresh) = repository
            .begin_setup_attempt(id, &p.id, key, attempt)
            .await?;
        if !fresh {
            return Ok((201, Reply::Json(json!({"data":attempt}))));
        }
        // A caller may have waited for another attempt. Reauthorize and reload its current target.
        let current = self
            .context(credential, "resources:write", Some((id, None)))
            .await;
        let outcome = async {
            let (_, r) = current?;
            let provider = r["provider"].as_str().unwrap_or("");
            let binding = self
                .providers
                .binding(
                    match provider {
                        ZERO => "zero",
                        DB9 => "db9",
                        _ => "duckdb",
                    },
                    id,
                )
                .await?;
            if binding.is_null() {
                return Err(err(409, "SETUP_NOT_RESUMABLE"));
            }
            if r["status"] == "active" && binding["state"] == "ready" {
                // Native status is a Meta-only observation, including saved Zero expiry.
                return self.providers.status(&r).await;
            }
            if provider == DB9
                && binding["state"] != "ready"
                && repository.account("db9").await?["state"] != "ready"
            {
                return Err(err(409, "SETUP_NOT_RESUMABLE"));
            }
            if provider == DUCKDB {
                let storage =
                    text(&binding, "storageId").map_err(|_| err(409, "SETUP_NOT_RESUMABLE"))?;
                if self.providers.binding("drive9", storage).await?.is_null() {
                    return Err(err(409, "SETUP_NOT_RESUMABLE"));
                }
                self.setup_duckdb(&r).await
            } else {
                self.providers.provision_database(&r).await
            }
        }
        .await;
        let (status, code, updates) = match outcome {
            Ok(info) if info["status"] == "active" => ("succeeded", None, info),
            Ok(info) => ("failed", Some("RESOURCE_NOT_READY".to_owned()), info),
            Err(e) => {
                let known = [
                    "SETUP_NOT_RESUMABLE",
                    "RESOURCE_DELETING",
                    "ZERO_SETUP_INCOMPLETE",
                    "DB9_SETUP_INCOMPLETE",
                    "DATABASE_EXPIRED",
                    "INSUFFICIENT_SCOPE",
                    "RESOURCE_ACCESS_DENIED",
                    "INVALID_KEY",
                ]
                .contains(&e.code.as_str());
                let code = if e.code.len() <= 64
                    && e.code
                        .bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                {
                    e.code
                } else {
                    "SETUP_FAILED".into()
                };
                (
                    if known { "failed" } else { "outcome-unknown" },
                    Some(code),
                    json!({"connectionError":"Setup did not complete. Inspect its setup attempt before explicitly trying again."}),
                )
            }
        };
        let attempt = repository
            .finish_setup_attempt(id, text(&attempt, "id")?, status, code.as_deref(), updates)
            .await?;
        Ok((201, Reply::Json(json!({"data":attempt}))))
    }
}
