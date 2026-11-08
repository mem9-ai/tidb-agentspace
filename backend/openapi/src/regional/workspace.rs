use super::*;

pub(super) fn paths() -> Value {
    json!({
        "/workspaces": {"get": list_workspaces()},
        "/workspaces/{workspaceId}": {"get": get_workspace(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/bootstrap": {"get": get_bootstrap(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/sales-sample-attempts": {
            "post": start_sales_sample(),
            "get": list_sales_sample_attempts(),
            "parameters": [workspace_id()],
        },
        "/workspaces/{workspaceId}/sales-sample-attempts/{attemptId}": {
            "parameters": [
                workspace_id(),
                {
                    "name": "attemptId",
                    "in": "path",
                    "required": true,
                    "schema": {"type": "string", "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},
                },
            ],
            "get": get_sales_sample_attempt(),
        },
        "/workspaces/{workspaceId}/tutorials": {"get": list_tutorials(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/tutorials/{resourceId}": {
            "parameters": [workspace_id(), resource_id_parameter()],
            "get": get_tutorial(),
            "put": replace_tutorial(),
        },
        "/workspaces/{workspaceId}/resources": {"get": list_resources(), "post": create_resource(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/resources/{resourceId}/setup-attempts": {
            "parameters": [workspace_id(), resource_id_parameter()],
            "post": create_resource_setup_attempt(),
            "get": list_resource_setup_attempts(),
        },
        "/workspaces/{workspaceId}/resources/{resourceId}/setup-attempts/{attemptId}": {
            "parameters": [
                workspace_id(),
                resource_id_parameter(),
                {
                    "name": "attemptId",
                    "in": "path",
                    "required": true,
                    "schema": {"type": "string", "format": "uuid"},
                },
            ],
            "get": get_resource_setup_attempt(),
        },
        "/workspaces/{workspaceId}/settings": {"patch": update_settings(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/context": {"get": get_agent_context(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/resources/{resourceId}": {
            "parameters": [workspace_id(), resource_id_parameter()],
            "get": get_resource(),
            "delete": delete_resource(),
        },
    })
}

fn list_workspaces() -> Value {
    workspace_operation(
        "listWorkspaces",
        "List available workspaces",
        "resources:read",
        "",
        json!({
            "responses": responses(json!({"200": response("Success", object([("data", array(reference("Workspace")))]))})),
        }),
    )
}

fn get_workspace() -> Value {
    workspace_operation(
        "getWorkspace",
        "Describe a workspace",
        "resources:read",
        "",
        json!({
            "responses": responses(json!({"200": response("Success", object([("data", reference("Workspace"))]))})),
        }),
    )
}

fn get_bootstrap() -> Value {
    owner_operation(
        "getBootstrap",
        "Load the local owner Console state",
        json!({
            "responses": responses(json!({"200": response("Success", reference("Bootstrap"))})),
        }),
    )
}

fn start_sales_sample() -> Value {
    workspace_operation(
        "startSalesSample",
        "Explicitly prepare the US sales sample",
        "files:read and files:write on the selected File System; without resourceId, resources:write and wildcard resource grant",
        "",
        json!({
            "parameters": [
                {
                    "name": "Idempotency-Key",
                    "in": "header",
                    "required": true,
                    "schema": {"type": "string", "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},
                },
            ],
            "requestBody": request(json!({
                "type": "object",
                "required": ["fixture"],
                "properties": {"fixture": {"const": "us-sales-v1"}, "resourceId": {"type": "string", "minLength": 1}},
                "additionalProperties": false,
            })),
            "responses": responses(json!({
                "200": {
                    "description": "Existing attempt; no provider effects are restarted",
                    "content": {"application/json": {"schema": object([("data", reference("SalesSampleAttempt"))])}},
                    "headers": {
                        "Location": {
                            "required": true,
                            "schema": string(),
                            "description": "Relative URI of the observed sample attempt.",
                        },
                    },
                },
                "201": {
                    "description": "Success",
                    "content": {"application/json": {"schema": object([("data", reference("SalesSampleAttempt"))])}},
                    "headers": {
                        "Location": {
                            "required": true,
                            "schema": string(),
                            "description": "Relative URI of the observed sample attempt.",
                        },
                    },
                },
            })),
        }),
    )
}

fn list_sales_sample_attempts() -> Value {
    workspace_operation(
        "listSalesSampleAttempts",
        "Observe the current US sales sample without creating one",
        "files:read on the selected File System",
        "",
        json!({
            "parameters": [{"name": "fixture", "in": "query", "required": true, "schema": {"const": "us-sales-v1"}}],
            "responses": responses(json!({
                "200": response("Success", object([
                    ("data", json!({"type": "array", "maxItems": 1, "items": reference("SalesSampleAttempt")})),
                ])),
            })),
        }),
    )
}

fn get_sales_sample_attempt() -> Value {
    workspace_operation(
        "getSalesSampleAttempt",
        "Observe one US sales sample attempt",
        "files:read on the selected File System",
        "",
        json!({
            "responses": responses(json!({"200": response("Success", object([("data", reference("SalesSampleAttempt"))]))})),
        }),
    )
}

fn list_tutorials() -> Value {
    json!({
        "operationId": "listTutorials",
        "summary": "List durable Workspace tutorial progress in resource-ID order",
        "tags": ["Owner"],
        "description": "Requires an authenticated Workspace Owner session under the enabled account, Guest, or local/legacy profile. Region access Tokens cannot perform this Owner operation. Each resource has one current bookmark, retained across sessions and API restarts in encrypted Workspace metadata. This owner-reported progress is a navigation hint, not saved results or proof of data availability. No provider or sample-data I/O occurs.",
        "x-required-scope": null,
        "security": owner_security(),
        "parameters": [
            {
                "name": "cursor",
                "in": "query",
                "schema": {"type": "string", "minLength": 1, "maxLength": 128, "pattern": "^[A-Za-z0-9_-]+$"},
            },
            {
                "name": "limit",
                "in": "query",
                "schema": {"type": "integer", "minimum": 1, "maximum": 100, "default": 100},
            },
        ],
        "responses": responses(json!({
            "200": response("Success", object([
                ("data", json!({"type": "array", "maxItems": 100, "items": reference("Tutorial")})),
                ("nextCursor", json!({"type": ["string", "null"]})),
            ])),
        })),
    })
}

fn get_tutorial() -> Value {
    owner_operation(
        "getTutorial",
        "Read a tutorial bookmark without querying or writing sample data",
        json!({
            "responses": responses(json!({
                "200": {
                    "description": "Success",
                    "content": {"application/json": {"schema": object([("data", reference("Tutorial"))])}},
                    "headers": {
                        "ETag": {"schema": string(), "description": "Strong opaque tutorial version; equals data.version."},
                    },
                },
            })),
        }),
    )
}

fn replace_tutorial() -> Value {
    json!({
        "operationId": "replaceTutorial",
        "summary": "Create or conditionally replace Workspace tutorial progress",
        "tags": ["Owner"],
        "description": "Requires an authenticated Workspace Owner session under the enabled account, Guest, or local/legacy profile. Region access Tokens cannot perform this Owner operation. One version precondition is mandatory (428 when absent). Creates return 201; replacements return 200. Failed or unknown acknowledgements must be inspected before proceeding. Save attempted before sample writes; saving progress never creates or executes sample data. A new sampleId explicitly replaces the bookmark while keeping previous data intact.",
        "x-required-scope": null,
        "security": owner_security(),
        "parameters": [
            {
                "name": "If-Match",
                "in": "header",
                "schema": string(),
                "description": "Existing tutorial version, including quotes. Required for replacement; stale/missing records return 412 without changes. Mutually exclusive with If-None-Match.",
            },
            {
                "name": "If-None-Match",
                "in": "header",
                "schema": {"const": "*"},
                "description": "Required for create-only progress migration/creation. An existing record returns 412 without changes. Mutually exclusive with If-Match.",
            },
        ],
        "requestBody": request(reference("TutorialInput")),
        "responses": responses(json!({
            "200": {
                "description": "Success",
                "content": {"application/json": {"schema": object([("data", reference("Tutorial"))])}},
                "headers": {
                    "ETag": {"schema": string(), "description": "Strong opaque tutorial version; equals data.version."},
                },
            },
            "201": {
                "description": "Tutorial created",
                "content": {"application/json": {"schema": object([("data", reference("Tutorial"))])}},
                "headers": {
                    "Location": {"schema": string(), "description": "URI of this tutorial bookmark."},
                    "ETag": {"schema": string(), "description": "Strong opaque tutorial version; equals data.version."},
                },
            },
            "428": response("A version precondition is required", reference("Error")),
        })),
    })
}

fn list_resources() -> Value {
    workspace_operation(
        "listResources",
        "Discover databases and file systems",
        "resources:read",
        "",
        json!({
            "parameters": [
                {
                    "name": "limit",
                    "in": "query",
                    "schema": {"type": "integer", "minimum": 1, "maximum": 512, "default": 100},
                    "description": "Page size, default 100; evaluated before authorization and visibility filtering, so a page may be empty.",
                },
                {
                    "name": "cursor",
                    "in": "query",
                    "schema": {"type": "string", "maxLength": 1024},
                    "description": "Opaque cursor from the previous page. Each page is independently authorized; concurrent changes can affect results. Pages contain stored state without refreshing providers.",
                },
            ],
            "responses": responses(json!({
                "200": response("Success", object([
                    ("data", array(reference("Resource"))),
                    ("capabilities", reference("Capabilities")),
                    ("nextCursor", json!({"type": ["string", "null"]})),
                ])),
            })),
        }),
    )
}

fn create_resource() -> Value {
    workspace_operation(
        "createResource",
        "Create a resource using the configured provider",
        "resources:write",
        "",
        json!({
            "parameters": [
                {
                    "name": "Idempotency-Key",
                    "in": "header",
                    "schema": {"type": "string", "maxLength": 128},
                    "description": "Optional key for retry-safe creation. Reusing it with a different body returns 409.",
                },
            ],
            "requestBody": request(json!({
                "type": "object",
                "required": ["name", "kind", "region"],
                "properties": {
                    "name": {
                        "type": "string",
                        "pattern": "^[a-z][a-z0-9_-]{2,39}$",
                        "description": "Underscores are permitted for PostgreSQL resources only.",
                    },
                    "kind": {"enum": ["postgresql", "filesystem"]},
                    "onlyIfNew": {
                        "type": "boolean",
                        "description": "Owner-only File System creation if the Workspace has no resource history; requires an Idempotency-Key. A replay observes the original resource.",
                    },
                    "regionId": {
                        "type": "string",
                        "description": "Optional Workspace Region; must match the current Region. Omit to use the default.",
                    },
                    "region": {
                        "type": "string",
                        "enum": ["aws-us-east-1", "aws-us-west-2", "automatic", "aws-ap-southeast-1"],
                        "description": "Provider data location supported by the resource kind. This is separate from regionId.",
                    },
                },
                "allOf": [
                    {
                        "if": {"properties": {"kind": {"const": "postgresql"}}, "required": ["kind"]},
                        "else": {"properties": {"name": {"pattern": "^[a-z][a-z0-9-]{2,39}$"}}},
                    },
                ],
            })),
            "responses": {
                "201": {
                    "description": "Success",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {"data": reference("Resource"), "mode": {"enum": ["demo", "live"]}},
                            },
                        },
                    },
                    "headers": {"Location": {"schema": string(), "description": "URI of the created resource."}},
                },
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
                "503": response("A provider needs recovery, or RESOURCE_INDEX_MIGRATING means existing Workspace resources are being indexed in the background. That response creates no resource; retry the same request later.", reference("Error")),
                "504": response("SQL timeout; a write outcome may be unknown", reference("Error")),
            },
        }),
    )
}

fn create_resource_setup_attempt() -> Value {
    workspace_operation(
        "createResourceSetupAttempt",
        "Create a durable setup attempt on the saved target",
        "resources:write",
        " Journaled before I/O; executes inline without a queue. Same caller/resource/idempotency key replays without effects. A different key explicitly requests a new attempt using saved bindings and supported reconciliation/idempotent setup only. Missing bindings cannot provision a replacement. succeeded/failed/outcome-unknown describe the attempt, not HTTP resource creation. GET never executes setup; existing credentials are retained.",
        json!({
            "parameters": [
                {
                    "name": "Idempotency-Key",
                    "in": "header",
                    "required": true,
                    "schema": {"type": "string", "minLength": 1, "maxLength": 128},
                    "description": "Caller/resource-scoped key. Replays return the original attempt without executing setup. No body.",
                },
            ],
            "responses": responses(json!({
                "201": {
                    "description": "Success",
                    "content": {"application/json": {"schema": object([("data", reference("ResourceSetupAttempt"))])}},
                    "headers": {"Location": {"schema": string(), "description": "Address of the durable setup attempt."}},
                },
            })),
        }),
    )
}

fn list_resource_setup_attempts() -> Value {
    workspace_operation(
        "listResourceSetupAttempts",
        "List retained setup attempts by opaque ID",
        "resources:read or resources:write",
        "",
        json!({
            "parameters": [
                {"name": "cursor", "in": "query", "schema": {"type": "string", "format": "uuid"}},
                {
                    "name": "limit",
                    "in": "query",
                    "schema": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
                },
            ],
            "responses": responses(json!({
                "200": response("Success", object([
                    ("data", json!({"type": "array", "maxItems": 100, "items": reference("ResourceSetupAttempt")})),
                    ("nextCursor", json!({"type": ["string", "null"]})),
                ])),
            })),
        }),
    )
}

fn get_resource_setup_attempt() -> Value {
    workspace_operation(
        "getResourceSetupAttempt",
        "Observe a setup attempt without provider calls or retry",
        "resources:read or resources:write",
        "",
        json!({
            "responses": responses(json!({"200": response("Success", object([("data", reference("ResourceSetupAttempt"))]))})),
        }),
    )
}

fn update_settings() -> Value {
    owner_operation(
        "updateSettings",
        "Update local workspace and profile",
        json!({
            "requestBody": request(json!({
                "type": "object",
                "required": ["workspaceName", "name"],
                "properties": {
                    "workspaceName": {"type": "string", "minLength": 2, "maxLength": 50},
                    "name": {"type": "string", "minLength": 1, "maxLength": 50},
                    "description": {"type": "string", "maxLength": 200},
                },
            })),
            "responses": responses(json!({"200": response("Success", json!({"type": "object", "properties": {"saved": boolean()}}))})),
        }),
    )
}

fn get_agent_context() -> Value {
    json!({
        "operationId": "getAgentContext",
        "summary": "Discover the current caller and effective Workspace permissions",
        "tags": ["Workspace"],
        "description": scope_description("authenticated caller; no additional action scope", " Bootstrap with the regional Workspace API URL (including workspaceId) and one Key. No Global lookup or bearer-only scan across Workspaces. No other Key or upstream credentials are returned; effective grants do not override resource/provider availability. queries:execute implies queries:read. Owner session expiry remains governed by its authentication profile."),
        "x-required-scope": null,
        "security": workspace_security(),
        "responses": responses(json!({
            "200": response("Success", object([
                ("workspaceId", string()),
                ("principal", object([
                    ("id", string()),
                    ("kind", json!({"enum": ["owner", "workspaceKey"]})),
                    ("scopes", array(string())),
                    ("resourceIds", array(string())),
                    ("expiresAt", json!({"type": ["string", "null"], "format": "date-time"})),
                ])),
                ("links", object([("self", string()), ("resources", string()), ("queries", string()), ("files", string())])),
                ("capabilities", reference("Capabilities")),
                ("limits", object([
                    ("sqlBytes", json!({"const": 65536})),
                    ("queryRows", json!({"const": 1000})),
                    ("queryResultBytes", json!({"const": 1048576})),
                    ("fileUploadBytes", json!({"const": 1048576})),
                    ("sqlTimeoutSeconds", json!({"const": 15})),
                    ("readOnlySqlTokens", json!({"const": 1024})),
                    ("readOnlySqlNesting", json!({"const": 32})),
                ])),
                ("permissions", object([("manageKeys", boolean()), ("createResources", boolean())])),
            ])),
        })),
    })
}

fn get_resource() -> Value {
    workspace_operation(
        "getResource",
        "Read one resource, its permitted actions and lifecycle status",
        "resources:read",
        "",
        json!({
            "responses": responses(json!({"200": response("Success", object([("data", reference("Resource"))]))})),
        }),
    )
}

fn delete_resource() -> Value {
    workspace_operation(
        "deleteResource",
        "Request removal and retain an observable deletion tombstone",
        "resources:write",
        " Local removal completes synchronously (200). Drive9 and PostgreSQL may return 202 with deletion.phase=provider-accepted or outcome-unknown. This is not proof of physical erasure. Drive9 completion is observed from provider status; PostgreSQL requires operator reconciliation. No automatic retry or re-provisioning, including after restart. Deleting/deleted resources deny new data operations; admitted bounded downloads may finish.",
        json!({
            "responses": responses(json!({
                "200": response("Success", object([("data", reference("Resource"))])),
                "202": {
                    "description": "Deletion accepted or outcome unknown. Inspect GET at Location; repeated DELETE never retries the upstream effect. Credentials remain private and retained.",
                    "content": {"application/json": {"schema": object([("data", reference("Resource"))])}},
                    "headers": {
                        "Location": {"schema": string(), "description": "URI of the retained resource and deletion status."},
                    },
                },
            })),
        }),
    )
}
