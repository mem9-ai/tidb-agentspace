//! Durable, workspace-scoped sales sample attempts and their idempotency slot.
use super::*;

const SLOT: &str = "operations/sales-samples/slot-us-sales-v1";
fn attempt_key(id: &str) -> String {
    format!("operations/sales-samples/attempts/{id}")
}
fn index_key(actor: &str, key: &str) -> String {
    let digest = Sha256::digest(json!([actor, key]).to_string().as_bytes());
    format!(
        "operations/sales-samples/idempotency/{}",
        hex::encode(digest)
    )
}

impl Repository {
    pub async fn begin_sales_sample(
        &self,
        credential: &crate::Credential,
        actor: &str,
        key: &str,
        attempt: Value,
    ) -> Result<(Value, bool)> {
        let index = index_key(actor, key);
        for retry in 0..8 {
            let _guard = self.queue.read().await;
            let state = match credential {
                crate::Credential::Bearer(token) => {
                    self.key_state(&hex::encode(Sha256::digest(token.as_bytes())))
                        .await?
                }
                _ => json!({"workspace":{"id":self.workspace_id()}}),
            };
            let principal = crate::principal(&state, credential)?;
            for scope in ["files:read", "files:write"] {
                principal.scope(scope)?;
            }
            if let Some(resource_id) = attempt["requestedResourceId"].as_str() {
                if !principal.has(resource_id) {
                    return Err(ServiceError::new(403, "FORBIDDEN"));
                }
            } else {
                principal.scope("resources:write")?;
                if !principal.has("*") {
                    return Err(ServiceError::new(403, "FORBIDDEN"));
                }
            }
            if principal.id != actor {
                return Err(ServiceError::new(403, "FORBIDDEN"));
            }
            let records = self.get_many(vec![index.clone(), SLOT.into()]).await?;
            if !records[&index].is_null() {
                let id = records[&index]["value"]["id"]
                    .as_str()
                    .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
                let stored = self.get(&attempt_key(id)).await?;
                if stored.is_null() {
                    return Err(error("META_RECORD_CORRUPT"));
                }
                if stored["value"]["requestedResourceId"] != attempt["requestedResourceId"] {
                    return Err(ServiceError::new(409, "IDEMPOTENCY_CONFLICT"));
                }
                return Ok((stored["value"].clone(), false));
            }
            if !records[SLOT].is_null() {
                return Err(ServiceError::new(409, "SAMPLE_SLOT_UNAVAILABLE"));
            }
            let id = attempt["id"]
                .as_str()
                .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
            let mut changes = vec![
                json!({"key":attempt_key(id),"expectedVersion":null,"value":attempt}),
                json!({"key":index,"expectedVersion":null,"value":{"id":id,"fixture":"us-sales-v1"}}),
                json!({"key":SLOT,"expectedVersion":null,"value":{"id":id}}),
            ];
            if matches!(credential, crate::Credential::Bearer(_)) {
                let key = state["keys"]
                    .as_array()
                    .and_then(|keys| keys.first())
                    .ok_or_else(|| ServiceError::new(401, "INVALID_KEY"))?;
                let key_id = key["id"]
                    .as_str()
                    .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
                let path = format!("state/keys/{key_id}");
                let prior = self.get(&path).await?;
                if prior["value"]["record"] != *key {
                    if retry < 7 {
                        continue;
                    }
                    return Err(ServiceError::new(409, "META_CONFLICT"));
                }
                changes.push(
                    json!({"key":path,"expectedVersion":version(&prior),"value":prior["value"]}),
                );
            }
            if !self.get("ownership/onboarding").await?.is_null() {
                let (owner, generation) = self.managed_owner().await?;
                match credential {
                    crate::Credential::SessionOwner {
                        id,
                        policy_generation: Some(value),
                        ..
                    } if id == &owner && *value == generation => {}
                    crate::Credential::Bearer(_) | crate::Credential::Scoped(_) => {}
                    _ => return Err(ServiceError::new(401, "UNAUTHENTICATED")),
                }
            }
            match self.commit(changes).await {
                Ok(()) => return Ok((attempt, true)),
                Err(e) if e.code == "META_CONFLICT" && retry < 7 => continue,
                Err(e) => return Err(e),
            }
        }
        unreachable!()
    }

    pub async fn sales_sample(&self, id: &str) -> Result<Value> {
        let record = self.get(&attempt_key(id)).await?;
        if record.is_null() {
            return Err(ServiceError::new(404, "NOT_FOUND"));
        }
        Ok(record["value"].clone())
    }

    pub async fn has_sales_sample_key(&self, actor: &str, key: &str) -> Result<bool> {
        Ok(!self.get(&index_key(actor, key)).await?.is_null())
    }

    pub async fn current_sales_sample(&self) -> Result<Option<Value>> {
        let slot = self.get(SLOT).await?;
        if slot.is_null() {
            return Ok(None);
        }
        let id = slot["value"]["id"]
            .as_str()
            .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
        Ok(Some(self.sales_sample(id).await?))
    }

    pub async fn update_sales_sample(&self, id: &str, update: Value) -> Result<Value> {
        for retry in 0..8 {
            let _guard = self.queue.read().await;
            let key = attempt_key(id);
            let prior = self.get(&key).await?;
            if prior.is_null() {
                return Err(error("META_RECORD_CORRUPT"));
            }
            let mut value = prior["value"].clone();
            if value["status"] != "preparing" {
                return Err(error("SAMPLE_ALREADY_FINISHED"));
            }
            for (field, entry) in update
                .as_object()
                .ok_or_else(|| error("META_RECORD_CORRUPT"))?
            {
                value[field] = entry.clone();
            }
            value["updatedAt"] =
                json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            match self
                .commit(vec![
                    json!({"key":key,"expectedVersion":version(&prior),"value":value}),
                ])
                .await
            {
                Ok(()) => return Ok(value),
                Err(e) if e.code == "META_CONFLICT" && retry < 7 => continue,
                Err(e) => return Err(e),
            }
        }
        unreachable!()
    }
}
