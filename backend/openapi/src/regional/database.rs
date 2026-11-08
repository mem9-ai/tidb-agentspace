use super::*;

pub(super) fn paths() -> Value {
    json!({
        "/workspaces/{workspaceId}/resources/{resourceId}/tables": {"parameters": [workspace_id(), resource_id_parameter()], "get": list_database_tables()},
        "/workspaces/{workspaceId}/resources/{resourceId}/tables/{tableName}": {"parameters": [workspace_id(), resource_id_parameter()], "get": get_database_table()},
        "/workspaces/{workspaceId}/resources/{resourceId}/tables/{tableName}/rows": {"parameters": [workspace_id(), resource_id_parameter()], "get": get_database_table_rows()},
        "/workspaces/{workspaceId}/database-import-preparations": {"post": create_database_import_preparation(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/database-imports": {"post": create_database_import(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/queries": {"post": execute_query(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/database-import-preparations/{preparationId}": {
            "parameters": [workspace_id(), preparation_id_parameter()],
            "get": get_database_import_preparation(),
            "delete": delete_database_import_preparation(),
        },
    })
}

fn list_database_tables() -> Value {
    workspace_operation(
        "listDatabaseTables",
        "List up to 500 tables and views in the selected database, ordered by name; truncated means more exist",
        "queries:read",
        "",
        json!({
            "responses": responses(json!({"200": response("Success", reference("TableList"))})),
        }),
    )
}

fn get_database_table() -> Value {
    workspace_operation(
        "getDatabaseTable",
        "Read columns and ordered index parts for an exact table name; includes a SELECT for the editor",
        "queries:read",
        "",
        json!({
            "parameters": [
                {
                    "name": "tableName",
                    "in": "path",
                    "required": true,
                    "schema": {"type": "string", "minLength": 1, "maxLength": 64},
                    "description": "Exact table name in the current database; not a schema-qualified SQL expression.",
                },
            ],
            "responses": responses(json!({"200": response("Success", reference("TableDetail"))})),
        }),
    )
}

fn get_database_table_rows() -> Value {
    workspace_operation(
        "getDatabaseTableRows",
        "Read up to 100 unordered rows, bounded by 1 MiB and 15 seconds per statement; not pagination or a full export",
        "queries:read",
        "",
        json!({
            "parameters": [
                {
                    "name": "tableName",
                    "in": "path",
                    "required": true,
                    "schema": {"type": "string", "minLength": 1, "maxLength": 64},
                },
            ],
            "responses": responses(json!({"200": response("Success", reference("QueryResult"))})),
        }),
    )
}

fn create_database_import_preparation() -> Value {
    workspace_operation(
        "createDatabaseImportPreparation",
        "Create a private destination-bound import review",
        "queries:execute on destination; Workspace inputs also require source files:read/analyze",
        " CSV/Parquet only. Preparations are principal- and destination-bound, expire after five minutes, and retain at most 1,000 rows/100 columns/1 MiB parsed data. Preview returns at most 20 rows; commit uses all retained rows. Local uploads are ephemeral and never create a File System resource. Workspace inputs retain a 16 MiB snapshot budget. Parsing has a 15-second deadline and two slots. Existing 64 KiB SQL-statement budgets apply. New tables only; no append, overwrite, DROP or automatic write retry. Inspect the destination after an incomplete or uncertain outcome. Changing the target requires a new preparation. API restart invalidates preparations.",
        json!({
            "parameters": [
                {
                    "name": "resourceId",
                    "in": "query",
                    "schema": string(),
                    "description": "Required only for octet-stream uploads. Forbidden on JSON requests.",
                },
                {
                    "name": "filename",
                    "in": "query",
                    "schema": {"type": "string", "minLength": 1, "maxLength": 255},
                    "description": "Upload basename, required for octet-stream.",
                },
                {
                    "name": "format",
                    "in": "query",
                    "schema": {"enum": ["csv", "parquet"]},
                    "description": "Required for octet-stream.",
                },
                {
                    "name": "header",
                    "in": "query",
                    "schema": {"enum": ["true", "false"]},
                    "description": "Required for CSV uploads, forbidden for Parquet.",
                },
                {
                    "name": "delimiter",
                    "in": "query",
                    "schema": {"enum": [",", "\t", ";", "|"]},
                    "description": "Required for CSV uploads, forbidden for Parquet.",
                },
            ],
            "responses": responses(json!({
                "201": {
                    "description": "Success",
                    "content": {"application/json": {"schema": reference("Preparation")}},
                    "headers": {
                        "Location": {"schema": string(), "description": "Address of the created actor-bound review resource."},
                    },
                },
            })),
            "requestBody": {
                "required": true,
                "content": {
                    "application/json": {"schema": reference("DatabaseImportPreparationInput")},
                    "application/octet-stream": {"schema": {"type": "string", "format": "binary"}},
                },
            },
        }),
    )
}

fn create_database_import() -> Value {
    workspace_operation(
        "createDatabaseImport",
        "Confirm reviewed server rows and create a new database table",
        "queries:execute on destination; Workspace files additionally require source files:read and files:analyze",
        " CSV/Parquet only. Preparations are principal- and destination-bound, expire after five minutes, and retain at most 1,000 rows/100 columns/1 MiB parsed data. Preview returns at most 20 rows; commit uses all retained rows. Local uploads are ephemeral and never create a File System resource. Workspace inputs retain a 16 MiB snapshot budget. Parsing has a 15-second deadline and two slots. Existing 64 KiB SQL-statement budgets apply. New tables only; no append, overwrite, DROP or automatic write retry. Inspect the destination after an incomplete or uncertain outcome. Changing the target requires a new preparation. API restart invalidates preparations.",
        json!({
            "requestBody": request(reference("DatabaseImportInput")),
            "responses": responses(json!({"200": response("Success", reference("DatabaseImportResult"))})),
        }),
    )
}

fn execute_query() -> Value {
    json!({
        "operationId": "executeQuery",
        "summary": "Execute one statement on a selected database; live SQL can read and write",
        "tags": ["Workspace"],
        "description": "Requires queries:read (implied by queries:execute) and the database grant. Writes additionally require queries:execute. Read-only mode is enforced for read-only Keys even when readOnly=false. The constrained read-only subset permits at most 1024 lexer tokens and 32 nested delimiters; unsupported syntax/functions fail closed.",
        "x-required-scope": "queries:read",
        "security": workspace_security(),
        "requestBody": request(json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["resourceId", "sql"],
            "properties": {
                "resourceId": string(),
                "readOnly": {
                    "type": "boolean",
                    "default": false,
                    "description": "Enforced read-only mode. Automatically enabled for queries:read-only Keys.",
                },
                "sql": {
                    "type": "string",
                    "description": "queries:read grants a constrained parsed read-only SELECT/CTE/VALUES subset; unknown functions, locks, writes and multiple statements are rejected before provider I/O. queries:execute also permits reads and writes. readOnly:true constrains a full-access caller. One statement up to 64 KiB, a 15-second deadline, at most 1000 result rows / 1 MiB. No persistent session or automatic retry. A timeout or result limit can leave writes committed; check before retrying.",
                },
            },
        })),
        "responses": responses(json!({"200": response("Success", reference("QueryResult"))})),
        "x-write-scope": "queries:execute",
    })
}

fn get_database_import_preparation() -> Value {
    workspace_operation(
        "getDatabaseImportPreparation",
        "Read the current actor review without parsing or provider I/O",
        "queries:execute on destination; source files:read/analyze when present",
        "",
        json!({
            "responses": responses(json!({"200": response("Success", reference("Preparation"))})),
        }),
    )
}

fn delete_database_import_preparation() -> Value {
    workspace_operation(
        "deleteDatabaseImportPreparation",
        "Cancel an unconsumed review",
        "queries:execute on destination; source files:read/analyze when present",
        "",
        json!({
            "responses": responses(json!({
                "204": {"description": "Review cancelled; no response body. Already consumed reviews return 409."},
            })),
        }),
    )
}
