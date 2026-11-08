use super::*;

pub(super) fn paths() -> Value {
    json!({
        "/api/v1/workspaces/{workspaceId}/token-issuances": {"post": create_global_token_issuance()},
        "/api/v1/workspaces/{workspaceId}/token-issuances/{issuanceId}": {"get": get_global_token_issuance()},
        "/api/v1/workspaces/{workspaceId}/regions": {"get": list_authorized_regions()},
        "/api/v1/token-issuances": {"post": create_discovered_token_issuance()},
        "/api/v1/workspaces/{workspaceId}/region-route": {"get": get_global_region_route()},
    })
}

fn create_global_token_issuance() -> Value {
    json!({
        "operationId": "createGlobalTokenIssuance",
        "summary": "Create Global Token Issuance",
        "security": [{"workspaceKey": []}],
        "parameters": [workspace_id_parameter()],
        "responses": {
            "201": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {
                    "application/json": {
                        "schema": {"oneOf": [reference("Token"), reference("RegionAccessToken"), reference("RegionToken")]},
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
            "properties": {"audience": string(), "scopes": array(string()), "clientThumbprint": string()},
            "required": ["audience"],
        })),
        "description": "Exchange the Workspace Key at Global only. Region audience requests require matching applied regional policy. Without clientThumbprint the response is a short-lived Region access Token. With an Ed25519 client JWK thumbprint it also includes a client-bound enrollment ticket for direct regional refresh enrollment.",
    })
}

fn get_global_token_issuance() -> Value {
    json!({
        "operationId": "getGlobalTokenIssuance",
        "summary": "Get Global Token Issuance",
        "security": [{"globalAccess": []}],
        "parameters": [
            workspace_id_parameter(),
            {"name": "issuanceId", "in": "path", "required": true, "schema": string()},
        ],
        "responses": {
            "200": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": closed_object([("data", reference("Issuance"))])}},
            },
            "default": {
                "description": "Structured denial or unknown outcome; no credential is echoed.",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
    })
}

fn list_authorized_regions() -> Value {
    json!({
        "operationId": "listAuthorizedRegions",
        "summary": "List Authorized Regions",
        "security": [{"globalAccess": []}],
        "parameters": [workspace_id_parameter()],
        "responses": {
            "200": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {
                    "application/json": {
                        "schema": closed_object([("data", array(reference("Region"))), ("nextCursor", json!({"type": "null"}))]),
                    },
                },
            },
            "default": {
                "description": "Structured denial or unknown outcome; no credential is echoed.",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
        "description": "Requires resources:read on a current Global Token. Only the Key-granted Region is returned. Data requests go directly to Region.",
    })
}

fn create_discovered_token_issuance() -> Value {
    json!({
        "operationId": "createDiscoveredTokenIssuance",
        "summary": "Exchange a Workspace Key without configuring a Workspace or Region",
        "security": [{"workspaceKey": []}],
        "description": "The Key identifies its Workspace. Use audience global or region; region selects the Key-granted Region. Legacy Keys without a Workspace hint continue to use the Workspace-scoped issuance endpoint. Never forward the Workspace Key to a Region.",
        "requestBody": request(json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "audience": {"enum": ["global", "region"]},
                "scopes": array(string()),
                "clientThumbprint": string(),
            },
            "required": ["audience"],
        })),
        "responses": responses(json!({
            "201": {
                "description": "Successful response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {
                    "application/json": {
                        "schema": {
                            "oneOf": [
                                reference("DiscoveredToken"),
                                reference("DiscoveredRegionAccessToken"),
                                reference("DiscoveredRegionToken"),
                            ],
                        },
                    },
                },
            },
        })),
    })
}

fn get_global_region_route() -> Value {
    json!({
        "operationId": "getGlobalRegionRoute",
        "summary": "Discover the Region through a bodyless redirect",
        "security": [{"globalAccess": []}],
        "parameters": [workspace_id_parameter()],
        "description": "Send only a Global access Token. Inspect the redirect without automatic credential forwarding; validate the HTTPS target against authenticated Global discovery before using the Region Token. Do not send SQL or file content to this endpoint.",
        "responses": responses(json!({
            "307": {
                "description": "Region API base URL. No data request has been sent to Global.",
                "headers": {
                    "Location": {"required": true, "schema": {"type": "string", "format": "uri"}},
                    "X-Region-Id": {"required": true, "schema": string()},
                    "Cache-Control": {"schema": {"const": "no-store"}},
                },
            },
        })),
    })
}
