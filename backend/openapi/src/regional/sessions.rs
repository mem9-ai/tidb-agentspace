use super::*;

pub(super) fn paths() -> Value {
    json!({
        "/api/health": {"servers": [{"url": "/"}], "get": get_health()},
        "/api/session": {"servers": [{"url": "/"}], "post": create_local_session()},
        "/api/portal/auth/session-exchanges": {"servers": [{"url": "/"}], "post": exchange_portal_region_session()},
        "/api/auth/config": {"servers": [{"url": "/"}], "get": get_auth_config()},
        "/api/auth/guest": {"servers": [{"url": "/"}], "post": start_guest_session()},
        "/api/auth/guest/logout": {"servers": [{"url": "/"}], "post": logout_guest_session()},
        "/api/auth/tidbcloud/login": {"servers": [{"url": "/"}], "get": start_tidb_login()},
        "/api/auth/tidbcloud/callback": {"servers": [{"url": "/"}], "get": complete_tidb_login()},
        "/api/auth/tidbcloud/logout": {
            "servers": [{"url": "/"}],
            "post": logout_tidb_session(),
            "get": logout_tidb_session_and_redirect(),
        },
    })
}

fn get_health() -> Value {
    json!({
        "operationId": "getHealth",
        "security": [],
        "responses": {
            "200": response("Success", object([
                ("status", json!({"const": "ok"})),
                ("mode", json!({
                    "enum": ["demo", "hybrid"],
                    "description": "Configured provider mode, not a count or a health check of provisioned resources.",
                })),
                ("filesProvider", string()),
            ])),
            "503": response("Configured metadata authority is unavailable; no fallback state is seeded", reference("Error")),
        },
    })
}

fn create_local_session() -> Value {
    json!({
        "operationId": "createLocalSession",
        "summary": "Create a loopback-only demo owner session",
        "tags": ["Workspace"],
        "description": "Explicit loopback guest mode only; disabled when TiDB Account SSO is configured. Requires a real loopback peer. Sets an HttpOnly SameSite=Strict cookie scoped to the configured public path.",
        "x-required-scope": null,
        "security": [],
        "requestBody": request(object([])),
        "responses": responses(json!({
            "200": response("Success", object([("workspaceId", string()), ("mode", json!({"const": "demo"}))])),
        })),
    })
}

fn exchange_portal_region_session() -> Value {
    json!({
        "operationId": "exchangePortalRegionSession",
        "security": [],
        "description": "Redeem one Global-issued, Region-bound, short-lived ticket exactly once to establish a Region Portal session.",
        "parameters": [
            {
                "name": "Origin",
                "in": "header",
                "required": true,
                "schema": {"type": "string", "format": "uri"},
            },
        ],
        "requestBody": request(object([("ticket", string())])),
        "responses": {
            "200": response("Success", object([("workspaceId", string())])),
            "400": response("Success", reference("Error")),
            "401": response("Success", reference("Error")),
            "403": response("Success", reference("Error")),
        },
    })
}

fn get_auth_config() -> Value {
    json!({
        "operationId": "getAuthConfig",
        "security": [],
        "responses": {
            "200": response("Success", json!({
                "type": "object",
                "required": ["enabled"],
                "properties": {
                    "enabled": boolean(),
                    "globalApi": object([("apiOrigin", json!({"type": "string", "format": "uri"})), ("apiPathPrefix", string())]),
                    "regionId": string(),
                    "guestEnabled": boolean(),
                    "guestCleanupEnabled": boolean(),
                    "sessionKind": {"type": "string", "enum": ["account", "guest"]},
                    "account": {
                        "type": "object",
                        "required": [],
                        "properties": {
                            "name": {"type": "string", "minLength": 1, "maxLength": 200},
                            "email": {"type": "string", "format": "email", "maxLength": 320},
                        },
                        "description": "Display-only profile from the verified TiDB Cloud login, available only to its authenticated browser session. Absent for Guests, signed-out browsers and older sessions; sign in again to populate it.",
                    },
                    "workspaceId": {
                        "type": ["string", "null"],
                        "description": "Workspace selected by this verified browser session, or null for a signed-out browser. Hosts requiring separate discovery omit this field.",
                    },
                    "provider": {"const": "tidbcloud"},
                    "label": string(),
                    "loginPath": string(),
                    "logoutPath": string(),
                },
            })),
        },
    })
}

fn start_guest_session() -> Value {
    json!({
        "operationId": "startGuestSession",
        "security": [],
        "description": "Start or resume a Guest session from a trusted origin. A new session sets a secure, HttpOnly, SameSite=Strict cookie with an absolute expiry.",
        "responses": {
            "200": response("Success", json!({
                "type": "object",
                "required": ["workspaceId"],
                "properties": {
                    "workspaceId": string(),
                    "initialFileSystemRegion": {
                        "type": "string",
                        "enum": ["aws-us-east-1", "aws-us-west-2", "automatic", "aws-ap-southeast-1"],
                        "description": "Configured first File System location, supplied only on fresh enrollment. The Console may start the owner-only, idempotent initial resource request while loading the Workspace.",
                    },
                },
            })),
            "404": response("Guest sign-in is disabled", reference("Error")),
            "default": response("Guest sign-in unavailable or denied", reference("Error")),
        },
    })
}

fn logout_guest_session() -> Value {
    json!({
        "operationId": "logoutGuestSession",
        "security": [{"guestOwner": []}],
        "description": "End an authenticated Guest Workspace session and durably schedule resource cleanup. Provider deletion can be asynchronous, unsupported or require reconciliation; acceptance is not proof of deletion.",
        "responses": {
            "200": response("Success", object([("loggedOut", boolean()), ("cleanup", json!({"const": "scheduled"}))])),
            "default": response("Guest logout or cleanup scheduling unavailable", reference("Error")),
        },
    })
}

fn start_tidb_login() -> Value {
    json!({
        "operationId": "startTidbLogin",
        "security": [],
        "description": "Browser redirect to the configured provider using code + S256 PKCE. Server retains a single-use ten-minute flow.",
        "responses": {
            "302": {
                "description": "Redirect to provider or configured same-origin Console; sets HttpOnly flow/session cookies.",
            },
            "default": response("Sign-in unavailable, invalid or unauthorized", reference("Error")),
        },
    })
}

fn complete_tidb_login() -> Value {
    json!({
        "operationId": "completeTidbLogin",
        "security": [],
        "description": "Registered Portal callback; verifies signature, issuer, audience and nonce with single-use, cookie-bound state. Managed hosts establish a Workspace-bound aw_account continuity grant. When Global shares the Portal listener, this same verified callback also issues a distinct eight-hour aw_global_owner session after Global Directory membership checks. No second provider login/callback is needed. Explicit local/legacy profiles issue an eight-hour aw_session.",
        "responses": {
            "302": {
                "description": "Redirect to provider or configured same-origin Console; sets HttpOnly flow/session cookies.",
            },
            "default": response("Sign-in unavailable, invalid or unauthorized", reference("Error")),
        },
    })
}

fn logout_tidb_session() -> Value {
    json!({
        "operationId": "logoutTidbSession",
        "security": [],
        "description": "Revoke the TiDB Account session and attached Guest cookie. Bundled Portal deployments also revoke the attached Global Owner session and clear both cookies. Guest-only sessions must use POST /api/auth/guest/logout to schedule cleanup.",
        "responses": {"200": response("Success", object([("loggedOut", boolean())]))},
    })
}

fn logout_tidb_session_and_redirect() -> Value {
    json!({
        "operationId": "logoutTidbSessionAndRedirect",
        "security": [],
        "description": "Revoke the TiDB Account session and attached Guest cookie, then redirect. Guest-only sessions must use POST /api/auth/guest/logout.",
        "responses": {
            "200": response("Success", object([("loggedOut", boolean())])),
            "302": {"description": "Session revoked and browser redirected to the configured Console."},
        },
    })
}
