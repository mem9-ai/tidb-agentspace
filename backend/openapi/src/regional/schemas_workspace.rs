use super::*;

pub(super) fn schemas() -> Value {
    json!({
        "Resource": resource_schema(),
        "Key": key_schema(),
        "Error": error(),
        "Workspace": workspace(),
        "Profile": profile(),
        "Event": event_schema(),
        "Usage": usage(),
        "Capability": capability_schema(),
        "Capabilities": capabilities(),
        "Bootstrap": bootstrap(),
        "ResourceSetupAttempt": resource_setup_attempt(),
        "SalesSampleAttempt": sales_sample_attempt(),
        "TutorialInput": tutorial_input(),
        "Tutorial": tutorial(),
        "RegionalEnrollment": regional_enrollment(),
        "RegionalToken": regional_token(),
        "RegionalFamily": regional_family(),
        "RegionalIssuance": regional_issuance(),
    })
}

fn resource_schema() -> Value {
    json!({
        "type": "object",
        "required": ["id", "name", "kind", "region", "regionId", "status", "createdAt"],
        "properties": {
            "id": string(),
            "name": string(),
            "kind": {"type": "string", "description": "Resource kind. Clients must skip kinds they do not recognize."},
            "region": {
                "type": "string",
                "description": "Provider-assigned data location; may be automatic and is distinct from the Workspace Region.",
            },
            "regionId": {
                "type": "string",
                "description": "Region control plane owning this resource. Legacy records are interpreted in their existing Region.",
            },
            "status": {"enum": ["active", "provisioning", "failed", "suspended", "deleting", "deleted", "expired"]},
            "provider": {
                "type": "string",
                "description": "Missing on legacy local resources. PostgreSQL-compatible databases support NUMERIC values of up to 28–29 significant digits. Provider compatibility limits apply.",
            },
            "deletion": object([
                ("phase", json!({"enum": ["outcome-unknown", "provider-accepted", "completed"]})),
                ("requestedAt", json!({"type": "string", "format": "date-time"})),
            ]),
            "allowedActions": array(string()),
            "capabilities": object([
                ("delete", boolean()),
                ("deletionCompletion", json!({"enum": ["synchronous", "providerStatus", "operatorReconciliation", "unsupported"]})),
                ("readOnlyQueries", boolean()),
                ("conditionalFileWrites", boolean()),
            ]),
            "uploadLimitBytes": {
                "type": "integer",
                "description": "Negotiated gateway upload limit; zero means uploads are unavailable.",
            },
            "connectionError": string(),
            "isDefault": {"type": "boolean", "description": "The File System created for a new Workspace."},
            "expiresAt": {
                "type": "string",
                "format": "date-time",
                "description": "Expiry reported by the database provider. No automatic renewal or replacement.",
            },
            "createdAt": {"type": "string", "format": "date-time"},
        },
    })
}

fn key_schema() -> Value {
    object([
        ("id", string()),
        ("name", string()),
        ("prefix", string()),
        ("scopes", array(string())),
        (
            "resourceIds",
            json!({
                "type": "array",
                "items": string(),
                "description": "Explicit allowed resource IDs, or [\"*\"] for all current and future resources.",
            }),
        ),
        (
            "createdAt",
            json!({"type": "string", "format": "date-time"}),
        ),
        (
            "expiresAt",
            json!({"type": "string", "format": "date-time"}),
        ),
        ("lastUsedAt", json!({"type": ["string", "null"]})),
        ("revokedAt", json!({"type": ["string", "null"]})),
    ])
}

fn error() -> Value {
    object([(
        "error",
        object([
            ("code", string()),
            ("message", string()),
            ("requestId", string()),
        ]),
    )])
}

fn workspace() -> Value {
    object([
        ("id", string()),
        ("name", string()),
        ("description", string()),
        ("plan", string()),
        (
            "defaultRegionId",
            json!({
                "type": "string",
                "description": "Default Region for new resources. Currently only this Region is available.",
            }),
        ),
        (
            "createdAt",
            json!({"type": "string", "format": "date-time"}),
        ),
    ])
}

fn profile() -> Value {
    object([("name", string()), ("email", string()), ("role", string())])
}

fn event_schema() -> Value {
    json!({
        "type": "object",
        "required": ["id", "action", "resource", "actor", "at", "outcome"],
        "properties": {
            "id": string(),
            "action": string(),
            "resource": string(),
            "resourceId": {"type": ["string", "null"]},
            "actor": string(),
            "at": string(),
            "outcome": string(),
        },
    })
}

fn usage() -> Value {
    object([
        ("resourceId", string()),
        ("name", string()),
        ("kind", string()),
        ("storageBytes", json!({"type": ["integer", "null"]})),
        ("storageLimitBytes", json!({"type": ["integer", "null"]})),
        ("monthlyRU", json!({"type": ["integer", "null"]})),
        ("monthlyRULimit", json!({"type": ["integer", "null"]})),
        ("fileCount", json!({"type": ["integer", "null"]})),
        ("measured", boolean()),
    ])
}

fn capability_schema() -> Value {
    json!({
        "type": "object",
        "required": ["label", "regions", "storageGiB", "preview"],
        "properties": {
            "label": string(),
            "regions": array(json!({
                "type": "string",
                "description": "Advertised provider location. Clients may encounter new locations.",
            })),
            "storageGiB": {"type": ["number", "null"]},
            "monthlyRU": {"type": ["number", "null"]},
            "maxFiles": {"type": ["integer", "null"]},
            "preview": boolean(),
            "provider": string(),
            "available": {
                "type": "boolean",
                "description": "False when this resource provider is not configured or available.",
            },
        },
    })
}

fn capabilities() -> Value {
    let mut schema = object([
        ("postgresql", reference("Capability")),
        ("filesystem", reference("Capability")),
    ]);
    schema["additionalProperties"] = reference("Capability");
    schema["description"] =
        json!("Ignore unrecognized capability entries when selecting an operation.");
    schema
}

fn bootstrap() -> Value {
    json!({
        "type": "object",
        "required": [
            "workspace",
            "profile",
            "resources",
            "files",
            "keys",
            "events",
            "usage",
            "queryCount",
            "capabilities",
            "mode",
        ],
        "properties": {
            "workspace": reference("Workspace"),
            "profile": reference("Profile"),
            "resources": array(reference("Resource")),
            "resourceNextCursor": {
                "type": ["string", "null"],
                "description": "Continuation for the bounded initial resource page; counts are for loaded resources.",
            },
            "files": array(reference("File")),
            "keys": array(reference("Key")),
            "keysNextCursor": {"type": ["string", "null"], "description": "Continuation for the bounded initial Key page."},
            "events": array(reference("Event")),
            "usage": array(reference("Usage")),
            "queryCount": integer(),
            "capabilities": reference("Capabilities"),
            "mode": {"enum": ["demo", "hybrid"]},
        },
    })
}

fn resource_setup_attempt() -> Value {
    object([
        ("id", json!({"type": "string", "format": "uuid"})),
        ("resourceId", string()),
        (
            "createdAt",
            json!({"type": "string", "format": "date-time"}),
        ),
        (
            "updatedAt",
            json!({"type": "string", "format": "date-time"}),
        ),
        (
            "status",
            json!({"enum": ["succeeded", "failed", "outcome-unknown"]}),
        ),
        ("errorCode", json!({"type": ["string", "null"]})),
        ("resource", reference("Resource")),
    ])
}

fn sales_sample_attempt() -> Value {
    json!({
        "type": "object",
        "required": [
            "id",
            "fixture",
            "status",
            "resourceId",
            "path",
            "fileVersion",
            "errorCode",
            "createdAt",
            "updatedAt",
        ],
        "properties": {
            "id": {"type": "string", "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},
            "fixture": {"const": "us-sales-v1"},
            "status": {"enum": ["preparing", "ready", "failed", "outcome_unknown"]},
            "resourceId": {"type": ["string", "null"], "minLength": 1},
            "path": {"type": ["string", "null"], "enum": ["/us-sales.csv", null]},
            "fileVersion": {"type": ["string", "null"], "maxLength": 256, "pattern": "^\"[A-Za-z0-9-]+\"$"},
            "errorCode": {"type": ["string", "null"]},
            "createdAt": {"type": "string", "format": "date-time"},
            "updatedAt": {"type": "string", "format": "date-time"},
        },
        "additionalProperties": false,
        "allOf": [
            {
                "if": {"properties": {"status": {"const": "ready"}}},
                "then": {
                    "properties": {
                        "resourceId": {"type": "string", "minLength": 1},
                        "path": {"const": "/us-sales.csv"},
                        "fileVersion": {"type": "string", "minLength": 1},
                    },
                },
            },
        ],
    })
}

fn tutorial_input() -> Value {
    closed_object([
        (
            "sampleId",
            json!({"type": "string", "pattern": "^[a-f0-9]{32}$"}),
        ),
        (
            "state",
            json!({"enum": ["pending", "attempted", "ready", "completed"]}),
        ),
    ])
}

fn tutorial() -> Value {
    object([
        (
            "sampleId",
            json!({"type": "string", "pattern": "^[a-f0-9]{32}$"}),
        ),
        (
            "state",
            json!({"enum": ["pending", "attempted", "ready", "completed"]}),
        ),
        ("resourceId", string()),
        (
            "version",
            json!({
                "type": "string",
                "pattern": "^\"tutorial-[a-f0-9]{32}\"$",
                "description": "Strong opaque ETag, including quotes. Send unchanged in If-Match.",
            }),
        ),
        (
            "updatedAt",
            json!({"type": "string", "format": "date-time"}),
        ),
    ])
}

fn regional_enrollment() -> Value {
    closed_object([
        ("keyId", string()),
        ("familyId", string()),
        ("refreshCredential", string()),
        ("nonce", string()),
        ("expiresAt", json!({"type": "integer", "minimum": 1})),
    ])
}

fn regional_token() -> Value {
    closed_object([
        ("id", string()),
        ("accessToken", string()),
        ("tokenType", json!({"const": "Bearer"})),
        ("expiresAt", json!({"type": "integer", "minimum": 1})),
        ("refreshCredential", string()),
        ("refreshExpiresAt", json!({"type": "integer", "minimum": 1})),
        ("nonce", string()),
        ("familyId", string()),
        ("keyId", string()),
        ("scopes", array(string())),
    ])
}

fn regional_family() -> Value {
    closed_object([
        ("id", string()),
        ("keyId", string()),
        ("keyVersion", json!({"type": "integer", "minimum": 1})),
        ("generation", json!({"type": "integer", "minimum": 1})),
        ("securityEpoch", json!({"type": "integer", "minimum": 1})),
        ("expiresAt", json!({"type": "integer", "minimum": 1})),
        ("revoked", boolean()),
    ])
}

fn regional_issuance() -> Value {
    closed_object([
        ("id", string()),
        ("keyId", string()),
        ("familyId", string()),
        ("principalId", string()),
        ("expiresAt", json!({"type": "integer", "minimum": 1})),
        ("status", json!({"const": "issued"})),
    ])
}
