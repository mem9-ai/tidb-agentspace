//! Strict, bounded filters for the planned owner-only history list operations.
use chrono::{DateTime, Utc};
use std::collections::BTreeMap;
use workspace_contracts::{Result, ServiceError};
use workspace_domain::observability::{HistoryFilter, HistoryStream};

pub struct HistoryQuery {
    cursor: Option<String>,
    limit: usize,
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
}

impl HistoryQuery {
    pub fn parse(query: &BTreeMap<String, String>, stream: HistoryStream) -> Result<Self> {
        if query
            .keys()
            .any(|key| !matches!(key.as_str(), "cursor" | "limit" | "from" | "to"))
        {
            return Err(ServiceError::new(400, "INVALID_HISTORY_QUERY"));
        }
        let limit = match query.get("limit") {
            None => 50,
            Some(value) if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => value
                .parse::<usize>()
                .ok()
                .filter(|value| (1..=100).contains(value))
                .ok_or_else(|| ServiceError::new(400, "INVALID_HISTORY_LIMIT"))?,
            Some(_) => return Err(ServiceError::new(400, "INVALID_HISTORY_LIMIT")),
        };
        let cursor = query.get("cursor").cloned();
        if cursor
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > 1024)
        {
            return Err(ServiceError::new(400, "INVALID_HISTORY_CURSOR"));
        }
        let date = |key: &str| -> Result<Option<DateTime<Utc>>> {
            query
                .get(key)
                .map(|value| {
                    if value.len() > 40 {
                        return Err(ServiceError::new(400, "INVALID_HISTORY_RANGE"));
                    }
                    DateTime::parse_from_rfc3339(value)
                        .map(|value| value.with_timezone(&Utc))
                        .map_err(|_| ServiceError::new(400, "INVALID_HISTORY_RANGE"))
                })
                .transpose()
        };
        let from = date("from")?;
        let to = date("to")?;
        let days = match stream {
            HistoryStream::Audit => 30,
            HistoryStream::Requests => 7,
        };
        if from
            .zip(to)
            .is_some_and(|(from, to)| from > to || to - from > chrono::Duration::days(days))
        {
            return Err(ServiceError::new(400, "INVALID_HISTORY_RANGE"));
        }
        Ok(Self {
            cursor,
            limit,
            from,
            to,
        })
    }

    pub fn filter(&self) -> HistoryFilter<'_> {
        HistoryFilter {
            cursor: self.cursor.as_deref(),
            limit: self.limit,
            from: self.from,
            to: self.to,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_limits_cursors_and_stream_specific_time_ranges() {
        let mut query = BTreeMap::new();
        assert_eq!(
            HistoryQuery::parse(&query, HistoryStream::Audit)
                .unwrap()
                .filter()
                .limit,
            50
        );
        for value in ["0", "101", "-1", "+1", "", "999999999999999999999999999"] {
            query.insert("limit".into(), value.into());
            assert_eq!(
                HistoryQuery::parse(&query, HistoryStream::Audit)
                    .err()
                    .unwrap()
                    .code,
                "INVALID_HISTORY_LIMIT"
            );
        }
        query.insert("limit".into(), "100".into());
        query.insert("from".into(), "2026-01-01T00:00:00Z".into());
        query.insert("to".into(), "2026-01-15T00:00:00Z".into());
        assert!(HistoryQuery::parse(&query, HistoryStream::Audit).is_ok());
        assert_eq!(
            HistoryQuery::parse(&query, HistoryStream::Requests)
                .err()
                .unwrap()
                .code,
            "INVALID_HISTORY_RANGE"
        );
        query.insert("to".into(), "not-a-date".into());
        assert_eq!(
            HistoryQuery::parse(&query, HistoryStream::Audit)
                .err()
                .unwrap()
                .code,
            "INVALID_HISTORY_RANGE"
        );
        query.remove("to");
        query.insert("cursor".into(), "".into());
        assert_eq!(
            HistoryQuery::parse(&query, HistoryStream::Audit)
                .err()
                .unwrap()
                .code,
            "INVALID_HISTORY_CURSOR"
        );
        query.remove("cursor");
        query.insert("unknown".into(), "value".into());
        assert_eq!(
            HistoryQuery::parse(&query, HistoryStream::Audit)
                .err()
                .unwrap()
                .code,
            "INVALID_HISTORY_QUERY"
        );
    }
}
