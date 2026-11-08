use crate::schema::*;
use serde_json::{Value, json};

mod discovery;
mod keys;
mod schemas;
mod sessions;

pub(crate) fn paths() -> Value {
    merge([discovery::paths(), sessions::paths(), keys::paths()])
}
pub(crate) fn schemas() -> Value {
    schemas::schemas()
}

pub(super) fn workspace_id_parameter() -> Value {
    json!({
        "name": "workspaceId",
        "in": "path",
        "required": true,
        "schema": {"type": "string", "pattern": "^[A-Za-z0-9_.:-]{1,128}$"},
    })
}

pub(super) fn origin_parameter() -> Value {
    json!({
        "name": "Origin",
        "in": "header",
        "required": true,
        "schema": {"type": "string", "format": "uri"},
        "description": "Must equal the Global public origin or an explicitly trusted Console origin for Owner mutations.",
    })
}

pub(super) fn idempotency_key_parameter() -> Value {
    json!({
        "name": "Idempotency-Key",
        "in": "header",
        "required": true,
        "schema": {"type": "string", "format": "uuid"},
        "description": "Operation identity. A repeated secret-producing operation never returns another secret. Resolve uncertain outcomes; do not blindly repeat.",
    })
}

pub(super) fn if_match_parameter() -> Value {
    json!({
        "name": "If-Match",
        "in": "header",
        "required": true,
        "schema": string(),
        "description": "Quoted current Key version ETag.",
    })
}

pub(super) fn responses(overrides: Value) -> Value {
    extend(
        json!({
            "default": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        }),
        overrides,
    )
}

pub(super) fn security_schemes() -> Value {
    json!({
        "globalOwner": json!({"type": "apiKey", "in": "cookie", "name": "aw_global_owner"}),
        "globalAccess": json!({"type": "http", "scheme": "bearer", "bearerFormat": "Global JWT"}),
        "workspaceKey": json!({
            "type": "http",
            "scheme": "bearer",
            "description": "Workspace Key is sent only to Global token issuance, never forwarded to Region.",
        }),
    })
}
