use super::*;

pub(super) fn paths() -> Value {
    json!({
        "/api/health": {"get": get_global_health()},
        "/api/auth/config": {"get": get_global_auth_config()},
        "/api/auth/session": {"get": get_global_owner_session()},
        "/api/session": {"post": create_local_global_owner_session()},
        "/api/auth/tidbcloud/login": {"get": start_global_owner_login()},
        "/api/auth/tidbcloud/callback": {"get": complete_global_owner_login()},
        "/api/auth/tidbcloud/logout": {"post": revoke_global_owner_session()},
    })
}

fn get_global_health() -> Value {
    json!({
        "operationId": "getGlobalHealth",
        "security": [],
        "responses": responses(json!({
            "200": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {
                    "application/json": {
                        "schema": closed_object([("status", json!({"const": "ok"})), ("authority", json!({"const": "global"}))]),
                    },
                },
            },
        })),
    })
}

fn get_global_auth_config() -> Value {
    json!({
        "operationId": "getGlobalAuthConfig",
        "security": [],
        "responses": responses(json!({
            "200": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {
                    "application/json": {
                        "schema": closed_object([
                            ("mode", json!({"enum": ["local", "oidc"]})),
                            ("loginPath", string()),
                            ("localSessionPath", string()),
                        ]),
                    },
                },
            },
        })),
    })
}

fn get_global_owner_session() -> Value {
    json!({
        "operationId": "getGlobalOwnerSession",
        "security": [{"globalOwner": []}],
        "parameters": [{"name": "workspaceId", "in": "query", "required": true, "schema": string()}],
        "responses": responses(json!({
            "200": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {
                    "application/json": {"schema": closed_object([("workspaceId", string()), ("regionId", string())])},
                },
            },
        })),
    })
}

fn create_local_global_owner_session() -> Value {
    json!({
        "operationId": "createLocalGlobalOwnerSession",
        "security": [],
        "description": "Explicit development profile only, real loopback peer and trusted Origin required. Unavailable in hosted deployments.",
        "parameters": [origin_parameter()],
        "responses": responses(json!({
            "201": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {
                    "application/json": {"schema": closed_object([("workspaceId", string()), ("regionId", string())])},
                },
            },
        })),
    })
}

fn start_global_owner_login() -> Value {
    json!({
        "operationId": "startGlobalOwnerLogin",
        "security": [],
        "description": "Bundled hosted deployments redirect to the existing Portal login; its single verified callback establishes both separate sessions. Independently configured Global OIDC deployments begin their own registered flow.",
        "parameters": [
            {
                "name": "workspaceId",
                "in": "query",
                "required": false,
                "schema": string(),
                "description": "Optional for first login when one Region is configured and registered.",
            },
            {
                "name": "returnTo",
                "in": "query",
                "schema": {"type": "string", "format": "uri"},
                "description": "Optional return URL on an explicitly trusted Console origin.",
            },
        ],
        "responses": responses(json!({
            "303": {
                "description": "Redirect to the existing Portal sign-in or the explicitly configured identity provider.",
            },
        })),
    })
}

fn complete_global_owner_login() -> Value {
    json!({
        "operationId": "completeGlobalOwnerLogin",
        "security": [],
        "parameters": [
            {"name": "code", "in": "query", "required": true, "schema": string()},
            {"name": "state", "in": "query", "required": true, "schema": string()},
        ],
        "responses": responses(json!({
            "200": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {
                    "application/json": {
                        "schema": closed_object([
                            ("workspaceId", string()),
                            ("regionId", string()),
                            ("expiresAt", json!({"type": "integer", "minimum": 1})),
                        ]),
                    },
                },
            },
            "303": {"description": "Owner cookie issued; redirect to the validated Console return URL."},
        })),
        "description": "For independently configured Global OIDC only: verified one-use PKCE callback with browser-bound state and Global Directory membership. Bundled Portal deployments use their existing Portal callback instead and do not register or enable this second callback.",
    })
}

fn revoke_global_owner_session() -> Value {
    json!({
        "operationId": "revokeGlobalOwnerSession",
        "security": [{"globalOwner": []}],
        "parameters": [{"name": "workspaceId", "in": "query", "required": true, "schema": string()}, origin_parameter()],
        "responses": responses(json!({
            "204": {"description": "Durably revoked the Global Owner session and cleared the host-only cookie."},
        })),
    })
}
