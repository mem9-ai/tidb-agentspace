# Use the Workspace API

The Console’s **API documentation** page uses your actual Global/Region endpoints and
resource IDs. It includes copyable cURL (curl + jq), Node.js 24 and Python examples and a
searchable reference for every generated operation. Its read-only playground uses your
Workspace Owner session to inspect current data; agent examples use Region Tokens. Both schemas are downloadable independently:
[Global OpenAPI](../public/global-openapi.json), [Region OpenAPI](../public/openapi.json).
Examples use environment variables; inject credentials from application secret storage.

## Authentication and endpoints

| Authority | Credential                             | Responsibilities                                                                    |
| --------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| Global    | Verified Global Owner cookie           | Create, list, inspect, renew, rotate and revoke Keys; observe/retry policy delivery |
| Global    | Workspace Key, only on Token issuance  | Obtain a short-lived Token for `global` or the granted Region                       |
| Global    | Global-audience access Token           | Discover authorized Regions and inspect its own issuance                            |
| Region    | Region-audience access Token           | Context, resources, SQL, files, analysis, imports and exports                       |
| Region    | Client-bound refresh credential + DPoP | Rotate local refresh credentials and issue Region Tokens                            |
| Region    | Regional Owner/account/Guest cookie    | Interactive operations allowed to that identity; not Global Key management          |

A Key is never a Region data credential. Region returns `EXCHANGE_KEY_AT_GLOBAL` for new
raw Keys and rejects retired direct Keys. Regional `/keys` endpoints are removed. Public
Key management uses `/api/v1/workspaces/{workspaceId}/keys` at **Global**. Provider/native
credentials remain private. API keys cannot administer other Keys or acquire Owner privileges.
Hosted Owner sign-in uses the configured OIDC client and ready Global Directory membership.
A Guest Workspace is not a Global Owner account. Explicit local development profiles can use
`POST Global /api/session` only from a real loopback peer with a trusted Origin; hosted deployments reject this mode.

Set `GLOBAL_API` to the Global base URL and `REGION_API` to the Region base URL, including
any deployment prefix. Independently deployed services may use different domains. A shared
hosted listener typically uses `https://HOST/studio/api/global` for Global and
`https://HOST/studio` for Region. Do not append `/api/v1` to these base variables.
`GET Region /api/auth/config` exposes the configured `globalApi` and `regionId` without
contacting Global. Global data-proxy endpoints do not exist.

```sh
export GLOBAL_API='https://global.example.test'
export REGION_API='https://region.example.test'
export WORKSPACE_ID='YOUR_WORKSPACE_ID'
export REGION_ID='region:YOUR_REGION'
# WORKSPACE_API_KEY is injected by your secret manager.
TOKEN=$(curl --fail-with-body -sS "$GLOBAL_API/api/v1/workspaces/$WORKSPACE_ID/token-issuances" \
  -H "Authorization: Bearer $WORKSPACE_API_KEY" -H 'Content-Type: application/json' \
  -d "{\"audience\":\"$REGION_ID\"}" | jq -er '.accessToken')
curl --fail-with-body "$REGION_API/api/v1/workspaces/$WORKSPACE_ID/context" \
  -H "Authorization: Bearer $TOKEN"
```

A short-lived Region issuance returns `accessToken`, `tokenType: "Bearer"`, Unix-second
`expiresAt`, `keyId`, `keyVersion`, `principalId`, `scopes`, and a `region` descriptor.
Without `clientThumbprint` it does not create a refresh family. Tokens last at most 15 minutes
and never outlive the actual parent Key expiry. Use `audience: "global"` in a separate exchange
for Global `/regions` discovery; a Region Token is not valid at Global.

For long-running agents, [the repository client](../src/api/agent-client.ts) accepts an
Ed25519 `CryptoKeyPair` and a `RegionalSecretStore` implemented using your application’s
protected storage. Initial Global issuance includes the public JWK thumbprint; the SDK enrolls
its returned one-use ticket at Region. It stores refresh credentials/nonces atomically, caches
the trusted Region route, and renews locally, including during a Global outage. It never sends
the refresh credential to Global or automatically retries data writes. Protect and retain the
proof key separately from the serialized refresh session. See [renewal and DPoP](regional-token-api.md).
Actual Key expiry and delivered denials continue to apply; stale policy age does not expire access.

## Actions and resource grants

`GET /context` reports effective scopes, resource IDs, expiry, capabilities and limits.
A Key grants explicit existing resource IDs, or `["*"]` for current and future resources.
`resources:write` with wildcard access is needed to create resources. The service checks
resource ownership at Region before any provider I/O, even if a grant names an unknown ID.

| Workflow at Region                                 | Required actions                                |
| -------------------------------------------------- | ----------------------------------------------- |
| Resource discovery/details                         | `resources:read`                                |
| Resource creation/deletion/setup attempts          | `resources:write` (creation also needs `["*"]`) |
| Catalog, bounded row preview, constrained SELECT   | `queries:read` (implied by `queries:execute`)   |
| SQL writes and database import destination         | `queries:execute`                               |
| List/read/preview files                            | `files:read`                                    |
| Create/update/delete files                         | `files:write`                                   |
| Custom file analysis; Workspace file import source | `files:read` and `files:analyze`                |
| Usage                                              | `usage:read`                                    |

Selected database/File System grants apply independently to every source and destination.
Lists return `nextCursor`; pass it as `cursor` and keep the same filters. Counts refer to the
loaded page. Encode a complete table name as a single URI segment and encode file paths as
query values. Filesystem paths are virtual absolute paths, not host paths.

```sh
curl --fail-with-body "$REGION_API/api/v1/workspaces/$WORKSPACE_ID/queries" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"resourceId":"DATABASE_ID","sql":"SELECT 1 AS ready","readOnly":true}'
```

Queries accept one statement, up to 64 KiB SQL, 15 seconds, 1000 rows/1 MiB result. Read-only
access enforces a bounded SELECT/CTE/VALUES subset; it does not grant arbitrary SQL execution.
MySQL, PostgreSQL and DuckDB have explicit provider compatibility limits; inspect capabilities.

## Files, imports and exports

Create-only writes use `If-None-Match: *`. To update, first `GET /files/metadata?resourceId=ID&path=PATH`,
read the exact quoted `data.version` (also the `ETag`), then send it unchanged as `If-Match` on
`PUT /files` or `PUT /files/content`. A stale version returns 412 without a write. Never fall
back to an unconditional overwrite. Binary transfers use `application/octet-stream`.

Database imports use `POST /database-import-preparations` with a selected Workspace source
and parsing options, or a bounded binary upload. Review returned `id`, `fields` and sample
`rows`, then explicitly confirm using `POST /database-imports` with `preparationId`,
`confirmed:true`, a **new** table name and reviewed `fields`. Preparations expire after five
minutes and do not survive restart. GET their Location to inspect; DELETE it to cancel.

`POST /result-exports` exports a bounded, already-returned result to a download, public File
System or a new database table. A download returns JSON with `filename`, `mimeType` and
`content`, not an HTTP attachment. `POST /file-export-preparations` and `/file-exports`
review and copy saved/analysis files. See [import examples](database-import-verification.md),
[result export examples](result-export-verification.md) and the Console’s copyable examples.

## Lifecycle, errors and retries

Key mutations require an Owner cookie, a trusted `Origin` and UUID `Idempotency-Key`.
Renew/rotate/revoke also require the quoted current Key-version `If-Match` ETag.
List/detail never return the secret. Replaying a secret-producing request does not reveal a
second copy. Create returns the one-time secret; store it before leaving the page.
`regionalStatus: "pending"` means Region has not acknowledged policy application. Global
revocation blocks issuance immediately; Region rejects access after receiving the new policy.
Do not describe pending delivery as immediate Region revocation. Use a durable policy-delivery
resource to explicitly reconcile, including for revoked Keys; GET never retries an effect.

Errors have `{ "error": { "code", "message", "requestId" } }`:

| Status    | Meaning / action                                                                            |
| --------- | ------------------------------------------------------------------------------------------- |
| 400       | Invalid body, grants, path or conditional header; fix input                                 |
| 401       | Missing/expired/invalid credential; renew or sign in using its own authority                |
| 403       | Insufficient scope, resource grant or Owner authority; do not retry unchanged               |
| 404       | Unknown/unavailable resource or retired endpoint; avoid probing another Workspace           |
| 409       | Conflict, policy not applied, or uncertain lifecycle outcome; inspect the referenced state  |
| 412 / 428 | Stale / missing required version condition; read and review before changing                 |
| 413 / 429 | Input or concurrency limit; reduce the request / back off safe reads                        |
| 503       | Authority/storage unavailable or uncertain acknowledgement; inspect before repeating writes |

Region refresh rotates the verifier, generation and nonce atomically. Never blindly replay an
unknown refresh; the SDK preserves its exact enrollment/session intent and reports uncertainty.
SQL/import/setup/provider operations also need outcome inspection after a timeout. Setup is an
addressable `/resources/{id}/setup-attempts` resource with explicit idempotency; GET has no effects.
Resource deletion may return 202; inspect Location and `deletion.phase`. Acceptance does not
claim physical erasure and provider-specific unsupported deletion stays explicit.
