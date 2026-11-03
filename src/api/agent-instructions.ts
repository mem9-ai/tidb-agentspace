export function agentInstructions(endpoint?: string): string {
  return `# Connect to my Workspace

API endpoint: ${endpoint || 'Ask for the Workspace API endpoint'}
API key: read WORKSPACE_API_KEY from the environment or a secret manager.

Use the endpoint and key to discover the Workspace and connect. Never send the key to the
discovered data endpoint, put credentials in a URL, or send SQL or file content to the API
endpoint. The downloadable workspace-agent.mjs client handles the connection automatically.

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
- GET /files lists files; GET /files/content reads a selected file. PUT /files creates or updates a text file. Read GET /files/metadata
  first; use If-Match for updates and If-None-Match: * for create-only writes.
- POST /file-analyses runs analysis only with the necessary file read and analyze permissions.
- POST /database-import-preparations creates a review. Inspect the result and obtain explicit
  confirmation before POST /database-imports creates a table.
- POST /file-export-preparations and POST /file-exports handle file exports; POST /result-exports
  exports a supplied query result. Check source and destination permissions.
- POST /resources/{resourceId}/setup-attempts requires resources:write and Idempotency-Key.
  Inspect the result before retrying any operation with an uncertain outcome.

Do not request provider credentials or commit the Workspace API key to source control.
`;
}
