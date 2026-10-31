//! Bounded event retention with an ordered index. Existing event records are imported once.
use super::*;

const HEAD: &str = "indexes/event-v1/head";
const ORDER: &str = "indexes/event-v1/order/";

impl Repository {
    async fn event_head(&self) -> Result<Value> {
        let existing = self.get(HEAD).await?;
        if !existing.is_null() {
            return Ok(existing);
        }
        // Old installations retain at most 200 events. Import the existing ordering once;
        // the index, head and old records are published atomically.
        let records = self.records("state/events/").await?;
        if records.len() > 200 {
            return Err(error("EVENT_INDEX_MIGRATION_LIMIT"));
        }
        let mut changes = Vec::new();
        let mut maximum = 0;
        for (path, record) in &records {
            let id = record["value"]["record"]["id"]
                .as_str()
                .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
            let position = record["value"]["position"]
                .as_u64()
                .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
            if path != &format!("state/events/{id}") {
                return Err(error("META_RECORD_CORRUPT"));
            }
            maximum = maximum.max(position);
            changes.push(json!({"key":format!("{ORDER}{position:020}/{id}"),"expectedVersion":null,"value":{"id":id}}));
        }
        changes.push(json!({"key":HEAD,"expectedVersion":null,"value":{"format":1,"position":maximum,"count":records.len()}}));
        match self.commit(changes).await {
            Ok(()) => self.get(HEAD).await,
            Err(failure) if failure.code == "META_CONFLICT" => self.get(HEAD).await,
            Err(failure) => Err(failure),
        }
    }

    pub(super) async fn event_changes(&self, event: &Value) -> Result<Vec<Value>> {
        let id = event["id"]
            .as_str()
            .filter(|id| !id.is_empty() && !id.contains('/'))
            .ok_or_else(|| error("META_RECORD_CORRUPT"))?;
        let head = self.event_head().await?;
        let state = &head["value"];
        let count = state["count"]
            .as_u64()
            .filter(|count| *count <= 200)
            .ok_or_else(|| error("EVENT_INDEX_CORRUPT"))?;
        let position = state["position"]
            .as_u64()
            .and_then(|position| position.checked_add(1))
            .ok_or_else(|| error("EVENT_INDEX_CORRUPT"))?;
        if state["format"] != 1 {
            return Err(error("EVENT_INDEX_CORRUPT"));
        }
        let mut changes = vec![
            json!({"key":HEAD,"expectedVersion":version(&head),"value":{"format":1,"position":position,"count":(count+1).min(200)}}),
            json!({"key":format!("state/events/{id}"),"expectedVersion":null,"value":{"position":position,"record":event}}),
            json!({"key":format!("{ORDER}{position:020}/{id}"),"expectedVersion":null,"value":{"id":id}}),
        ];
        if count == 200 {
            let page = self
                .call(MetaRequest::List {
                    scope: self.scope.clone(),
                    guard: Some(self.guard.clone()),
                    prefix: ORDER.into(),
                    after: None,
                    limit: 1,
                })
                .await?;
            let oldest = page["records"]
                .as_array()
                .and_then(|items| items.first())
                .ok_or_else(|| error("EVENT_INDEX_CORRUPT"))?;
            let index_key = oldest["key"]
                .as_str()
                .ok_or_else(|| error("EVENT_INDEX_CORRUPT"))?;
            let old_id = oldest["value"]["id"]
                .as_str()
                .filter(|id| !id.is_empty() && !id.contains('/'))
                .ok_or_else(|| error("EVENT_INDEX_CORRUPT"))?;
            let old_key = format!("state/events/{old_id}");
            let old = self.get(&old_key).await?;
            let old_position = old["value"]["position"]
                .as_u64()
                .ok_or_else(|| error("EVENT_INDEX_CORRUPT"))?;
            if old["value"]["record"]["id"] != old_id
                || index_key != format!("{ORDER}{old_position:020}/{old_id}")
            {
                return Err(error("EVENT_INDEX_CORRUPT"));
            }
            changes
                .push(json!({"key":index_key,"expectedVersion":oldest["version"],"delete":true}));
            changes.push(json!({"key":old_key,"expectedVersion":version(&old),"delete":true}));
        }
        Ok(changes)
    }
}
