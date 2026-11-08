use super::*;

pub(super) fn paths() -> Value {
    json!({
        "/api/portal/v1/workspaces/{workspaceId}/regional-session-tickets": {"post": create_portal_region_session_ticket()},
        "/api/portal/v1/workspaces/{workspaceId}/key-policy-deliveries": {"post": create_global_key_policy_delivery()},
        "/api/portal/v1/workspaces/{workspaceId}/key-policy-deliveries/{deliveryId}": {"get": get_global_key_policy_delivery()},
        "/api/portal/v1/workspaces/{workspaceId}/keys": {"get": list_global_keys(), "post": create_global_key()},
        "/api/portal/v1/workspaces/{workspaceId}/keys/{keyId}": {"get": get_global_key(), "patch": renew_global_key(), "delete": revoke_global_key()},
        "/api/portal/v1/workspaces/{workspaceId}/keys/{keyId}/versions": {"post": rotate_global_key()},
        "/api/portal/v1/workspaces/{workspaceId}/keys/{keyId}/versions/{version}": {"get": get_global_key_version()},
        "/api/portal/v1/workspaces/{workspaceId}/key-revocations/{revocationId}": {"get": get_global_key_revocation()},
    })
}

fn create_portal_region_session_ticket() -> Value {
    json!({
        "operationId": "createPortalRegionSessionTicket",
        "summary": "Create Portal Region Session Ticket",
        "security": [{"globalOwner": []}],
        "parameters": [workspace_id_parameter(), origin_parameter()],
        "responses": {
            "201": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {
                    "application/json": {
                        "schema": closed_object([
                            ("ticket", string()),
                            ("region", reference("Region")),
                            ("expiresIn", json!({"const": 60})),
                        ]),
                    },
                },
            },
            "default": {
                "description": "Structured denial or unknown outcome; no credential is echoed.",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
        "description": "Create a short-lived one-use user-session exchange ticket for the Workspace Region. A verified Portal Owner session is required.",
    })
}

fn create_global_key_policy_delivery() -> Value {
    json!({
        "operationId": "createGlobalKeyPolicyDelivery",
        "summary": "Create Global Key Policy Delivery",
        "security": [{"globalOwner": []}],
        "parameters": [workspace_id_parameter(), idempotency_key_parameter(), origin_parameter()],
        "responses": {
            "201": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {
                    "application/json": {
                        "schema": closed_object([
                            ("data", closed_object([
                                ("id", string()),
                                ("keyId", string()),
                                ("keyVersion", json!({"type": "integer", "minimum": 1})),
                                ("regionalStatus", json!({"enum": ["pending", "applied"]})),
                                ("regionalContinuity", json!({"enum": ["pending", "eligible", "unavailable"]})),
                            ])),
                        ]),
                    },
                },
            },
            "default": {
                "description": "Structured denial or unknown outcome; no credential is echoed.",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
        "requestBody": request(closed_object([("keyId", string()), ("keyVersion", json!({"type": "integer", "minimum": 1}))])),
        "description": "Explicit bounded application attempt for the current Key version, including revoked Keys. Replays reconcile the same immutable command. The Region connection profile also reconciles durable pending changes after reconnection.",
    })
}

fn get_global_key_policy_delivery() -> Value {
    json!({
        "operationId": "getGlobalKeyPolicyDelivery",
        "summary": "Get Global Key Policy Delivery",
        "security": [{"globalOwner": []}],
        "parameters": [
            workspace_id_parameter(),
            {"name": "deliveryId", "in": "path", "required": true, "schema": string()},
        ],
        "responses": {
            "200": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {
                    "application/json": {
                        "schema": closed_object([
                            ("data", closed_object([
                                ("id", string()),
                                ("keyId", string()),
                                ("keyVersion", json!({"type": "integer", "minimum": 1})),
                                ("regionalStatus", json!({"enum": ["pending", "applied"]})),
                                ("regionalContinuity", json!({"enum": ["pending", "eligible", "unavailable"]})),
                            ])),
                        ]),
                    },
                },
            },
            "default": {
                "description": "Structured denial or unknown outcome; no credential is echoed.",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
        "description": "Observe durable application evidence without contacting Region or retrying effects.",
    })
}

fn list_global_keys() -> Value {
    json!({
        "operationId": "listGlobalKeys",
        "summary": "List Global Keys",
        "security": [{"globalOwner": []}],
        "parameters": [
            workspace_id_parameter(),
            {"name": "cursor", "in": "query", "schema": string()},
            {
                "name": "limit",
                "in": "query",
                "schema": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50},
            },
        ],
        "responses": {
            "200": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {
                    "application/json": {
                        "schema": closed_object([
                            ("data", array(closed_object([
                                ("data", reference("Key")),
                                ("grants", reference("Grants")),
                                ("regionalStatus", json!({"enum": ["pending", "applied"]})),
                            ]))),
                            ("nextCursor", json!({"type": ["string", "null"]})),
                        ]),
                    },
                },
            },
            "default": {
                "description": "Structured denial or unknown outcome; no credential is echoed.",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
    })
}

fn create_global_key() -> Value {
    json!({
        "operationId": "createGlobalKey",
        "summary": "Create Global Key",
        "security": [{"globalOwner": []}],
        "parameters": [workspace_id_parameter(), idempotency_key_parameter(), origin_parameter()],
        "responses": {
            "201": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {
                    "application/json": {
                        "schema": closed_object([
                            ("data", reference("Key")),
                            ("secret", string()),
                            ("grants", reference("Grants")),
                            ("regionalStatus", json!({"enum": ["pending", "applied"]})),
                        ]),
                    },
                },
            },
            "default": {
                "description": "Structured denial or unknown outcome; no credential is echoed.",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
        "requestBody": request(json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "name": {"type": "string", "minLength": 1, "maxLength": 80, "default": "Agent key"},
                "scopes": {"type": "array", "items": string(), "minItems": 1, "maxItems": 8},
                "resourceIds": {"type": "array", "items": string(), "minItems": 1, "maxItems": 1024},
                "expiresAt": {"type": "integer", "minimum": 1},
            },
            "required": ["scopes", "resourceIds", "expiresAt"],
        })),
        "description": "Owner only. Unix-second expiry. Store the returned secret securely; it cannot be retrieved or returned again.",
    })
}

fn get_global_key() -> Value {
    json!({
        "operationId": "getGlobalKey",
        "summary": "Get Global Key",
        "security": [{"globalOwner": []}],
        "parameters": [workspace_id_parameter(), {"name": "keyId", "in": "path", "required": true, "schema": string()}],
        "responses": {
            "200": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {
                    "application/json": {
                        "schema": closed_object([
                            ("data", reference("Key")),
                            ("grants", reference("Grants")),
                            ("regionalStatus", json!({"enum": ["pending", "applied"]})),
                        ]),
                    },
                },
            },
            "default": {
                "description": "Structured denial or unknown outcome; no credential is echoed.",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
    })
}

fn renew_global_key() -> Value {
    json!({
        "operationId": "renewGlobalKey",
        "summary": "Renew Global Key",
        "security": [{"globalOwner": []}],
        "parameters": [
            workspace_id_parameter(),
            {"name": "keyId", "in": "path", "required": true, "schema": string()},
            idempotency_key_parameter(),
            if_match_parameter(),
            origin_parameter(),
        ],
        "responses": {
            "200": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {
                    "application/json": {
                        "schema": closed_object([
                            ("data", reference("Key")),
                            ("regionalStatus", json!({"enum": ["pending", "applied"]})),
                            ("regionalContinuity", json!({"enum": ["pending", "eligible", "unavailable"]})),
                        ]),
                    },
                },
            },
            "default": {
                "description": "Structured denial or unknown outcome; no credential is echoed.",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
        "requestBody": request(closed_object([("expiresAt", json!({"type": "integer", "minimum": 1}))])),
        "description": "Extends expiry while retaining the Key secret, advances Key version and invalidates old Global Tokens. Regional application is reported separately. Only an explicit same-secret renewal durably observed by both authorities before the previous expiry enables existing proof-bound families to cross versions. An unreachable Region remains pending; unavailable continuity requires fresh enrollment.",
    })
}

fn revoke_global_key() -> Value {
    json!({
        "operationId": "revokeGlobalKey",
        "summary": "Revoke Global Key",
        "security": [{"globalOwner": []}],
        "parameters": [
            workspace_id_parameter(),
            {"name": "keyId", "in": "path", "required": true, "schema": string()},
            idempotency_key_parameter(),
            if_match_parameter(),
            origin_parameter(),
        ],
        "responses": {
            "202": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {
                    "application/json": {
                        "schema": closed_object([("id", string()), ("regionalStatus", json!({"enum": ["pending", "applied"]}))]),
                    },
                },
            },
            "default": {
                "description": "Structured denial or unknown outcome; no credential is echoed.",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
    })
}

fn rotate_global_key() -> Value {
    json!({
        "operationId": "rotateGlobalKey",
        "summary": "Rotate Global Key",
        "security": [{"globalOwner": []}],
        "parameters": [
            workspace_id_parameter(),
            {"name": "keyId", "in": "path", "required": true, "schema": string()},
            idempotency_key_parameter(),
            if_match_parameter(),
            origin_parameter(),
        ],
        "responses": {
            "201": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {
                    "application/json": {
                        "schema": closed_object([
                            ("data", reference("Key")),
                            ("secret", string()),
                            ("regionalStatus", json!({"enum": ["pending", "applied"]})),
                        ]),
                    },
                },
            },
            "default": {
                "description": "Structured denial or unknown outcome; no credential is echoed.",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
    })
}

fn get_global_key_version() -> Value {
    json!({
        "operationId": "getGlobalKeyVersion",
        "summary": "Get Global Key Version",
        "security": [{"globalOwner": []}],
        "parameters": [
            workspace_id_parameter(),
            {"name": "keyId", "in": "path", "required": true, "schema": string()},
            {"name": "version", "in": "path", "required": true, "schema": string()},
        ],
        "responses": {
            "200": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": closed_object([("data", reference("Key"))])}},
            },
            "default": {
                "description": "Structured denial or unknown outcome; no credential is echoed.",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
    })
}

fn get_global_key_revocation() -> Value {
    json!({
        "operationId": "getGlobalKeyRevocation",
        "summary": "Get Global Key Revocation",
        "security": [{"globalOwner": []}],
        "parameters": [
            workspace_id_parameter(),
            {"name": "revocationId", "in": "path", "required": true, "schema": string()},
        ],
        "responses": {
            "200": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {
                    "application/json": {
                        "schema": closed_object([
                            ("data", closed_object([
                                ("id", string()),
                                ("keyId", string()),
                                ("keyVersion", json!({"type": "integer", "minimum": 1})),
                                ("regionalStatus", json!({"enum": ["pending", "applied"]})),
                            ])),
                        ]),
                    },
                },
            },
            "default": {
                "description": "Structured denial or unknown outcome; no credential is echoed.",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
    })
}
