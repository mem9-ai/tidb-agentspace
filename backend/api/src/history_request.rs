//! Minimal request diagnostics; callers construct this only after Workspace authentication.
use std::time::Instant;
use uuid::Uuid;
use workspace_domain::{
    HistoryActor,
    observability::{ActorKind, HttpCompletion, HttpMethod, HttpOperation, RequestEntry},
};

pub struct HistoryRequest {
    request_id: Uuid,
    actor: HistoryActor,
    method: HttpMethod,
    operation: HttpOperation,
    started_at: chrono::DateTime<chrono::Utc>,
    started: Instant,
}

pub struct CompletedHistoryRequest {
    request_id: Uuid,
    actor_kind: ActorKind,
    actor_id: String,
    method: HttpMethod,
    operation: HttpOperation,
    started_at: chrono::DateTime<chrono::Utc>,
    completion: HttpCompletion,
    duration_ms: u64,
}

impl HistoryRequest {
    /// Only allowlisted operation names survive; the raw route is never retained. Reading
    /// history itself is excluded to prevent recursive diagnostics.
    pub fn start(actor: HistoryActor, request_id: Uuid, method: &str, route: &str) -> Option<Self> {
        if matches!(route, "/audit-history" | "/request-history") {
            return None;
        }
        let operation = match route.split('/').nth(1) {
            Some("resources") => HttpOperation::Resources,
            Some("files" | "file-analysis" | "file-analysis-capabilities") => HttpOperation::Files,
            Some("queries") => HttpOperation::Query,
            Some("" | "settings" | "events" | "usage") => HttpOperation::Workspace,
            _ => HttpOperation::Other,
        };
        let method = match method {
            "GET" => HttpMethod::Get,
            "POST" => HttpMethod::Post,
            "PUT" => HttpMethod::Put,
            "PATCH" => HttpMethod::Patch,
            "DELETE" => HttpMethod::Delete,
            _ => HttpMethod::Other,
        };
        Some(Self {
            request_id,
            actor,
            method,
            operation,
            started_at: chrono::Utc::now(),
            started: Instant::now(),
        })
    }

    /// Duration ends when response headers are produced or cancellation is observed.
    pub fn finish(self, completion: HttpCompletion) -> CompletedHistoryRequest {
        CompletedHistoryRequest {
            request_id: self.request_id,
            actor_kind: self.actor.kind,
            actor_id: self.actor.id,
            method: self.method,
            operation: self.operation,
            started_at: self.started_at,
            completion,
            duration_ms: u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX),
        }
    }
}
impl CompletedHistoryRequest {
    pub fn entry(&self) -> RequestEntry<'_> {
        RequestEntry {
            request_id: self.request_id,
            actor_kind: self.actor_kind,
            actor_id: &self.actor_id,
            method: self.method,
            operation: self.operation,
            completion: self.completion,
            started_at: self.started_at,
            duration_ms: self.duration_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn actor() -> HistoryActor {
        HistoryActor {
            kind: ActorKind::Owner,
            id: "owner-id".into(),
        }
    }
    #[test]
    fn only_safe_operation_labels_survive_and_history_reads_are_excluded() {
        let id = Uuid::new_v4();
        for route in ["/audit-history", "/request-history"] {
            assert!(HistoryRequest::start(actor(), id, "GET", route).is_none());
        }
        let completed = HistoryRequest::start(actor(), id, "POST", "/files/secret-sql-or-token")
            .unwrap()
            .finish(HttpCompletion::Responded(403));
        let entry = completed.entry();
        assert_eq!(entry.request_id, id);
        assert_eq!(entry.actor_id, "owner-id");
        assert!(matches!(entry.operation, HttpOperation::Files));
        assert!(matches!(entry.method, HttpMethod::Post));
        assert!(matches!(entry.completion, HttpCompletion::Responded(403)));
        let unknown = HistoryRequest::start(actor(), id, "secret", "/not-allowlisted/token")
            .unwrap()
            .finish(HttpCompletion::Canceled);
        assert!(matches!(unknown.entry().method, HttpMethod::Other));
        assert!(matches!(unknown.entry().operation, HttpOperation::Other));
        assert!(matches!(
            unknown.entry().completion,
            HttpCompletion::Canceled
        ));
    }
}
