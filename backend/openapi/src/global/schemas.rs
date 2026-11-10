use super::*;

pub(super) fn schemas() -> Value {
    json!({
        "Error": error(),
        "Key": key_schema(),
        "Grants": grants(),
        "Region": region(),
        "Issuance": issuance(),
        "Token": token(),
        "RegionToken": region_token(),
        "RegionAccessToken": region_access_token(),
        "DiscoveredToken": discovered_token(),
        "DiscoveredRegionAccessToken": discovered_region_access_token(),
        "DiscoveredRegionToken": discovered_region_token(),
    })
}

fn error() -> Value {
    closed_object([(
        "error",
        closed_object([
            ("code", string()),
            ("message", string()),
            ("requestId", string()),
        ]),
    )])
}

fn key_schema() -> Value {
    closed_object([
        (
            "name",
            json!({"type": "string", "minLength": 1, "maxLength": 80}),
        ),
        ("createdAt", json!({"type": "integer", "minimum": 0})),
        ("workspaceId", string()),
        ("keyId", json!({"type": "string", "format": "uuid"})),
        ("principalId", string()),
        ("keyVersion", json!({"type": "integer", "minimum": 1})),
        ("grantRef", string()),
        ("expiresAt", json!({"type": "integer", "minimum": 1})),
        ("revoked", boolean()),
    ])
}

fn grants() -> Value {
    let mut schema = closed_object([
        (
            "scopes",
            json!({"type": "array", "items": string(), "minItems": 1, "maxItems": 8}),
        ),
        (
            "resourceIds",
            json!({"type": "array", "items": string(), "maxItems": 1024}),
        ),
        ("regionId", string()),
    ]);
    schema["properties"]["resourceTypes"] = resource_types();
    schema
}

fn region() -> Value {
    closed_object([
        ("regionId", string()),
        ("apiOrigin", json!({"type": "string", "format": "uri"})),
        ("apiPathPrefix", string()),
    ])
}

fn issuance() -> Value {
    closed_object([
        ("id", string()),
        ("keyId", string()),
        ("principalId", string()),
        ("expiresAt", json!({"type": "integer", "minimum": 1})),
        ("audience", string()),
        ("status", json!({"const": "issued"})),
    ])
}

fn token() -> Value {
    closed_object([
        ("id", string()),
        ("accessToken", string()),
        ("tokenType", json!({"const": "Bearer"})),
        ("expiresAt", json!({"type": "integer", "minimum": 1})),
        ("scopes", array(string())),
    ])
}

fn region_token() -> Value {
    closed_object([
        ("id", string()),
        ("accessToken", string()),
        ("tokenType", json!({"const": "Bearer"})),
        ("expiresAt", json!({"type": "integer", "minimum": 1})),
        ("scopes", array(string())),
        ("keyId", string()),
        ("principalId", string()),
        ("keyVersion", json!({"type": "integer", "minimum": 1})),
        ("region", reference("Region")),
        ("enrollmentTicket", string()),
        (
            "enrollmentExpiresAt",
            json!({"type": "integer", "minimum": 1}),
        ),
        ("nonce", string()),
    ])
}

fn region_access_token() -> Value {
    closed_object([
        ("id", string()),
        ("accessToken", string()),
        ("tokenType", json!({"const": "Bearer"})),
        ("expiresAt", json!({"type": "integer", "minimum": 1})),
        ("scopes", array(string())),
        ("keyId", string()),
        ("principalId", string()),
        ("keyVersion", json!({"type": "integer", "minimum": 1})),
        ("region", reference("Region")),
    ])
}

fn discovered_token() -> Value {
    closed_object([
        ("id", string()),
        ("accessToken", string()),
        ("tokenType", json!({"const": "Bearer"})),
        ("expiresAt", json!({"type": "integer", "minimum": 1})),
        ("scopes", array(string())),
        ("workspaceId", string()),
    ])
}

fn discovered_region_access_token() -> Value {
    closed_object([
        ("id", string()),
        ("accessToken", string()),
        ("tokenType", json!({"const": "Bearer"})),
        ("expiresAt", json!({"type": "integer", "minimum": 1})),
        ("scopes", array(string())),
        ("keyId", string()),
        ("principalId", string()),
        ("keyVersion", json!({"type": "integer", "minimum": 1})),
        ("region", reference("Region")),
        ("workspaceId", string()),
    ])
}

fn discovered_region_token() -> Value {
    closed_object([
        ("id", string()),
        ("accessToken", string()),
        ("tokenType", json!({"const": "Bearer"})),
        ("expiresAt", json!({"type": "integer", "minimum": 1})),
        ("scopes", array(string())),
        ("keyId", string()),
        ("principalId", string()),
        ("keyVersion", json!({"type": "integer", "minimum": 1})),
        ("region", reference("Region")),
        ("enrollmentTicket", string()),
        (
            "enrollmentExpiresAt",
            json!({"type": "integer", "minimum": 1}),
        ),
        ("nonce", string()),
        ("workspaceId", string()),
    ])
}
