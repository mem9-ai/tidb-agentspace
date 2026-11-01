# Public REST API design

- Status: Accepted project design direction (2026-10-31); GH-67 implements the P0 additions.
- Applies to every new or revised public business API. Existing operation coverage is not a
  claim that every historical endpoint conforms.

## Resource and HTTP rules

Global is the common public management and Region-discovery entry. SQL, table/file access,
analysis, import/export and regional operation observations use the selected Region's public
OpenAPI directly. Each operation must declare its serving authority; publishing its schema
through a Global catalog does not make Global a data proxy. Reuse validated known Region
routes without a mandatory Global preflight, preserving regional autonomy during Global
outage. The [regional API/auth contract](../../specs/gh-74/regional-api-auth.md#global-entry-and-operation-ownership)
owns the detailed target boundary and migration/acceptance gates. The separate generated [Global contract](../../public/global-openapi.json) and regional contract
now implement this boundary with the opt-in [regional Token profile](../regional-token-api.md).
Default existing credentials retain their current regional authority.

1. Give a business object a stable, tenant-scoped URI. Use plural collection nouns and opaque
   IDs: `/workspaces/{workspaceId}/resources/{resourceId}`. Put representations such as
   `/files/content` and filters such as `?path=` in the contract explicitly. Never encode
   credentials in a URI. A regional Workspace API URL and Key are the agent bootstrap inputs.
2. GET/HEAD observe; they must not start provisioning, deletion or customer SQL. POST creates
   subordinate resources or bounded result representations. PUT replaces a known object;
   PATCH changes declared fields; DELETE requests removal. Avoid `/execute`, `/delete`,
   `/prepare`, `/retry` command dispatchers in new paths.
3. Model durable asynchronous workflows as addressable objects with lifecycle and links.
   Return 201 + Location for creation, 202 + a status URI for incomplete removal, 204 only
   when there is no response body. A 202 must not imply a background queue or guaranteed
   completion. Record unknown external outcomes before I/O; observation never retries effects.
4. Authorization is action AND resource AND Workspace. Context discovery reports only the
   authenticated caller's effective grants; it grants nothing. Owner privileges, native
   credentials and internal execution/Meta routes remain distinct boundaries.
5. Publish strong ETags for versioned representations. If-Match protects replacement;
   If-None-Match:* protects creation. Return 412 for a failed precondition, 409 for a business
   conflict, 400 for malformed/unsupported condition syntax. Never turn a stale write into
   last-writer-wins. A backend without atomic preconditions must fail closed.
6. Define retry/idempotency for each mutation. An idempotency key binds caller, operation and
   payload. DELETE is idempotent in requested effect, not necessarily status code. SQL POST
   is not retried after timeout. Preserve request IDs and safe structured error codes.
7. State limits, ordering, truncation and consistency. New large collections need bounded
   cursor pagination. Current unpaginated prototype collections retain their documented
   bounds; do not imply million-resource capacity from URI design.
8. The editable OpenAPI generator, runtime, client types and behavioral tests move together.
   Additive backend capabilities without changed rendered journeys are accepted through
   native HTTP tests. Frontend interaction tests are outside GH-67 per explicit owner scope.

## Current resource model and remaining proposals

| Job                  | Resource design                                                                                            | Status                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Discover caller      | GET `/context`                                                                                             | Implemented GH-67                                                                      |
| Manage resources     | GET/POST `/resources`; GET/DELETE `/resources/{id}`                                                        | Implemented GH-67                                                                      |
| Browse database      | GET `/resources/{id}/tables`; GET `/tables/{tableName}` and `/rows` below the resource                     | Implemented GH-76; table identity is one encoded path segment                          |
| Submit SQL           | POST `/queries` returns a bounded result                                                                   | Implemented synchronous result; durable query IDs remain proposed                      |
| Read/write files     | GET/PUT `/files`, GET `/files/metadata`, GET/PUT `/files/content`, DELETE `/files/entry?resourceId=&path=` | Implemented; deletion has no body                                                      |
| Review imports       | POST `/database-import-preparations`; GET/DELETE `/{id}`                                                   | Implemented GH-76; Content-Type selects JSON Workspace input or uploaded bytes         |
| Confirm imports      | POST `/database-imports` references preparationId                                                          | Implemented; durable import jobs remain proposed                                       |
| Review exports       | POST `/file-export-preparations`; GET/DELETE `/{id}`                                                       | Implemented GH-76                                                                      |
| Export results/files | POST `/result-exports`, POST `/file-exports`                                                               | Implemented synchronous result; durable export jobs remain proposed                    |
| Resume setup         | POST `/resources/{id}/setup-attempts`; GET collection and `/{attemptId}`                                   | Implemented GH-76; durable records, scoped idempotency and observation without retries |

Paths are relative to `/api/v1/workspaces/{workspaceId}`. No aliases remain for historical
prepare/prepare-upload/setup, singular-table or DELETE-body routes. Preparation resources
retain their explicit process-local five-minute lifetime; setup attempts are independent
durable encrypted records. A new setup key explicitly requests supported reconciliation
or idempotent setup using existing bindings; missing bindings cannot create replacements.
See [GH-76](../../specs/gh-76/rest-workflows.md) and
[ADR 0032](../decisions/0032-rest-workflow-resources.md). Frozen historical specifications
retain their original names; active docs/callers follow the generated OpenAPI.

Creation Location references are relative to the request URI, so they resolve through the
same regional origin and any mounted API prefix without trusting forwarded Host headers.

Review this standard when adding durable operations, pagination or a new provider.
