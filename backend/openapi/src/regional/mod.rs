use crate::PORTAL_ACCESS;
use crate::schema::*;
use serde_json::{Value, json};

mod database;
mod files;
mod history;
mod schemas_database;
mod schemas_files;
mod schemas_history;
mod schemas_workspace;
mod sessions;
mod tokens;
mod trial;
mod workspace;

pub(crate) fn paths() -> Value {
    merge([
        workspace::paths(),
        files::paths(),
        database::paths(),
        history::paths(),
        sessions::paths(),
        tokens::paths(),
        trial::paths(),
    ])
}
pub(crate) fn schemas() -> Value {
    merge([
        schemas_workspace::schemas(),
        schemas_files::schemas(),
        schemas_database::schemas(),
        schemas_history::schemas(),
    ])
}

pub(super) fn workspace_id() -> Value {
    json!({
        "name": "workspaceId",
        "in": "path",
        "required": true,
        "schema": {"type": "string", "minLength": 1, "maxLength": 128, "pattern": "^[A-Za-z0-9_.:-]+$"},
        "description": "A Workspace ID returned by the authenticated Workspace discovery API.",
    })
}

pub(super) fn resource_id_parameter() -> Value {
    json!({"name": "resourceId", "in": "path", "required": true, "schema": string()})
}

pub(super) fn if_match_parameter() -> Value {
    json!({
        "name": "If-Match",
        "in": "header",
        "schema": {"type": "string", "maxLength": 256},
        "description": "One strong opaque ETag returned by file metadata. No weak tags, wildcard or lists. Atomically reject a changed/missing file with 412. Mutually exclusive with If-None-Match.",
    })
}

pub(super) fn if_none_match_parameter() -> Value {
    json!({
        "name": "If-None-Match",
        "in": "header",
        "schema": {"const": "*"},
        "description": "Create only; an existing path returns 412. Mutually exclusive with If-Match.",
    })
}

pub(super) fn limit_parameter() -> Value {
    json!({
        "name": "limit",
        "in": "query",
        "schema": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50},
    })
}

pub(super) fn cursor_parameter() -> Value {
    json!({
        "name": "cursor",
        "in": "query",
        "schema": {"type": "string", "minLength": 1, "maxLength": 1024},
    })
}

pub(super) fn from_parameter() -> Value {
    json!({
        "name": "from",
        "in": "query",
        "schema": {"type": "string", "format": "date-time", "maxLength": 40},
    })
}

pub(super) fn to_parameter() -> Value {
    json!({
        "name": "to",
        "in": "query",
        "schema": {"type": "string", "format": "date-time", "maxLength": 40},
    })
}

pub(super) fn preparation_id_parameter() -> Value {
    json!({
        "name": "preparationId",
        "in": "path",
        "required": true,
        "schema": {"type": "string", "format": "uuid"},
    })
}

pub(super) fn workspace_id_parameter() -> Value {
    json!({"name": "workspaceId", "in": "path", "required": true, "schema": string()})
}

pub(super) fn dpop_parameter() -> Value {
    json!({
        "name": "DPoP",
        "in": "header",
        "required": true,
        "schema": string(),
        "description": "Ed25519 proof bound to POST, exact configured URI, server nonce, client thumbprint and fresh unique jti.",
    })
}

pub(super) fn family_id_parameter() -> Value {
    json!({"name": "familyId", "in": "path", "required": true, "schema": string()})
}

pub(super) fn report_schema() -> Value {
    closed_object([
        ("id", json!({"type": "string", "format": "uuid"})),
        ("sample", json!({"const": "us-sales-v1"})),
        (
            "markdown",
            json!({
                "type": ["string", "null"],
                "description": "Canonical UTF-8 report content, shared unchanged by local files and Workspace copies. Null before the first save.",
            }),
        ),
        ("sharingRevoked", boolean()),
        (
            "stateSales",
            json!({"type": ["object", "null"], "additionalProperties": integer()}),
        ),
        (
            "leadingStateProducts",
            json!({"type": ["object", "null"], "additionalProperties": integer()}),
        ),
        (
            "expiresAt",
            json!({"type": "integer", "description": "Unix seconds"}),
        ),
        (
            "revision",
            json!({"type": "integer", "minimum": 0, "maximum": 2}),
        ),
    ])
}

pub(super) fn responses(overrides: Value) -> Value {
    extend(
        json!({
            "400": response("Invalid request", reference("Error")),
            "401": response("Missing, invalid, expired, or revoked credential", reference("Error")),
            "403": response("Insufficient permission", reference("Error")),
            "404": response("Resource or endpoint not found", reference("Error")),
            "405": response("Resource lifecycle operation unsupported by provider", reference("Error")),
            "409": response("Conflict or free-tier limit", reference("Error")),
            "410": response("Temporary database expired", reference("Error")),
            "412": response("Version precondition failed without a write", reference("Error")),
            "413": response("Content too large", reference("Error")),
            "415": response("Unsupported content type", reference("Error")),
            "422": response("SQL syntax, result limit, or unsupported demo query", reference("Error")),
            "429": response("Provider quota or rate limit", reference("Error")),
            "502": response("Provider unavailable or invalid response", reference("Error")),
            "503": response("Provider binding needs operator recovery", reference("Error")),
            "504": response("SQL timeout; a write outcome may be unknown", reference("Error")),
        }),
        overrides,
    )
}

pub(super) const OWNER_DESCRIPTION: &str = "Requires an authenticated Workspace Owner session under the enabled account, Guest, or local/legacy profile. Region access Tokens cannot perform this Owner operation.";

pub(super) fn scope_description(scope: &str, details: &str) -> String {
    format!(
        "Required Region access Token scope: {scope}. Resource operations also require a matching resource ID, resource type, or workspace-wide wildcard. Lists are filtered to permitted resources.{PORTAL_ACCESS}{details}"
    )
}

fn workspace_security() -> Value {
    json!([{"regionalAccess":[]},{"localOwner":[]},{"accountOwner":[]},{"guestOwner":[]}])
}
fn owner_security() -> Value {
    json!([{"localOwner":[]},{"accountOwner":[]},{"guestOwner":[]}])
}
fn workspace_operation(
    id: &str,
    summary: &str,
    scope: &str,
    details: &str,
    fields: Value,
) -> Value {
    extend(
        json!({
            "operationId": id, "summary": summary, "tags": ["Workspace"],
            "description": scope_description(scope, details), "x-required-scope": scope,
            "security": workspace_security(),
        }),
        fields,
    )
}
fn owner_operation(id: &str, summary: &str, fields: Value) -> Value {
    extend(
        json!({
            "operationId": id, "summary": summary, "tags": ["Owner"],
            "description": OWNER_DESCRIPTION, "x-required-scope": null,
            "security": owner_security(),
        }),
        fields,
    )
}

pub(super) fn security_schemes() -> Value {
    json!({
        "localOwner": json!({
            "type": "apiKey",
            "in": "cookie",
            "name": "aw_session",
            "description": "Eight-hour, process-local Owner session for explicit local/legacy profiles, created by that profile's verified SSO callback or POST /api/session (loopback only). HttpOnly; Secure for HTTPS; logout revokes it. Managed account and regional Guest hosts use their separate credentials below.",
        }),
        "accountOwner": json!({
            "type": "apiKey",
            "in": "cookie",
            "name": "aw_account",
            "description": "Opaque, Workspace-bound regional Owner continuity grant issued after verified TiDB Account sign-in. Host-only, HttpOnly, SameSite=Strict and Secure on HTTPS. Browser-session cookie with no absolute server expiry; logout or regional policy denial revokes access. Existing grants survive Region restart and Global outage. Not a Workspace Key and never inferred from a Workspace URL.",
        }),
        "guestOwner": json!({
            "type": "apiKey",
            "in": "cookie",
            "name": "aw_guest",
            "description": "Opaque regional Guest Owner session issued by POST /api/auth/guest when enabled. Host-only, HttpOnly, Secure, SameSite=Strict, Workspace-bound and subject to its absolute Guest expiry. Guest logout revokes access and schedules scoped cleanup. Never grants access to an account or another Guest Workspace.",
        }),
        "regionalAccess": json!({
            "type": "http",
            "scheme": "bearer",
            "bearerFormat": "Region JWT",
            "description": "Audience-bound regional access. Checked against Region-local Key, grant, family, denial and policy checkpoints; never introspected at Global.",
        }),
        "regionalRefresh": json!({
            "type": "apiKey",
            "in": "header",
            "name": "Authorization",
            "description": "Refresh <credential>, bound to the enrolled client key and rotating nonce. Requires DPoP proof. Never sent to Global.",
        }),
        "trialSession": json!({
            "type": "apiKey",
            "in": "header",
            "name": "Authorization",
            "description": "Trial <session token>, usable only for the originating public-sample report.",
        }),
        "trialReportView": json!({
            "type": "apiKey",
            "in": "header",
            "name": "Authorization",
            "description": "TrialView v1.<publicKey>.<reportId>.<expiresAt>.<signature>. Sign the LF-separated UTF-8 lines drive9/trial/report-view/v1, canonical UUID, and original decimal Unix expiry with the project Ed25519 key. Key and signature use unpadded base64url.",
        }),
        "csvWorkspace": json!({
            "type": "apiKey",
            "in": "header",
            "name": "Authorization",
            "description": "CsvWorkspace followed by a space and 32 cryptographically random bytes encoded in hex. Generate once per project in the OS credential store. Use HTTPS; omit Cookie and Origin.",
        }),
    })
}
