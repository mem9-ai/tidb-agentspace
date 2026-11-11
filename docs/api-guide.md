# Use the Workspace API

The Console’s **API docs** page provides your endpoint, agent instructions, downloadable
JavaScript and Python clients, and a searchable reference. Its read-only playground uses
your signed-in Workspace session. Keep API keys in environment variables or secret storage.

A Workspace has a `defaultRegionId` and each resource reports its own `regionId`. Initially,
only the Workspace's default Region is available. The existing resource `region` field is the
provider's data location, which may be `automatic`; it is separate from `regionId`. Existing
resources and provider credentials remain in place. Use the same single endpoint and Key for
the client below; you do not need to configure a Region URL.

## Choose a Key's resources

In **API keys**, choose specific resources by default. Search and select as many as needed (up to 1,024). In a paginated Workspace, a partial name filters loaded resources. Enter the full name to find a resource on another page. For access that follows new resources, choose **By resource type** and select databases, file systems, or both.

The Owner Key creation API accepts either `"resourceIds": ["fs_a", "fs_b"]` or `"resourceTypes": ["filesystem"]`. For example, a database reader uses `"resourceTypes": ["database"]` with `"scopes": ["resources:read", "queries:read"]`. The agent can inspect its effective selection in the Region context response. When listing resources, follow `nextCursor` even if the current page contains no matches.

## Start with one endpoint

Choose **JavaScript** or **Python** in Studio’s **API clients** section. Both clients list resources and files and run SQL with read-only queries by default. Set the endpoint and key in your environment. The [Python client](../src/clients/python/workspace_agent.py) uses only the standard library. Download it next to your script:

```python
import os
from workspace_agent import connect_workspace

workspace = connect_workspace(
    endpoint=os.environ["WORKSPACE_ENDPOINT"],
    api_key=os.environ["WORKSPACE_API_KEY"],
)
print(workspace.list_resources())
```

Python holds a short-lived Region token in memory. Call `connect_workspace` again after expiry. The [JavaScript client](../src/clients/javascript/workspace-agent.ts) also supports automatic regional renewal as described below.

New Workspace Keys allow an agent to start with only the Global API base URL and Key. The
downloadable Node.js client handles discovery, redirects and Token renewal. Download
`workspace-agent.mjs` from the Portal into your project:

```js
import { connectWorkspace } from './workspace-agent.mjs';

const workspace = await connectWorkspace({
  endpoint: process.env.WORKSPACE_ENDPOINT,
  apiKey: process.env.WORKSPACE_API_KEY,
});
console.log(await workspace.listResources());
```

Only Global receives the Key. The client first exchanges it for a Global Token and sends a
bodyless request to the Global Region route. It reads the 307 without automatically following
it, checks the target and compares it with the Region descriptor returned by authenticated
Global issuance, and sends data only to that Region. The redirect contains no credential. A
Global outage does not affect an already enrolled client's Region requests or local renewal.

By default the proof key and refresh state are in memory, so a process restart needs Global.
To reconnect after restart without Global, supply both the same Ed25519 `proofKey` and an
application-owned `RegionalSecretStore`; keep both in protected storage. The persisted route and
credentials are integrity-bound to the Global endpoint and Key. Browser Fetch may make a
cross-origin manual redirect opaque; this client flow is intended for Node.js rather than
cross-origin browser execution. It is a downloadable file, not a published npm package.

Keys issued before Workspace hints were introduced continue to work with the Workspace-scoped
Token endpoint below. To use the single-endpoint flow with one of those Keys, rotate it or
create a replacement; no existing Key, resource or provider credential is deleted.

<details>
<summary>Direct HTTP integration</summary>

For direct HTTP use, send the Key only to Global, and do not automatically follow a redirect
with credentials. The following keeps routing inside shell variables rather than requiring a
configured Region address. `curl` here does not use `--location`:

```sh
export WORKSPACE_ENDPOINT='https://workspace.example.test/api'
# WORKSPACE_API_KEY comes from protected application storage.
GLOBAL=$(curl --fail-with-body -sS "$WORKSPACE_ENDPOINT/v1/token-issuances" \
  -H "Authorization: Bearer $WORKSPACE_API_KEY" -H 'Content-Type: application/json' \
  -d '{"audience":"global"}')
WORKSPACE_ID=$(printf '%s' "$GLOBAL" | jq -er '.workspaceId')
GLOBAL_TOKEN=$(printf '%s' "$GLOBAL" | jq -er '.accessToken')
ROUTE_HEADERS=$(curl -sS -D - -o /dev/null \
  "$WORKSPACE_ENDPOINT/v1/workspaces/$WORKSPACE_ID/region-route" \
  -H "Authorization: Bearer $GLOBAL_TOKEN")
test "$(printf '%s\n' "$ROUTE_HEADERS" | awk '/^HTTP\// {code=$2} END {print code}')" = 307 || exit 1
REGION_API=$(printf '%s\n' "$ROUTE_HEADERS" | awk 'tolower($1)=="location:" {print $2}' | tr -d '\r')
REGION_TOKEN_RESPONSE=$(curl --fail-with-body -sS "$WORKSPACE_ENDPOINT/v1/token-issuances" \
  -H "Authorization: Bearer $WORKSPACE_API_KEY" -H 'Content-Type: application/json' \
  -d '{"audience":"region"}')
EXPECTED_REGION=$(printf '%s' "$REGION_TOKEN_RESPONSE" | jq -er '.region.apiOrigin + .region.apiPathPrefix')
case "$REGION_API" in https://*) ;; *) exit 1 ;; esac
test "$REGION_API" = "$EXPECTED_REGION" || exit 1
REGION_TOKEN=$(printf '%s' "$REGION_TOKEN_RESPONSE" | jq -er '.accessToken')
curl --fail-with-body "$REGION_API/api/v1/workspaces/$WORKSPACE_ID/context" \
  -H "Authorization: Bearer $REGION_TOKEN"
```

</details>

## Authentication and endpoints

| Authority | Credential                             | Responsibilities                                                           |
| --------- | -------------------------------------- | -------------------------------------------------------------------------- |
| Portal    | Verified user session                  | Create, list, inspect, renew, rotate and revoke Keys; manage the Workspace |
| Global    | Workspace Key, only on Token issuance  | Obtain a short-lived Token for `global` or the granted Region              |
| Global    | Global-audience access Token           | Discover authorized Regions and inspect its own issuance                   |
| Region    | Region-audience access Token           | Context, resources, SQL, files, analysis, imports and exports              |
| Region    | Client-bound refresh credential + DPoP | Rotate local refresh credentials and issue Region Tokens                   |
| Portal    | Regional Owner/account/Guest session   | Interactive resource operations allowed to that identity                   |

A Key is never a Region data credential. Region returns `EXCHANGE_KEY_AT_GLOBAL` for new
raw Keys and rejects retired direct Keys. Regional `/keys` endpoints are removed. Portal
Key management uses `/api/portal/v1/workspaces/{workspaceId}/keys` at **Global**. A create or
renewal request names a supported lifetime (`expiresInDays` = 1, 2, 7, 30 or 90) and the server
computes the expiry; the deprecated absolute `expiresAt` is still accepted for older clients but
only inside the same 90-day ceiling. Provider/native credentials remain private. API keys cannot
administer other Keys or acquire Owner privileges.
Hosted Owner sign-in uses the configured OIDC client and ready Global Directory membership.
On the bundled cloud deployment, sign in to Portal once. Its existing TiDB Account callback
establishes separate Global management and Region browser sessions; creating a Key does not
require a second sign-in or another registered callback. Logout revokes both attached sessions.
The Global Owner session expires after eight hours; another interactive sign-in is then required
for Key management. Region Tokens remain independent of browser cookies.
A Guest Workspace is not a Global Owner account. Explicit local development profiles can use
`POST Global /api/session` only from a real loopback peer with a trusted Origin; hosted deployments reject this mode.

Configure only the Workspace API endpoint and Key. The client discovers and verifies its data
destination. The optional direct-HTTP example above derives its Region variables automatically;
users do not configure a second endpoint.

A short-lived Region issuance returns `accessToken`, `tokenType: "Bearer"`, Unix-second
`expiresAt`, `keyId`, `keyVersion`, `principalId`, `scopes`, and a `region` descriptor.
Without `clientThumbprint` it does not create a refresh family. Tokens last at most 15 minutes
and never outlive the actual parent Key expiry. Use `audience: "global"` in a separate exchange
for Global `/regions` discovery; a Region Token is not valid at Global.

For long-running agents, the downloadable client accepts an
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
Inspect `capabilities.postgresql` for database availability.

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
Do not describe pending delivery as immediate Region revocation. The Region connection profile
reconciles persisted pending policy changes after reconnection; an explicit policy-delivery
operation remains available for inspection/retry. GET never retries an effect.

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

For an account-free public US sales report, open your project in a local coding agent such as Claude Code, Cursor, Codex, or Pi. Choose **With your coding agent → Copy prompt** in Studio and paste it into your agent’s project chat. The agent needs HTTPS access to the linked instructions and permission to run the report helper locally. A native credential store under the same OS user lets another agent resume the saved report in that project. After saving, the agent returns a read-only Studio link and the local Markdown. Reply yes in the same chat to add the leading state’s top product. Reopen the original link to see the result. For a fresh agent chat, copy the follow-up from the first-version report and use the same local project. The completed sample links to Workspace Files for working with your own CSV. Anyone with the full link can view the latest saved revision until the original trial expires. The local Markdown survives expiry. See [report links](decisions/0053-trial-report-view.md). The local trial and its recovery boundaries are described in [ADR 0052](decisions/0052-anonymous-agent-report.md).
