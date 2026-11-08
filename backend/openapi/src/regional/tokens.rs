use super::*;

pub(super) fn paths() -> Value {
    json!({
        "/workspaces/{workspaceId}/refresh-families": {"post": enroll_regional_refresh_family()},
        "/workspaces/{workspaceId}/token-issuances": {"post": issue_regional_token()},
        "/workspaces/{workspaceId}/refresh-families/{familyId}": {"get": get_regional_refresh_family(), "delete": revoke_regional_refresh_family()},
        "/workspaces/{workspaceId}/token-issuances/{issuanceId}": {"get": get_regional_token_issuance()},
        "/workspaces/{workspaceId}/access-tokens/{tokenId}": {"delete": revoke_regional_access_token()},
    })
}

fn enroll_regional_refresh_family() -> Value {
    json!({
        "operationId": "enrollRegionalRefreshFamily",
        "x-authentication-profile": "regional-token",
        "tags": ["Region security"],
        "security": [],
        "parameters": [workspace_id_parameter(), dpop_parameter()],
        "responses": {
            "201": {
                "description": "Successful regional response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("RegionalEnrollment")}},
            },
            "default": {
                "description": "Successful regional response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
        "description": "Available on a Region listener configured with the regional security profile. Direct regional operation; no Global callback. Uncertain credential-producing outcomes are not automatically retried.",
        "requestBody": request(closed_object([("ticket", string())])),
    })
}

fn issue_regional_token() -> Value {
    json!({
        "operationId": "issueRegionalToken",
        "x-authentication-profile": "regional-token",
        "tags": ["Region security"],
        "security": [{"regionalRefresh": []}],
        "parameters": [workspace_id_parameter(), dpop_parameter()],
        "responses": {
            "201": {
                "description": "Successful regional response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("RegionalToken")}},
            },
            "default": {
                "description": "Successful regional response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
        "description": "Available on a Region listener configured with the regional security profile. Direct regional operation; no Global callback. Uncertain credential-producing outcomes are not automatically retried.",
        "requestBody": request(closed_object([("keyId", string())])),
    })
}

fn get_regional_refresh_family() -> Value {
    json!({
        "operationId": "getRegionalRefreshFamily",
        "x-authentication-profile": "regional-token",
        "tags": ["Region security"],
        "security": [{"regionalAccess": []}],
        "parameters": [workspace_id_parameter(), family_id_parameter()],
        "responses": {
            "200": {
                "description": "Successful regional response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": closed_object([("data", reference("RegionalFamily"))])}},
            },
            "default": {
                "description": "Successful regional response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
        "description": "Available on a Region listener configured with the regional security profile. Direct regional operation; no Global callback. Uncertain credential-producing outcomes are not automatically retried.",
    })
}

fn revoke_regional_refresh_family() -> Value {
    json!({
        "operationId": "revokeRegionalRefreshFamily",
        "x-authentication-profile": "regional-token",
        "tags": ["Region security"],
        "security": [{"regionalAccess": []}],
        "parameters": [workspace_id_parameter(), family_id_parameter()],
        "responses": {
            "204": {"description": "Durably denied and local in-flight authorization leases fenced."},
            "default": {
                "description": "Successful regional response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
        "description": "Available on a Region listener configured with the regional security profile. Direct regional operation; no Global callback. Uncertain credential-producing outcomes are not automatically retried.",
    })
}

fn get_regional_token_issuance() -> Value {
    json!({
        "operationId": "getRegionalTokenIssuance",
        "x-authentication-profile": "regional-token",
        "tags": ["Region security"],
        "security": [{"regionalAccess": []}],
        "parameters": [
            workspace_id_parameter(),
            {"name": "issuanceId", "in": "path", "required": true, "schema": string()},
        ],
        "responses": {
            "200": {
                "description": "Successful regional response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": closed_object([("data", reference("RegionalIssuance"))])}},
            },
            "default": {
                "description": "Successful regional response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
        "description": "Available on a Region listener configured with the regional security profile. Direct regional operation; no Global callback. Uncertain credential-producing outcomes are not automatically retried.",
    })
}

fn revoke_regional_access_token() -> Value {
    json!({
        "operationId": "revokeRegionalAccessToken",
        "x-authentication-profile": "regional-token",
        "tags": ["Region security"],
        "security": [{"regionalAccess": []}],
        "parameters": [
            workspace_id_parameter(),
            {"name": "tokenId", "in": "path", "required": true, "schema": string()},
        ],
        "responses": {
            "204": {"description": "Durably denied and local in-flight authorization leases fenced."},
            "default": {
                "description": "Successful regional response",
                "headers": {"Cache-Control": {"schema": {"const": "no-store"}}},
                "content": {"application/json": {"schema": reference("Error")}},
            },
        },
        "description": "Locally deny the authenticated access token itself until its original expiry. An arbitrary ID is not authorization.",
    })
}
