//! Workspace-owned tutorial bookmarks, independent of the bootstrap projection.
use super::*;

const PREFIX: &str = "tutorials/progress/";

impl Repository {
    pub async fn tutorial(&self, resource: &str) -> Result<Value> {
        let record = self.get(&format!("{PREFIX}{resource}")).await?;
        if record.is_null() {
            return Err(ServiceError::new(404, "NOT_FOUND"));
        }
        Ok(record["value"].clone())
    }

    pub async fn tutorials(&self, cursor: Option<&str>, limit: usize) -> Result<Value> {
        let page = self
            .call(MetaRequest::List {
                scope: self.scope.clone(),
                guard: Some(self.guard.clone()),
                prefix: PREFIX.into(),
                after: cursor.map(|id| format!("{PREFIX}{id}")),
                limit,
            })
            .await?;
        let records = page["records"]
            .as_array()
            .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
        let data = records
            .iter()
            .map(|record| record["value"].clone())
            .collect::<Vec<_>>();
        let next = page["nextCursor"]
            .as_str()
            .and_then(|key| key.strip_prefix(PREFIX));
        Ok(json!({"data":data,"nextCursor":next}))
    }

    /// Compare and replace under the writer fence. No stale browser may reset a newer sample.
    pub async fn replace_tutorial(
        &self,
        resource: &str,
        expected: Option<&str>,
        input: Value,
    ) -> Result<(Value, bool)> {
        let _lock = self.queue.read().await;
        let key = format!("{PREFIX}{resource}");
        let prior = self.get(&key).await?;
        let created = prior.is_null();
        if match expected {
            None => !created,
            Some(value) => created || prior["value"]["version"].as_str() != Some(value),
        } {
            return Err(ServiceError::new(412, "PRECONDITION_FAILED"));
        }
        let value = json!({
            "resourceId":resource,
            "sampleId":input["sampleId"],
            "state":input["state"],
            "version":format!("\"tutorial-{}\"", Uuid::new_v4().simple()),
            "updatedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        });
        match self
            .commit(vec![
                json!({"key":key,"expectedVersion":version(&prior),"value":value}),
            ])
            .await
        {
            Ok(()) => {}
            Err(error) if error.code == "META_CONFLICT" => {
                return Err(ServiceError::new(412, "PRECONDITION_FAILED"));
            }
            Err(error) => return Err(error),
        }
        Ok((value, created))
    }
}
