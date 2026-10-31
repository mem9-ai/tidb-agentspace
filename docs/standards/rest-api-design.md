# Public REST API design

- Status: Accepted project design direction (2026-10-31); GH-67 implements the P0 additions.
- Applies to every new or revised public business API. Existing operation coverage is not a
  claim that every historical endpoint conforms.

## Resource and HTTP rules

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

## Complete target resource model

| Job                | Resource design                                                                       | Implementation status                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Discover caller    | GET `/context`                                                                        | GH-67                                                                                                          |
| Manage resource    | GET/POST `/resources`; GET/DELETE `/resources/{id}`                                   | GH-67 completes detail/removal                                                                                 |
| Browse database    | GET `/resources/{id}/tables`; target GET `/tables/{tableName}` and `/rows`            | Existing singular `/table?name=` needs a coordinated caller migration                                          |
| Submit SQL         | POST `/queries` creates a bounded query-result representation                         | Implemented synchronous result; durable query IDs/results remain future work                                   |
| Read/write file    | GET `/files`, GET `/files/metadata`, GET/PUT `/files/content`, JSON PUT `/files`      | GH-67 adds metadata/conditions; DELETE body is historical debt; target DELETE `/files/entry?resourceId=&path=` |
| Review import      | POST `/database-import-preparations` (upload representation selected by Content-Type) | Target replacement for `/database-imports/prepare[-upload]`                                                    |
| Commit import      | POST `/database-imports` referencing reviewed preparation                             | Implemented; durable import status remains future work                                                         |
| Review export      | POST `/file-export-preparations`                                                      | Target replacement for `/file-exports/prepare`                                                                 |
| Export result/file | POST `/result-exports`, POST `/file-exports`                                          | Implemented synchronous result; durable export IDs remain future work                                          |
| Resume setup       | POST `/resources/{id}/setup-attempts` with an addressable attempt/status              | Target replacement for `/setup`; never blindly repeats unknown provisioning                                    |

Paths above are relative to `/api/v1/workspaces/{workspaceId}`. Targets are design, not
routes promised by the current OpenAPI. A later migration must update first-party callers
and native acceptance together; simply renaming a verb endpoint does not create a resource.

Review this standard when adding durable operations, pagination or a new provider.
