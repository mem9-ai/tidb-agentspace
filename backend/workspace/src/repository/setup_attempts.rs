//! Writer-fenced setup history outside the bounded bootstrap projection.
use super::*;

fn attempt_key(resource: &str, id: &str) -> String {
    format!("operations/setup/{resource}/{id}")
}
impl Repository {
    pub async fn begin_setup_attempt(
        &self,
        resource: &str,
        actor: &str,
        idempotency: &str,
        attempt: Value,
    ) -> Result<(Value, bool)> {
        let _lock = self.queue.write().await;
        let digest = hex::encode(Sha256::digest(
            json!([resource, actor, idempotency]).to_string().as_bytes(),
        ));
        let index = format!("indexes/setup-idempotency/{digest}");
        let prior = self.get(&index).await?;
        if !prior.is_null() {
            let id = prior["value"]
                .as_str()
                .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
            let record = self.get(&attempt_key(resource, id)).await?;
            if record.is_null() {
                return Err(error("META_RECORD_CORRUPT"));
            }
            return Ok((record["value"].clone(), false));
        }
        let id = attempt["id"]
            .as_str()
            .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
        self.commit(vec![
            json!({"key":attempt_key(resource,id),"expectedVersion":null,"value":attempt}),
            json!({"key":index,"expectedVersion":null,"value":id}),
        ])
        .await?;
        Ok((attempt, true))
    }
    pub async fn setup_attempt(&self, resource: &str, id: &str) -> Result<Value> {
        Ok(self.get(&attempt_key(resource, id)).await?["value"].clone())
    }
    pub async fn setup_attempts(
        &self,
        resource: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<Value> {
        let prefix = format!("operations/setup/{resource}/");
        let page = self
            .call(MetaRequest::List {
                scope: self.scope.clone(),
                guard: Some(self.guard.clone()),
                prefix: prefix.clone(),
                after: cursor.map(|c| format!("{prefix}{c}")),
                limit,
            })
            .await?;
        let records = page["records"]
            .as_array()
            .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
        let data = records
            .iter()
            .map(|r| r["value"].clone())
            .collect::<Vec<_>>();
        let next = page["nextCursor"]
            .as_str()
            .and_then(|s| s.strip_prefix(&prefix));
        Ok(json!({"data":data,"nextCursor":next}))
    }
    /// Publish the terminal/unknown observation and public resource update in one native commit.
    pub async fn finish_setup_attempt(
        &self,
        resource: &str,
        id: &str,
        status: &str,
        code: Option<&str>,
        updates: Value,
    ) -> Result<Value> {
        let _lock = self.queue.write().await;
        let key = attempt_key(resource, id);
        let prior = self.get(&key).await?;
        let resource_key = format!("state/resources/{resource}");
        let original = self.get(&resource_key).await?;
        if prior.is_null() || original.is_null() {
            return Err(error("META_RECORD_CORRUPT"));
        }
        let mut stored = original["value"].clone();
        let r = stored["record"]
            .as_object_mut()
            .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
        r.remove("connectionError");
        for (k, v) in updates
            .as_object()
            .ok_or_else(|| error("META_RECORD_CORRUPT"))?
        {
            if ["status", "expiresAt", "uploadLimitBytes", "connectionError"].contains(&k.as_str())
            {
                r.insert(k.clone(), v.clone());
            }
        }
        let mut attempt = prior["value"].clone();
        attempt["status"] = json!(status);
        attempt["errorCode"] = json!(code);
        attempt["updatedAt"] =
            json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        attempt["resource"] = stored["record"].clone();
        let mut changes = vec![
            json!({"key":key,"expectedVersion":version(&prior),"value":attempt}),
            json!({"key":resource_key,"expectedVersion":version(&original),"value":stored}),
        ];
        changes.extend(
            self.resource_index_changes(&original["value"]["record"], &stored["record"])
                .await?,
        );
        self.commit(changes).await?;
        Ok(attempt)
    }
}
