use super::*;

pub(super) fn paths() -> Value {
    json!({
        "/workspaces/{workspaceId}/files/tabular-preview": {"get": tabular_file_preview(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/file-analyses/capabilities": {"get": file_analysis_capabilities(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/file-analyses": {"post": analyze_file(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/files": {"get": list_files(), "put": write_file(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/files/entry": {"delete": delete_file(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/files/content": {"get": download_file(), "put": upload_file(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/file-export-preparations": {"post": create_file_export_preparation(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/file-exports": {"post": export_file_content(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/result-exports": {"post": export_result(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/files/metadata": {"get": get_file_metadata(), "parameters": [workspace_id()]},
        "/workspaces/{workspaceId}/file-export-preparations/{preparationId}": {
            "parameters": [workspace_id(), preparation_id_parameter()],
            "get": get_file_export_preparation(),
            "delete": delete_file_export_preparation(),
        },
    })
}

fn tabular_file_preview() -> Value {
    workspace_operation(
        "tabularFilePreview",
        "Read a fixed bounded CSV/Parquet schema and sample",
        "files:read",
        " Fixed CSV/Parquet schema/sample only: accepts resourceId/path, no custom SQL or engine settings. Requires files:read, not files:analyze. Whole version-verified snapshot up to 16 MiB, 15 seconds and shared two-worker budget; at most 20 rows, 50 columns, 128 KiB. CSV types are inferred and totalRows unknown; Parquet count is metadata. No automatic retry. Download unsupported or over-budget files.",
        json!({
            "parameters": [
                {"name": "resourceId", "in": "query", "required": true, "schema": string()},
                {"name": "path", "in": "query", "required": true, "schema": string()},
            ],
            "responses": responses(json!({
                "200": response("Success", object([
                    ("resourceId", string()),
                    ("path", string()),
                    ("format", json!({"enum": ["csv", "parquet"]})),
                    ("readOnly", json!({"const": true})),
                    ("inputBytes", integer()),
                    ("durationMs", integer()),
                    ("fileVersion", json!({"type": "string", "pattern": "^[a-f0-9]{64}$"})),
                    ("columns", json!({"type": "array", "maxItems": 50, "items": string()})),
                    ("columnTypes", json!({"type": "array", "maxItems": 50, "items": string()})),
                    ("schema", json!({
                        "type": "array",
                        "maxItems": 50,
                        "items": object([("column_name", string()), ("column_type", string())]),
                    })),
                    ("rows", json!({
                        "type": "array",
                        "maxItems": 20,
                        "items": {"type": "object", "additionalProperties": true},
                    })),
                    ("rowCount", json!({"type": "integer", "minimum": 0, "maximum": 20})),
                    ("totalRows", json!({
                        "type": ["string", "null"],
                        "description": "Exact Parquet metadata row count; null for CSV. Not the sample count.",
                    })),
                    ("typesInferred", boolean()),
                    ("truncated", boolean()),
                ])),
            })),
        }),
    )
}

fn file_analysis_capabilities() -> Value {
    workspace_operation(
        "fileAnalysisCapabilities",
        "Discover read-only analysis for a selected file",
        "files:read",
        "",
        json!({
            "parameters": [
                {"name": "resourceId", "in": "query", "required": true, "schema": string()},
                {"name": "path", "in": "query", "required": true, "schema": string()},
            ],
            "responses": responses(json!({
                "200": response("Success", object([
                    ("engine", json!({
                        "type": ["string", "null"],
                        "enum": ["duckdb", "bash", null],
                        "description": "Default engine, retained for compatibility. Select from engines.",
                    })),
                    ("engines", json!({
                        "type": "array",
                        "description": "Supported analysis methods with individual availability. CSV offers both engines; Parquet only DuckDB; recognized text only Bash. Availability checks metadata, not successful parsing or UTF-8 decoding.",
                        "items": {
                            "type": "object",
                            "required": ["engine", "available", "reason"],
                            "properties": {
                                "engine": {"enum": ["duckdb", "bash"]},
                                "available": boolean(),
                                "reason": string(),
                                "input": {
                                    "type": "object",
                                    "required": ["path", "workingDirectory", "aliases"],
                                    "properties": {
                                        "path": string(),
                                        "workingDirectory": {"const": "/workspace"},
                                        "aliases": array(string()),
                                        "fileVariable": {
                                            "const": "FILE",
                                            "description": "When present, Workspace sets FILE to input.path for each fresh Bash run. Use quoted \"$FILE\" or \"${FILE}\"; this is a Workspace convention, not a Bash built-in. Script assignments do not persist.",
                                        },
                                    },
                                    "description": "Bash only: the selected absolute Workspace path in its read-only virtual snapshot, working directory, and compatible aliases. The legacy alias is omitted when it would shadow the selected path or a parent directory. Not a host path or a mount of other files.",
                                },
                            },
                        },
                    })),
                    ("format", json!({"type": ["string", "null"]})),
                    ("available", json!({"type": "boolean", "description": "Availability of the default engine."})),
                    ("reason", json!({"type": "string", "description": "Unavailable reason for the default engine."})),
                    ("size", integer()),
                    ("readOnly", json!({"const": true})),
                    ("limits", object([
                        ("inputBytes", json!({"type": "integer", "const": 16777216})),
                        ("scriptBytes", json!({"type": "integer", "const": 65536})),
                        ("outputBytes", json!({"type": "integer", "const": 1048576})),
                        ("rows", json!({"type": "integer", "const": 1000})),
                        ("timeoutMs", json!({"type": "integer", "const": 15000})),
                        ("concurrency", json!({"type": "integer", "const": 2})),
                        ("workerHeapMiB", json!({"type": "integer", "const": 128})),
                        ("duckdbMemoryMB", json!({"type": "integer", "const": 128})),
                    ])),
                ])),
            })),
        }),
    )
}

fn analyze_file() -> Value {
    workspace_operation(
        "analyzeFile",
        "Run bounded read-only DuckDB SQL or Just Bash on one selected file",
        "files:analyze",
        " Also requires files:read. Discover engines from capabilities: CSV supports DuckDB SQL over table file or Just Bash over its raw UTF-8 text. Bash exposes the selected absolute Workspace path; discover input.path, input.workingDirectory and compatibility aliases on its engine option. Paths refer only to the virtual selected-file snapshot. Parquet supports only DuckDB, and other recognized text only Just Bash. Only the selected snapshot is available; no provider credentials, network, persistent writes or host paths. Limits: 16 MiB input, 64 KiB script, 15 seconds, 1000 rows / 1 MiB output, two active analyses. Large/unsupported files remain downloadable. No implicit retry.",
        json!({
            "requestBody": request(json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["resourceId", "path", "engine"],
                "properties": {
                    "resourceId": string(),
                    "path": string(),
                    "engine": {"enum": ["duckdb", "bash"]},
                    "sql": {"type": "string", "maxLength": 65536},
                    "command": {"type": "string", "maxLength": 65536},
                },
                "oneOf": [
                    {
                        "required": ["sql"],
                        "properties": {"engine": {"const": "duckdb"}},
                        "not": {"required": ["command"]},
                    },
                    {
                        "required": ["command"],
                        "properties": {"engine": {"const": "bash"}},
                        "not": {"required": ["sql"]},
                    },
                ],
            })),
            "responses": responses(json!({
                "200": response("Success", json!({
                    "type": "object",
                    "required": [
                        "engine",
                        "resourceId",
                        "path",
                        "readOnly",
                        "inputBytes",
                        "durationMs",
                        "columns",
                        "schema",
                        "columnTypes",
                        "rows",
                        "rowCount",
                        "stdout",
                        "stderr",
                        "exitCode",
                    ],
                    "properties": {
                        "engine": {"enum": ["duckdb", "bash"]},
                        "resourceId": string(),
                        "path": string(),
                        "readOnly": {"const": true},
                        "inputBytes": integer(),
                        "durationMs": integer(),
                        "columns": array(string()),
                        "schema": array(object([("column_name", string()), ("column_type", string())])),
                        "columnTypes": array(string()),
                        "rows": array(json!({"type": "object", "additionalProperties": true})),
                        "rowCount": integer(),
                        "stdout": string(),
                        "stderr": string(),
                        "exitCode": integer(),
                        "fileVersion": {
                            "type": "string",
                            "pattern": "^[a-f0-9]{64}$",
                            "description": "Saved-byte digest when supported; compare with tabular preview.",
                        },
                    },
                })),
            })),
        }),
    )
}

fn list_files() -> Value {
    workspace_operation(
        "listFiles",
        "List files (Drive9 metadata only; local files include UTF-8 contents)",
        "files:read",
        "",
        json!({
            "parameters": [
                {"name": "resourceId", "in": "query", "required": true, "schema": string()},
                {
                    "name": "path",
                    "in": "query",
                    "schema": string(),
                    "description": "Directory to list; defaults to the root for both providers.",
                },
                {
                    "name": "limit",
                    "in": "query",
                    "schema": {"type": "integer", "minimum": 1, "maximum": 32, "default": 32},
                    "description": "Local File System page size; Drive9 listing is provider-defined.",
                },
                {
                    "name": "cursor",
                    "in": "query",
                    "schema": {"type": "string", "maxLength": 64},
                    "description": "Continuation cursor from the previous local directory page.",
                },
            ],
            "responses": responses(json!({
                "200": response("Success", object([("data", array(reference("File"))), ("nextCursor", json!({"type": ["string", "null"]}))])),
            })),
        }),
    )
}

fn write_file() -> Value {
    workspace_operation(
        "writeFile",
        "Create or replace a UTF-8 file or directory",
        "files:write",
        "",
        json!({
            "requestBody": request(json!({
                "type": "object",
                "required": ["resourceId", "path", "type"],
                "properties": {
                    "resourceId": string(),
                    "path": {
                        "type": "string",
                        "description": "Absolute virtual path. Parent directory must exist; traversal is rejected.",
                    },
                    "type": {"enum": ["file", "directory"]},
                    "content": {
                        "type": "string",
                        "description": "Required for files; maximum 256 KiB of UTF-8 text and subject to the provider upload limit.",
                    },
                    "purpose": {
                        "enum": ["report"],
                        "description": "Explicit report-save intent. Requires a nonblank file and If-None-Match: *. Generic writes do not claim a saved report. Success proves persistence, not report quality or authorship.",
                    },
                },
                "allOf": [
                    {
                        "if": {"properties": {"purpose": {"const": "report"}}, "required": ["purpose"]},
                        "then": {
                            "required": ["content"],
                            "properties": {"type": {"const": "file"}, "content": {"type": "string", "minLength": 1, "pattern": "\\S"}},
                        },
                    },
                ],
            })),
            "responses": responses(json!({
                "200": response("Success", json!({"type": "object", "properties": {"data": reference("File")}})),
            })),
            "parameters": [if_match_parameter(), if_none_match_parameter()],
        }),
    )
}

fn delete_file() -> Value {
    workspace_operation(
        "deleteFile",
        "Delete a file or empty directory identified by its URI",
        "files:write",
        "",
        json!({
            "parameters": [
                {"name": "resourceId", "in": "query", "required": true, "schema": string()},
                {"name": "path", "in": "query", "required": true, "schema": string()},
            ],
            "responses": responses(json!({"200": response("Success", object([("deleted", boolean())]))})),
        }),
    )
}

fn download_file() -> Value {
    workspace_operation(
        "downloadFile",
        "Download original bytes or request a bounded file preview (Drive9)",
        "files:read",
        "",
        json!({
            "parameters": [
                {"name": "resourceId", "in": "query", "required": true, "schema": string()},
                {"name": "path", "in": "query", "required": true, "schema": string()},
                {
                    "name": "preview",
                    "in": "query",
                    "schema": {"enum": ["1"]},
                    "description": "Returns text content, a base64 image, or an unavailableReason. Images include a fallback reason for older clients; prefer image when present. Text is limited to 128 KiB and PNG, JPEG, GIF, and WebP to 1 MiB.",
                },
            ],
            "responses": {
                "200": {
                    "description": "Attachment download, or JSON when preview=1. Local resources use /files instead.",
                    "content": {
                        "application/octet-stream": {"schema": {"type": "string", "format": "binary"}},
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["size"],
                                "properties": {
                                    "content": string(),
                                    "size": integer(),
                                    "unavailableReason": string(),
                                    "image": object([
                                        ("mimeType", json!({"enum": ["image/png", "image/jpeg", "image/gif", "image/webp"]})),
                                        ("base64", string()),
                                    ]),
                                },
                            },
                        },
                    },
                },
                "400": response("Request failed", reference("Error")),
                "401": response("Request failed", reference("Error")),
                "403": response("Request failed", reference("Error")),
                "404": response("Request failed", reference("Error")),
                "502": response("Request failed", reference("Error")),
                "503": response("Request failed", reference("Error")),
            },
        }),
    )
}

fn upload_file() -> Value {
    workspace_operation(
        "uploadFile",
        "Upload original bytes to Drive9 (gateway maximum 1 MiB)",
        "files:write",
        "",
        json!({
            "parameters": [
                {"name": "resourceId", "in": "query", "required": true, "schema": string()},
                {"name": "path", "in": "query", "required": true, "schema": string()},
                if_match_parameter(),
                if_none_match_parameter(),
            ],
            "responses": responses(json!({
                "200": response("Success", object([("saved", boolean()), ("size", integer())])),
            })),
            "requestBody": {
                "required": true,
                "content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}},
            },
        }),
    )
}

fn create_file_export_preparation() -> Value {
    workspace_operation(
        "createFileExportPreparation",
        "Parse an original file or Bash stream for explicit schema review",
        "files:analyze",
        " Also requires files:read and the source File System grant. Fixed CSV/Parquet/text-line parsing, no scripts. Up to 16 MiB original or 1 MiB output text, 1000 rows/100 columns/1 MiB parsed data and 15 seconds, shared worker admission. Returns 20 sample rows and suggested field types with an actor-bound five-minute preparation. Parsing writes nothing. CSV keeps leading zeros and distinguishes quoted empty strings from NULL. Text lines are explicit one-column records.",
        json!({
            "requestBody": request(reference("FileExportPreparationInput")),
            "responses": responses(json!({
                "201": {
                    "description": "Success",
                    "content": {"application/json": {"schema": reference("Preparation")}},
                    "headers": {
                        "Location": {"schema": string(), "description": "Address of the created actor-bound review resource."},
                    },
                },
            })),
        }),
    )
}

fn export_file_content() -> Value {
    workspace_operation(
        "exportFileContent",
        "Copy original bytes, export Bash text or commit a confirmed database import",
        "files:read",
        " Original copies require read access; Bash output requires read plus analyze. File targets require files:write and a target grant. Database commits require the exact actor preparation, confirmed=true, reviewed fields, source read/analyze and target queries:execute/grant. Original versions must match; single-use writes, no append/overwrite/retry. Output text is client-supplied authorization context, not attested command lineage. Only file-exports and file-export-preparations permit an 8 MiB JSON envelope for at most 1 MiB output text. Original downloads retain /files/content (local files use /files).",
        json!({
            "requestBody": request(reference("FileExportInput")),
            "responses": responses(json!({"200": response("Success", reference("FileExportOutput"))})),
        }),
    )
}

fn export_result() -> Value {
    workspace_operation(
        "exportResult",
        "Export a supplied result snapshot without rerunning its source query",
        "Source database: queries:read (also implied by queries:execute); source File System: files:read and files:analyze. Destination additionally requires files:write or queries:execute and its resource grant",
        " Client-supplied snapshot, not attested provenance. Up to 100 columns, 1000 rows, 16 nesting levels and 1 MiB request. Downloads: CSV/JSON/JSON Lines, up to 4 MiB encoded output. Files: conditional create, 256 KiB local / 1 MiB live plus provider limits. Database targets: active live resources, CREATE then one INSERT, each up to 64 KiB and 15 seconds; no transaction across both statements. Name collisions never append/replace. EXPORT_INCOMPLETE or a timeout may leave a new table; inspect before retrying. No automatic retry. Precision strings remain text; CSV renders null as empty and prefixes spreadsheet-formula strings. No result values are audited.",
        json!({
            "requestBody": request(reference("ResultExportInput")),
            "responses": responses(json!({
                "200": response("Success", reference("ResultExportOutput")),
                "500": response("Export may have completed but its activity record could not be saved", reference("Error")),
            })),
        }),
    )
}

fn get_file_metadata() -> Value {
    workspace_operation(
        "getFileMetadata",
        "Read file identity and an opaque conditional-write version",
        "files:read",
        "",
        json!({
            "parameters": [
                {"name": "resourceId", "in": "query", "required": true, "schema": string()},
                {"name": "path", "in": "query", "required": true, "schema": string()},
            ],
            "responses": responses(json!({
                "200": {
                    "description": "Success",
                    "content": {
                        "application/json": {
                            "schema": object([
                                ("data", object([
                                    ("resourceId", string()),
                                    ("path", string()),
                                    ("type", json!({"enum": ["file", "directory"]})),
                                    ("size", integer()),
                                    ("version", json!({"type": ["string", "null"]})),
                                    ("conditionalWrites", boolean()),
                                ])),
                            ]),
                        },
                    },
                    "headers": {
                        "ETag": {
                            "schema": string(),
                            "description": "Strong version validator when available. Never cache authenticated metadata.",
                        },
                    },
                },
            })),
        }),
    )
}

fn get_file_export_preparation() -> Value {
    workspace_operation(
        "getFileExportPreparation",
        "Read the current actor review without parsing or provider I/O",
        "files:read and files:analyze",
        "",
        json!({
            "responses": responses(json!({"200": response("Success", reference("Preparation"))})),
        }),
    )
}

fn delete_file_export_preparation() -> Value {
    workspace_operation(
        "deleteFileExportPreparation",
        "Cancel an unconsumed review",
        "files:read and files:analyze",
        "",
        json!({
            "responses": responses(json!({
                "204": {"description": "Review cancelled; no response body. Already consumed reviews return 409."},
            })),
        }),
    )
}
