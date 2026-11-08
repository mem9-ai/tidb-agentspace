use super::*;

pub(super) fn schemas() -> Value {
    json!({
        "HistoryActor": history_actor(),
        "RequestHistoryRecord": request_history_record(),
        "AuditHistoryRecord": audit_history_record(),
        "HistoryCoverage": history_coverage(),
        "HistoryRetention": history_retention(),
        "HistoryHealth": history_health(),
    })
}

fn history_actor() -> Value {
    closed_object([
        ("kind", json!({"enum": ["owner", "workspaceKey"]})),
        ("id", string()),
    ])
}

fn request_history_record() -> Value {
    closed_object([
        ("id", json!({"type": "string", "format": "uuid"})),
        ("requestId", json!({"type": "string", "format": "uuid"})),
        ("authority", string()),
        ("actor", reference("HistoryActor")),
        (
            "operation",
            json!({"enum": ["workspace", "resources", "files", "query", "other"]}),
        ),
        (
            "method",
            json!({"enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "OTHER"]}),
        ),
        (
            "status",
            json!({"type": ["integer", "null"], "minimum": 100, "maximum": 599}),
        ),
        (
            "completion",
            json!({"enum": ["responded", "canceled", "unknown"]}),
        ),
        (
            "startedAt",
            json!({"type": "string", "format": "date-time"}),
        ),
        ("durationMs", json!({"type": "integer", "minimum": 0})),
    ])
}

fn audit_history_record() -> Value {
    json!({
        "type": "object",
        "required": ["id", "operationId", "authority", "actor", "action", "decision", "outcome", "occurredAt"],
        "properties": {
            "id": {"type": "string", "format": "uuid"},
            "operationId": {"type": "string", "format": "uuid"},
            "requestId": {"type": "string", "format": "uuid"},
            "authority": string(),
            "actor": reference("HistoryActor"),
            "action": {
                "enum": [
                    "workspace.update",
                    "resource.create",
                    "resource.delete",
                    "resource.retry",
                    "file.write",
                    "file.delete",
                    "query.write",
                    "query.execute",
                    "database.import",
                ],
            },
            "target": closed_object([
                ("type", json!({"enum": ["workspace", "resource", "filesystem", "database"]})),
                ("id", string()),
            ]),
            "decision": {"enum": ["allowed", "denied", "unknown"]},
            "outcome": {"enum": ["attempted", "succeeded", "denied", "failed", "unknown"]},
            "resolution": {"enum": ["inProgress", "succeeded", "denied", "failed", "unknown"]},
            "occurredAt": {"type": "string", "format": "date-time"},
        },
        "additionalProperties": false,
    })
}

fn history_coverage() -> Value {
    closed_object([
        ("status", json!({"enum": ["partial", "unavailable"]})),
        (
            "startedAt",
            json!({"type": ["string", "null"], "format": "date-time"}),
        ),
        ("operations", array(string())),
        ("exclusions", array(string())),
    ])
}

fn history_retention() -> Value {
    closed_object([
        ("maxAgeDays", json!({"type": "integer", "minimum": 1})),
        ("maxRecords", json!({"type": "integer", "minimum": 1})),
        (
            "earliestAt",
            json!({"type": ["string", "null"], "format": "date-time"}),
        ),
        ("truncated", json!({"type": ["boolean", "null"]})),
    ])
}

fn history_health() -> Value {
    closed_object([
        (
            "status",
            json!({"enum": ["unknown", "degraded", "unavailable"]}),
        ),
        (
            "droppedCount",
            json!({"type": ["integer", "null"], "minimum": 0}),
        ),
        (
            "lossDetectedAt",
            json!({"type": ["string", "null"], "format": "date-time"}),
        ),
    ])
}
