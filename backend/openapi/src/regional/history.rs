use super::*;

pub(super) fn paths() -> Value {
    json!({
        "/workspaces/{workspaceId}/usage": {"get": get_usage(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/events": {"get": list_events(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/request-history": {"get": list_request_history(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/audit-history": {"get": list_audit_history(), "parameters": [workspace_id()]},
    })
}

fn get_usage() -> Value {
    workspace_operation(
        "getUsage",
        "Get local usage; live trial usage and allowances are unmeasured",
        "usage:read",
        "",
        json!({
            "parameters": [
                {
                    "name": "limit",
                    "in": "query",
                    "schema": {"type": "integer", "minimum": 1, "maximum": 512, "default": 100},
                },
                {"name": "cursor", "in": "query", "schema": {"type": "string", "maxLength": 1024}},
            ],
            "responses": responses(json!({
                "200": response("Success", object([
                    ("data", array(reference("Usage"))),
                    ("mode", json!({"const": "demo"})),
                    ("queryCount", integer()),
                    ("queryCountScope", json!({
                        "enum": ["workspace", "page"],
                        "description": "Workspace total for wildcard access; this page only for resource-scoped Keys.",
                    })),
                    ("nextCursor", json!({"type": ["string", "null"]})),
                ])),
            })),
        }),
    )
}

fn list_events() -> Value {
    workspace_operation(
        "listEvents",
        "List the latest 200 successful local mutation events",
        "resources:read",
        "",
        json!({
            "responses": responses(json!({"200": response("Success", object([("data", array(reference("Event")))]))})),
        }),
    )
}

fn list_request_history() -> Value {
    owner_operation(
        "listRequestHistory",
        "List partial regional HTTP diagnostics",
        json!({
            "parameters": [limit_parameter(), cursor_parameter(), from_parameter(), to_parameter()],
            "responses": {
                "200": {
                    "description": "Success",
                    "content": {
                        "application/json": {
                            "schema": closed_object([
                                ("data", array(reference("RequestHistoryRecord"))),
                                ("nextCursor", json!({"type": ["string", "null"], "maxLength": 1024})),
                                ("coverage", reference("HistoryCoverage")),
                                ("retention", reference("HistoryRetention")),
                                ("health", reference("HistoryHealth")),
                            ]),
                        },
                    },
                    "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                },
                "400": response("Invalid request", reference("Error")),
                "401": response("Missing, invalid, expired, or revoked credential", reference("Error")),
                "403": response("Insufficient permission", reference("Error")),
                "404": response("Resource or endpoint not found", reference("Error")),
                "405": response("Resource lifecycle operation unsupported by provider", reference("Error")),
                "409": response("Conflict or free-tier limit", reference("Error")),
                "410": response("History cursor expired; restart from the first page", reference("Error")),
                "412": response("Version precondition failed without a write", reference("Error")),
                "413": response("Content too large", reference("Error")),
                "415": response("Unsupported content type", reference("Error")),
                "422": response("SQL syntax, result limit, or unsupported demo query", reference("Error")),
                "429": response("Provider quota or rate limit", reference("Error")),
                "502": response("Provider unavailable or invalid response", reference("Error")),
                "503": response("Provider binding needs operator recovery", reference("Error")),
                "504": response("SQL timeout; a write outcome may be unknown", reference("Error")),
            },
        }),
    )
}

fn list_audit_history() -> Value {
    owner_operation(
        "listAuditHistory",
        "List partial regional audit history",
        json!({
            "parameters": [limit_parameter(), cursor_parameter(), from_parameter(), to_parameter()],
            "responses": {
                "200": {
                    "description": "Success",
                    "content": {
                        "application/json": {
                            "schema": closed_object([
                                ("data", array(reference("AuditHistoryRecord"))),
                                ("nextCursor", json!({"type": ["string", "null"], "maxLength": 1024})),
                                ("coverage", reference("HistoryCoverage")),
                                ("retention", reference("HistoryRetention")),
                                ("health", reference("HistoryHealth")),
                            ]),
                        },
                    },
                    "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                },
                "400": response("Invalid request", reference("Error")),
                "401": response("Missing, invalid, expired, or revoked credential", reference("Error")),
                "403": response("Insufficient permission", reference("Error")),
                "404": response("Resource or endpoint not found", reference("Error")),
                "405": response("Resource lifecycle operation unsupported by provider", reference("Error")),
                "409": response("Conflict or free-tier limit", reference("Error")),
                "410": response("History cursor expired; restart from the first page", reference("Error")),
                "412": response("Version precondition failed without a write", reference("Error")),
                "413": response("Content too large", reference("Error")),
                "415": response("Unsupported content type", reference("Error")),
                "422": response("SQL syntax, result limit, or unsupported demo query", reference("Error")),
                "429": response("Provider quota or rate limit", reference("Error")),
                "502": response("Provider unavailable or invalid response", reference("Error")),
                "503": response("Provider binding needs operator recovery", reference("Error")),
                "504": response("SQL timeout; a write outcome may be unknown", reference("Error")),
            },
        }),
    )
}
