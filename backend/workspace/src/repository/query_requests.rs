//! Durable query deduplication. Request keys never expire or regain execution rights.
//! Result records remain encrypted by Meta; no SQL text is persisted here.
use super::*;
fn key(resource: &str, actor: &str, request: &str) -> Result<String> {
    if !Uuid::parse_str(request).is_ok_and(|id| id.to_string() == request)
        || resource.is_empty()
        || resource.len() > 128
        || actor.is_empty()
        || actor.len() > 2048
    {
        return Err(ServiceError::new(400, "INVALID_REQUEST_ID"));
    }
    Ok(format!(
        "operations/queries/{:x}",
        Sha256::digest(json!([resource, actor, request]).to_string().as_bytes())
    ))
}
fn validate(value: &Value, resource: &str, actor: &str, request: &str) -> Result<()> {
    if value["resourceId"] != resource
        || value["principalId"] != actor
        || value["requestId"] != request
        || !matches!(
            value["state"].as_str(),
            Some("running" | "succeeded" | "failed" | "outcomeUnknown")
        )
        || value["startedAt"].as_i64().is_none()
        || value["fingerprint"].as_str().is_none()
    {
        return Err(error("QUERY_RECORD_CORRUPT"));
    }
    Ok(())
}
impl Repository {
    /// Authenticate the exact actor and resource before calling. Only true permits SQL I/O.
    /// A lost commit reply returns an error; it never grants execution permission.
    pub async fn begin_query_request(
        &self,
        resource: &str,
        actor: &str,
        request: &str,
        fingerprint: &str,
        now: i64,
    ) -> Result<(Value, bool)> {
        let key = key(resource, actor, request)?;
        if fingerprint.len() != 64
            || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
            || now <= 0
        {
            return Err(ServiceError::new(400, "INVALID_QUERY_REQUEST"));
        }
        for _ in 0..8 {
            let _guard = self.queue.read().await;
            let record = self.get(&key).await?;
            if !record.is_null() {
                let value = &record["value"];
                validate(value, resource, actor, request)?;
                if value["fingerprint"] != fingerprint {
                    return Err(ServiceError::new(409, "REQUEST_ID_REUSED"));
                }
                return Ok((value.clone(), false));
            }
            let value = json!({"requestId":request,"resourceId":resource,"principalId":actor,"fingerprint":fingerprint,
                "state":"running","startedAt":now,"result":null,"errorCode":null});
            match self
                .commit(vec![
                    json!({"key":key,"expectedVersion":null,"value":value}),
                ])
                .await
            {
                Ok(()) => return Ok((value, true)),
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) => return Err(e),
            }
        }
        Err(ServiceError::new(409, "QUERY_REQUEST_BUSY"))
    }
    /// Call only after rechecking current resource access. An abandoned/uncertain running
    /// record can be observed as unknown but can never be executed by a retry.
    pub async fn query_request(
        &self,
        resource: &str,
        actor: &str,
        request: &str,
        now: i64,
    ) -> Result<Value> {
        let record = self.get(&key(resource, actor, request)?).await?;
        if record.is_null() {
            return Err(ServiceError::new(404, "NOT_FOUND"));
        }
        let mut value = record["value"].clone();
        validate(&value, resource, actor, request)?;
        if value["state"] == "running"
            && value["startedAt"]
                .as_i64()
                .is_none_or(|start| now.saturating_sub(start) > 30)
        {
            value["state"] = json!("outcomeUnknown");
        }
        Ok(value)
    }
    pub async fn finish_query_request(
        &self,
        resource: &str,
        actor: &str,
        request: &str,
        result: Option<&Value>,
        code: Option<&str>,
    ) -> Result<Value> {
        let key = key(resource, actor, request)?;
        if result.is_some_and(|r| r.to_string().len() > 1024 * 1024) {
            return Err(ServiceError::new(413, "QUERY_RESULT_TOO_LARGE"));
        }
        for _ in 0..8 {
            let _guard = self.queue.read().await;
            let record = self.get(&key).await?;
            if record.is_null() {
                return Err(error("QUERY_RECORD_MISSING"));
            }
            let mut value = record["value"].clone();
            validate(&value, resource, actor, request)?;
            if value["state"] != "running" {
                return Ok(value);
            }
            value["state"] = json!(if result.is_some() {
                "succeeded"
            } else {
                "outcomeUnknown"
            });
            value["result"] = result.cloned().unwrap_or(Value::Null);
            value["errorCode"] = json!(code);
            match self
                .commit(vec![
                    json!({"key":key,"expectedVersion":record["version"],"value":value}),
                ])
                .await
            {
                Ok(()) => return Ok(value),
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) => return Err(e),
            }
        }
        Err(ServiceError::new(409, "QUERY_REQUEST_BUSY"))
    }
}
