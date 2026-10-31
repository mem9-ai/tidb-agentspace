export function agentInstructions(workspaceId: string, apiBaseUrl: string): string {
  const workspace = `/workspaces/${workspaceId}`;
  return `# TiDB Agent Workspace

Workspace API: ${apiBaseUrl}/api/v1${workspace}
OpenAPI: ${apiBaseUrl}/openapi.json
Read WORKSPACE_API_KEY from the environment and use Authorization: Bearer. Configure both this Workspace API URL and the Key. Never request native/provider credentials.

GET /context discovers your current scopes, resource grants, expiry, limits and links. GET /resources lists granted resources; GET /resources/{resourceId} returns detail/capabilities. DELETE /resources/{resourceId} requests removal: inspect Location and deletion.phase for 202 responses; acceptance is not verified physical erasure. Zero deletion is unsupported. Owner-only Key management does not become available to ordinary Keys.

GET /resources/{resourceId}/tables lists tables. GET /resources/{resourceId}/tables/{tableName} returns columns/indexes; append /rows for a bounded preview. Encode the exact table name as one URI segment, including literal slashes, using encodeURIComponent. Catalog reads require queries:read (implied by queries:execute) and the database grant.
POST /queries accepts resourceId and sql. queries:read enforces a constrained SELECT/CTE/VALUES subset (1024 lexer tokens, 32 nesting levels); writes require queries:execute. readOnly:true also constrains a full-access caller. One statement, 64 KiB SQL, 15 seconds, 1000 result rows/1 MiB. Never blindly retry a timed-out write.
DuckDB sources may select up to four CSV/JSON/NDJSON/Parquet Workspace files with {name, resourceId, path}; query files.NAME. Independently require source files:read/analyze and grants, with a 16 MiB combined snapshot budget. No external URLs, credentials or host paths.

GET /files?resourceId=ID&path=/ lists files. PUT /files writes UTF-8 files/directories. GET/PUT /files/content?resourceId=ID&path=PATH transfers Drive9 bytes; preview=1 requests bounded text. DELETE /files/entry?resourceId=ID&path=PATH has no body and deletes only a file or empty directory. Read GET /files/metadata before reading content, then send its strong version unchanged in If-Match to update safely; use If-None-Match: * for create-only. A stale version returns 412 without a write. Never silently fall back to an unconditional overwrite.
GET /files/tabular-preview requires files:read for fixed CSV/Parquet samples. GET /file-analyses/capabilities discovers engines; POST /file-analyses requires read/analyze and the source grant. DuckDB reads table file; Bash reads the selected virtual input.path with quoted "$FILE" when advertised. Fresh saved snapshots only, 16 MiB input/15 seconds, no provider secrets, network, host paths or persistent source writes.

POST /database-import-preparations creates a review. Use application/json with resourceId, source:{resourceId,path}, parsing for Workspace CSV/Parquet. Use application/octet-stream with resourceId, filename, format and CSV header/delimiter query fields for a local upload. Both return 201, id and Location. Destination queries:execute/grant are required; Workspace inputs additionally require source read/analyze/grant. Uploads do not create a File System resource.
GET Location inspects a preparation without parsing again. DELETE Location cancels an unconsumed review (204). Reviews expire after five minutes and become unavailable after API restart; at most 1000 rows/100 columns/1 MiB parsed data, with a 20-row sample. POST /database-imports confirms resourceId, preparationId (the review id), confirmed:true, table and reviewed fields. New tables only, no append/overwrite. A consumed review does not prove import success; inspect partial/unknown writes before acting.
POST /file-export-preparations creates an actor-bound original/output review with the same GET/cancel lifecycle. POST /file-exports or /result-exports creates supported copies/results; check source and destination grants independently.

POST /resources/{resourceId}/setup-attempts requires resources:write and Idempotency-Key, with no body. It creates a durable inline setup attempt using saved bindings only; no replacement resource is provisioned when bindings are missing. Follow Location with GET, or list /resources/{resourceId}/setup-attempts using cursor/limit. GET never retries setup. Repeating the same caller/resource/key returns the original attempt without effects, including after restart. A different key explicitly requests supported reconciliation/idempotent setup; do not automate retries after unknown outcomes.

Use only your granted actions/resources. Local resources are labeled demos; live-provider availability and compatibility limits remain capability-specific. Check database expiresAt and export important data before expiry. Cloud telemetry is unmeasured. Never commit or upload credentials.
`;
}
