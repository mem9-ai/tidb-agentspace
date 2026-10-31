# GH-76: Addressable REST workflow resources

- Intent: https://github.com/mem9-ai/tidb.ai/issues/76
- Direction: Owner requested implementation and removal of old interfaces on 2026-10-31.
- Source baseline: `dfd11f1da7b59978fffa9df04dafb3b7b5414f59`.
- Scope: Public API resource modeling, existing callers, contract, native acceptance and docs.
- Non-goals: A new queue/service, arbitrary jobs, billing, metadata reset, credential migration,
  full durable query/export jobs, new UI journeys or live provider operations.

## Public workflow contract

All paths below are relative to `/api/v1/workspaces/{workspaceId}`.

| ID     | User outcome / operation                                                                                     | Observable contract and acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST-1 | Create a database import review: POST `/database-import-preparations`                                        | JSON selects a Workspace source; application/octet-stream selects a local upload using the existing explicit parsing query fields. Both return 201, Location and the same preparation entity with `id`, createdAt, expiresAt, ready/consumed status and the bounded review. No separate upload command URL. Destination queries:execute and grant; Workspace inputs additionally need source read/analyze and grant.                                                                                                                                                                                                                  |
| REST-2 | Inspect/cancel a review: GET/DELETE `/database-import-preparations/{id}` or `/file-export-preparations/{id}` | File export creation is POST `/file-export-preparations`, also 201 + Location. GET returns the cached review without parsing or source/provider I/O. Actor, collection kind, current action/resource grants and Workspace must match. Missing, expired or foreign IDs return 404; consumed IDs remain observable but cannot be cancelled (409). DELETE cancels a ready review with 204 and no body. Reviews remain bounded, five-minute, process-local resources: restart/eviction makes them unavailable; no promise of durability or automatic execution.                                                                           |
| REST-3 | Confirm import/export: existing POST `/database-imports` or `/file-exports`                                  | `preparationId` references the returned entity `id`. Preserve actor/destination/source-version binding, expiry, single-use claiming, reviewed fields, create-only writes and permission rechecks. Source and result values/limits do not change.                                                                                                                                                                                                                                                                                                                                                                                      |
| REST-4 | Resume an existing resource: POST `/resources/{resourceId}/setup-attempts`                                   | Require resources:write, target grant and a nonempty Idempotency-Key of at most 128 UTF-8 bytes. No request body. Return 201 + Location and `{data: attempt}`. Attempt has stable ID, resource ID, timestamps, status succeeded/failed/outcome-unknown, safe errorCode (nullable) and a public resource snapshot. Journal outcome-unknown before provider I/O. Reusing a caller/resource/key returns the original attempt without effects, including after restart or crash.                                                                                                                                                          |
| REST-5 | Observe setup: GET `/resources/{resourceId}/setup-attempts/{id}` and collection GET                          | Require resource grant plus resources:read or resources:write. Point observation never provisions or retries. Collection uses bounded cursor pagination, default 20/max 100, ordered by opaque ID, with nextCursor. Setup attempts are independent encrypted Meta records and survive restart. Failed/uncertain attempts never cause automatic retries; a different key explicitly requests a new attempt limited to reconciliation/idempotent setup against saved bindings. Missing bindings cannot trigger fresh database or filesystem provisioning. An already active resource produces a succeeded attempt without provider I/O. |
| REST-6 | Browse tables: GET `/resources/{id}/tables/{tableName}` and `/rows`                                          | Replace singular `/table?name=` routes. Encode the exact name as one URI segment, decode once, reject malformed encoding and preserve dialect-safe SQL quoting, read scopes, bounds and values. Encoded slashes are table-name data, not routing separators.                                                                                                                                                                                                                                                                                                                                                                          |
| REST-7 | Delete file: DELETE `/files/entry?resourceId=...&path=...`                                                   | Identity is entirely in the URI, with no request body. Preserve scopes, traversal protection, non-recursive directory behavior, exact file effects and the existing 200 deletion result.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| REST-8 | Remove old interfaces and preserve data                                                                      | Old prepare/prepare-upload/setup, singular-table and DELETE-body routes are absent from OpenAPI and return 404 for authenticated valid legacy requests. No aliases or redirects. Update native fixtures, first-party transport, downloaded agent instructions, tooling and active documentation. Existing format-2 records, resources, Key secrets/grants and private provider credentials remain unchanged; no reset, replacement account/resource or rotation.                                                                                                                                                                      |

## Invariants and failure semantics

Preparations do not write customer data. Their status `consumed` only means a write was
claimed; it is not evidence that a table import succeeded. Current incomplete-write errors
and source freshness checks remain authoritative. Cancellation cannot undo an admitted write.

Setup attempts execute inline inside Region, with admission serialized locally. No background
work is promised. Unknown effects are recorded before the call; interruption leaves a readable
unknown attempt. Replays cannot invoke the provider. A new explicitly requested attempt may
reconcile an unknown db9 creation by listing saved account resources, but must not repeat its
creation POST. Zero and private DuckDB storage likewise require existing saved bindings.
Only provider-supported, idempotent setup on the saved target is allowed. Public snapshots and
errors never contain private account IDs/tokens, SQL, passwords or provider endpoints.

A single Meta transaction creates an attempt and its caller/resource-scoped idempotency
reference. Final status and its resource snapshot are committed together with any public
resource update; private binding records are preserved. Operation records live outside the
bounded bootstrap state projection and are writer-fenced like other Workspace records.
A code rollback does not undo writes or restore removed HTTP routes; it does not require
reinitializing metadata. No automatic garbage collection of credentials or attempts is added.

## Acceptance and delivery

Freeze this spec and ADR in a design PR before the implementation PR. Map REST-1..REST-8 to
native HTTP schema/status/header assertions, independent actor/resource/Workspace denials,
legacy no-I/O checks, preparation cancellation/consumption, setup replay/concurrency/fault
injection and normal/SIGKILL recovery in remote/in-process Meta compositions. Inspect all
first-party requests against the generated contract; unchanged rendered journeys use native
API acceptance rather than new manual Portal flows. Shared CI applicability remains enforced.
Run `npm run check` and `npm run backend:check` on clean committed source, review the candidate,
and follow the existing latest-head CI/merge policy. Do not operate live cloud resources.
