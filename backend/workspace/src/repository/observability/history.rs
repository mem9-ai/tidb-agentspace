//! Bounded, Workspace-bound paging for the inactive history primitives.
use super::*;
use chrono::{DateTime, Utc};

#[derive(Clone, Copy)]
pub enum HistoryStream {
    Audit,
    Requests,
}

pub struct HistoryFilter<'a> {
    pub cursor: Option<&'a str>,
    pub limit: usize,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
}

impl Repository {
    /// Authorization belongs to the caller: only a verified Workspace owner may read this.
    /// The returned records are not a claim of complete coverage or physical TTL deletion.
    pub async fn history_page(
        &self,
        stream: HistoryStream,
        filter: HistoryFilter<'_>,
    ) -> Result<Value> {
        if !(1..=100).contains(&filter.limit) {
            return Err(ServiceError::new(400, "INVALID_HISTORY_LIMIT"));
        }
        let (head_key, prefix, stream_name, timestamp_field, days) = match stream {
            HistoryStream::Audit => (AUDIT_HEAD, AUDIT_RECORDS, "audit", "occurredAt", 30),
            HistoryStream::Requests => (
                requests::HEAD,
                requests::RECORDS,
                "requests",
                "startedAt",
                7,
            ),
        };
        if filter
            .from
            .zip(filter.to)
            .is_some_and(|(from, to)| from > to || to - from > chrono::Duration::days(days))
        {
            return Err(ServiceError::new(400, "INVALID_HISTORY_RANGE"));
        }
        let digest_input = json!([
            self.authority_id(),
            self.workspace_id(),
            stream_name,
            filter.from.map(|value| value.to_rfc3339()),
            filter.to.map(|value| value.to_rfc3339()),
        ]);
        let binding = hex::encode(Sha256::digest(
            serde_json::to_vec(&digest_input).map_err(|_| error("HISTORY_CURSOR_ERROR"))?,
        ));
        let head = self.get(head_key).await?;
        let (position, count) = if head.is_null() {
            (0, 0)
        } else {
            if head["value"]["format"] != 1 {
                return Err(error("HISTORY_INDEX_CORRUPT"));
            }
            let position = head["value"]["position"]
                .as_u64()
                .ok_or_else(|| error("HISTORY_INDEX_CORRUPT"))?;
            let count = head["value"]["count"]
                .as_u64()
                .filter(|count| *count <= 100_000 && *count <= position)
                .ok_or_else(|| error("HISTORY_INDEX_CORRUPT"))?;
            (position, count)
        };
        let mut after = filter
            .cursor
            .map(|cursor| {
                if cursor.len() > 1024 {
                    return Err(ServiceError::new(400, "INVALID_HISTORY_CURSOR"));
                }
                let bytes = hex::decode(cursor)
                    .map_err(|_| ServiceError::new(400, "INVALID_HISTORY_CURSOR"))?;
                let value: Value = serde_json::from_slice(&bytes)
                    .map_err(|_| ServiceError::new(400, "INVALID_HISTORY_CURSOR"))?;
                if !value.as_object().is_some_and(|object| object.len() == 3)
                    || value["v"] != 1
                    || value["binding"] != binding
                {
                    return Err(ServiceError::new(400, "INVALID_HISTORY_CURSOR"));
                }
                let sequence = value["sequence"]
                    .as_u64()
                    .filter(|sequence| *sequence > 0)
                    .ok_or_else(|| ServiceError::new(400, "INVALID_HISTORY_CURSOR"))?;
                if count == 0 || sequence > position {
                    return Err(ServiceError::new(410, "HISTORY_CURSOR_EXPIRED"));
                }
                Ok(format!("{prefix}{:020}", u64::MAX - sequence))
            })
            .transpose()?;
        if let Some(key) = after.as_deref()
            && self.get(key).await?.is_null()
        {
            return Err(ServiceError::new(410, "HISTORY_CURSOR_EXPIRED"));
        }
        let cutoff = Utc::now() - chrono::Duration::days(days);
        let effective_from = filter.from.map_or(cutoff, |from| from.max(cutoff));
        let mut data = Vec::new();
        let mut next = None;
        // Filtering cannot cause unbounded scans; an empty page can carry a continuation.
        for _ in 0..8 {
            let page = self
                .call(MetaRequest::List {
                    scope: self.scope.clone(),
                    guard: Some(self.guard.clone()),
                    prefix: prefix.into(),
                    after: after.clone(),
                    limit: 100,
                })
                .await?;
            let records = page["records"]
                .as_array()
                .ok_or_else(|| error("HISTORY_INDEX_CORRUPT"))?;
            if records.is_empty() {
                break;
            }
            for (index, envelope) in records.iter().enumerate() {
                let key = envelope["key"]
                    .as_str()
                    .ok_or_else(|| error("HISTORY_INDEX_CORRUPT"))?;
                let suffix = key
                    .strip_prefix(prefix)
                    .filter(|value| {
                        value.len() == 20 && value.bytes().all(|byte| byte.is_ascii_digit())
                    })
                    .ok_or_else(|| error("HISTORY_INDEX_CORRUPT"))?;
                let reverse = suffix
                    .parse::<u64>()
                    .map_err(|_| error("HISTORY_INDEX_CORRUPT"))?;
                let sequence = u64::MAX - reverse;
                let value = &envelope["value"];
                let timestamp = value[timestamp_field]
                    .as_str()
                    .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                    .map(|value| value.with_timezone(&Utc))
                    .ok_or_else(|| error("HISTORY_INDEX_CORRUPT"))?;
                after = Some(key.to_owned());
                if timestamp >= effective_from && filter.to.is_none_or(|to| timestamp <= to) {
                    data.push(value.clone());
                }
                if data.len() == filter.limit {
                    if index + 1 < records.len() || !page["nextCursor"].is_null() {
                        next = Some(sequence);
                    } else {
                        next = None;
                    }
                    break;
                }
            }
            if data.len() == filter.limit {
                break;
            }
            if page["nextCursor"].is_null() {
                after = None;
                break;
            }
            if let Some(key) = after.as_ref() {
                let sequence = u64::MAX
                    - key[prefix.len()..]
                        .parse::<u64>()
                        .map_err(|_| error("HISTORY_INDEX_CORRUPT"))?;
                next = Some(sequence);
            }
        }
        if after.is_none() {
            next = None;
        }
        if matches!(stream, HistoryStream::Audit) {
            let mut keys = std::collections::BTreeSet::new();
            for record in &data {
                if record["outcome"] == "attempted" {
                    let id = record["operationId"]
                        .as_str()
                        .and_then(|value| Uuid::parse_str(value).ok())
                        .ok_or_else(|| error("HISTORY_INDEX_CORRUPT"))?;
                    keys.insert(format!("{AUDIT_OPERATIONS}{id}"));
                }
            }
            if !keys.is_empty() {
                let operations = self
                    .call(MetaRequest::Get {
                        scope: self.scope.clone(),
                        guard: Some(self.guard.clone()),
                        keys: keys.into_iter().collect(),
                    })
                    .await?["records"]
                    .clone();
                for record in &mut data {
                    if record["outcome"] != "attempted" {
                        continue;
                    }
                    let id = record["operationId"]
                        .as_str()
                        .ok_or_else(|| error("HISTORY_INDEX_CORRUPT"))?;
                    let operation = &operations[&format!("{AUDIT_OPERATIONS}{id}")];
                    if operation.is_null() {
                        return Err(error("HISTORY_INDEX_CORRUPT"));
                    }
                    let resolution = match operation["value"]["status"].as_str() {
                        Some("pending") => {
                            let writer = operation["value"]["writerId"]
                                .as_str()
                                .ok_or_else(|| error("HISTORY_INDEX_CORRUPT"))?;
                            if writer == self.guard.owner_id {
                                "inProgress"
                            } else {
                                "unknown"
                            }
                        }
                        Some(value @ ("succeeded" | "denied" | "failed" | "unknown")) => value,
                        _ => return Err(error("HISTORY_INDEX_CORRUPT")),
                    };
                    record["resolution"] = json!(resolution);
                }
            }
        }
        let cursor = next.map(|sequence| {
            hex::encode(
                serde_json::to_vec(&json!({"v":1,"sequence":sequence,"binding":binding}))
                    .expect("cursor JSON"),
            )
        });
        Ok(json!({"data":data,"nextCursor":cursor}))
    }
}
