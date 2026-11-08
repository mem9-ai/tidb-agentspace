use super::*;

pub(super) fn paths() -> Value {
    json!({
        "/analytics/config": {"get": get_product_analytics_config()},
        "/analytics/events": {"post": ingest_product_events()},
        "/analytics/session": {"post": enable_analytics_attribution(), "delete": clear_analytics_attribution()},
    })
}

fn get_product_analytics_config() -> Value {
    json!({
        "operationId": "getProductAnalyticsConfig",
        "security": [],
        "responses": responses(json!({
            "200": response("Success", closed_object([
                ("enabled", boolean()),
                ("campaigns", array(string())),
                ("policy", json!({"const": "session_only"})),
                ("version", json!({"const": 1})),
            ])),
        })),
    })
}

fn ingest_product_events() -> Value {
    json!({
        "operationId": "ingestProductEvents",
        "security": [],
        "responses": responses(json!({
            "202": response("Success", closed_object([("accepted", json!({"const": true})), ("durability", json!({"const": "queued"}))])),
            "204": {"description": "Optional collection suppressed by Global Privacy Control."},
            "409": response("Structured service error. No customer content or secrets.", object([("error", object([("code", string())]))])),
        })),
        "description": "Untrusted optional browser events only. Exact trusted Origin and application/json required; no account or Workspace authorization is established. 202 acknowledges queued acceptance by the independent analytics service, not object-storage durability. Queued writes may be lost on a crash. Retained event IDs deduplicate retries. GPC suppression returns 204.",
        "requestBody": request(closed_object([
            ("version", json!({"const": 1})),
            ("sessionId", json!({"type": "string", "format": "uuid"})),
            ("events", json!({
                "type": "array",
                "minItems": 1,
                "maxItems": 20,
                "items": closed_object([
                    ("id", json!({"type": "string", "format": "uuid"})),
                    ("event", json!({
                        "oneOf": [
                            {
                                "type": "object",
                                "properties": {
                                    "name": {"const": "public_page_view"},
                                    "page": {"enum": ["home", "get_started", "sales_guide", "api_docs", "workspace"]},
                                    "source": {"enum": ["search", "ai_referral", "social", "other", "direct_or_unknown"]},
                                    "device": {"enum": ["mobile", "desktop"]},
                                    "campaign": {"type": ["string", "null"]},
                                },
                                "required": ["name", "page", "source", "device"],
                                "additionalProperties": false,
                            },
                            closed_object([
                                ("name", json!({"const": "try_clicked"})),
                                ("page", json!({"enum": ["home", "get_started", "sales_guide", "api_docs", "workspace"]})),
                            ]),
                            closed_object([
                                ("name", json!({"const": "sign_in_clicked"})),
                                ("page", json!({"enum": ["home", "get_started", "sales_guide", "api_docs", "workspace"]})),
                            ]),
                            closed_object([
                                ("name", json!({"const": "journey_selected"})),
                                ("journey", json!({"enum": ["agent", "self_service"]})),
                            ]),
                            closed_object([("name", json!({"const": "helpful_vote"})), ("helpful", boolean())]),
                        ],
                    })),
                ]),
            })),
        ])),
    })
}

fn enable_analytics_attribution() -> Value {
    json!({
        "operationId": "enableAnalyticsAttribution",
        "security": [],
        "responses": {
            "204": {
                "description": "Clear the server-side optional-analytics opt-out flag; exact trusted Origin required.",
            },
            "403": response("Structured service error. No customer content or secrets.", object([("error", object([("code", string())]))])),
        },
    })
}

fn clear_analytics_attribution() -> Value {
    json!({
        "operationId": "clearAnalyticsAttribution",
        "security": [],
        "responses": {
            "204": {"description": "Pending attribution cleared. Exact trusted Origin required."},
            "403": response("Structured service error. No customer content or secrets.", object([("error", object([("code", string())]))])),
        },
    })
}
