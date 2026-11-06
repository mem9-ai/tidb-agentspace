export function agentInstructions(endpoint?: string): string {
  return `# Connect to my Workspace

API endpoint: ${endpoint || 'Ask for the Workspace API endpoint'}
API key: read WORKSPACE_API_KEY from the environment or a secret manager.

Use the endpoint and key to discover the Workspace and connect. Never send the key to the
discovered data endpoint, put credentials in a URL, or send SQL or file content to the API
endpoint. The workspace-agent.mjs client, available in API documentation, handles the connection
automatically. Your execution environment must be allowed to reach the Workspace API and its
verified Region endpoint; if network access is blocked, ask the user to permit those endpoints.

For direct HTTP:
1. POST to /v1/token-issuances at the API endpoint with the key as Bearer authorization and
   JSON {"audience":"global"}. Keep the returned workspaceId and accessToken.
2. GET /v1/workspaces/{workspaceId}/region-route at the API endpoint with that accessToken. Read the 307
   Location and X-Region-Id without automatically following the redirect.
3. POST to /v1/token-issuances at the API endpoint with the key and
   {"audience":"region"}. Verify that the returned region's origin, path and ID match the
   redirect. Require HTTPS, except for an explicitly loopback development endpoint.
4. Use the returned Region accessToken as Bearer authorization at the verified destination,
   with /api/v1/workspaces/{workspaceId} before the operation paths below. Never forward the key
   or Global Token to that destination. Access Tokens expire; request a new one when needed.

If a key cannot use this flow, ask the user to create or rotate a key; older keys may require
the Workspace-specific issuance endpoint. Do not delete or replace a key without permission.
For a long-running Node.js agent, the downloadable client supports local token renewal. To
resume across process restarts while the API endpoint is unavailable, retain the proof key and
rotating refresh state in an application-owned secret store.

Start with GET /context to discover permissions, then GET /resources if permitted. Respect
the Key's action and resource grants. Do not create, modify or delete data unless requested.

- GET /resources/{resourceId}/tables lists database tables. POST /queries runs one SQL statement;
  use readOnly:true for reads. Never blindly retry an uncertain write.
- GET /files?resourceId=RESOURCE_ID lists files. GET /files/content?resourceId=RESOURCE_ID&path=ENCODED_PATH&preview=1
  reads a bounded text preview; check the response for unavailableReason. For original downloads,
  /files/content supports Drive9 resources; local demo file listings include UTF-8 content.
- For read-only CSV SQL, POST /file-analyses with JSON {"resourceId":"RESOURCE_ID","path":"/example.csv",
  "engine":"duckdb","sql":"SELECT count(*) AS row_count FROM file"}. Use the actual resource ID,
  file path, and SQL appropriate to the task. The selected file is available as the SQL table named file.
  Inspect rows and errors in the response; do not invent results.
- GET /files/metadata?resourceId=RESOURCE_ID&path=ENCODED_PATH checks the destination. PUT /files
  creates a text file with JSON {"resourceId":"RESOURCE_ID","path":"/report.md","type":"file",
  "content":"REPORT_TEXT"} and header If-None-Match: *; use the actual destination and report.
  For updates, read metadata first and use If-Match with its version. Never blindly retry an uncertain write.
- POST /database-import-preparations creates a review. Inspect the result and obtain explicit
  confirmation before POST /database-imports creates a table.
- POST /file-export-preparations and POST /file-exports handle file exports; POST /result-exports
  exports a supplied query result. Check source and destination permissions.
- POST /resources/{resourceId}/setup-attempts requires resources:write and Idempotency-Key.
  Inspect the result before retrying any operation with an uncertain outcome.

Do not request provider credentials or commit the Workspace API key to source control.
`;
}

export function workspaceSkillTask(endpoint: string, skillUrl: string, task: string): string {
  return `Read and follow the TiDB Agent Workspace skill at ${skillUrl} using an unauthenticated GET.
Do not send the Workspace Key or any token to the skill URL. If the skill is unavailable, stop
and report the error rather than guessing. The Workspace Global API endpoint is ${endpoint}.
Read WORKSPACE_API_KEY from the environment or a secret manager; never put it in chat or a URL.

${task}`;
}

export function workspaceSkillUrl(origin: string, pathname: string): string {
  const directory = pathname.endsWith('/index.html')
    ? pathname.slice(0, -'index.html'.length)
    : `${pathname.replace(/\/+$/, '')}/`;
  return new URL(`${directory}skills/tidb-agent-workspace/SKILL.md`, origin).href;
}
