# GH-67: Agent API P0

- Intent: https://github.com/mem9-ai/tidb.ai/issues/67
- Direction: Owner accepted implementation on 2026-10-31.
- Source baseline: `9e4d41fb826524ac8e9fb0341b28bef40504e170`.
- Acceptance: Native HTTP/S3 only; no Console journey changes or browser acceptance.

## Requirements

| ID   | Observable requirement and acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 | `GET /workspaces/{workspaceId}/context` authenticates any valid caller without an extra action grant. Returns the current principal's scopes, resource grants, expiry, Workspace identity, relative regional API links and limits; never another Key, secret, provider binding or Owner profile. Keys use the Workspace API URL plus Bearer secret; there is no regional/global Key scan. Test restricted, expired, revoked and cross-Workspace Keys.                                                                                                                                                                                                                                             |
| P0-2 | `queries:read` authorizes catalog reads and a constrained parsed SELECT/CTE/VALUES subset (1024 lexer tokens, 32 nested delimiters). It never authorizes imports or database export destinations. Read-only SQL rejects mutations, writable CTEs, SELECT INTO, locks, multiple statements, executable comments, session commands and unknown/qualified functions before provider I/O. PostgreSQL additionally uses a disposable read-only transaction; DuckDB opens read-only. Existing `queries:execute` grants and credentials remain unchanged. An optional `readOnly:true` also constrains full-access callers.                                                                               |
| P0-3 | `GET /resources/{resourceId}` returns authorized public metadata and lifecycle capabilities. `DELETE` requires resources:write plus its grant, drains admitted domain work, journals an attempt before external effects and returns a retained tombstone. Local deletion finishes synchronously. Drive9/DuckDB and db9 requests are attempted once; accepted and unknown outcomes remain distinguishable and observable after restart. Repeated DELETE must not repeat the provider effect. Credentials/bindings remain encrypted and retained for reconciliation. Zero deletion is explicitly unsupported and changes nothing. New data access to deleting/deleted resources is denied.          |
| P0-4 | `GET /files/metadata?resourceId=...&path=...` returns an opaque version and ETag. Both JSON and binary PUT accept one strong If-Match validator or If-None-Match:*. Missing preconditions preserve existing unconditional PUT behavior; malformed/combined conditions fail 400; a stale/missing expected version fails 412 without effects. Local comparison and write are in one Meta transaction. Drive9 compares identity/revision then sends its atomic Expected-Revision condition, never emulates CAS with an unconditional write. Missing provider revision support fails closed. Concurrent same-version writes have one winner. Directory conditional writes are explicitly unsupported. |
| P0-5 | Public contract, generated types, runtime and native behavioral evidence agree. Existing records, resource IDs, Key secrets/digests/grants and native credentials survive normal and crash recovery; no storage reset, re-provisioning or credential rotation.                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## REST design and boundaries

Follow [REST API design](../../docs/standards/rest-api-design.md) and ADR 0031.
New P0 paths are resources with standard method semantics. Existing Console-facing command
paths remain implemented during this scoped addition; they are explicitly recorded design
debt, not advertised as a fully converted REST API. The design standard maps them to noun
resources before a later coordinated caller migration. No independent worker or queue is added.

External deletion acceptance does not establish physical erasure. Drive9 completion can be
observed from provider status; db9 completion still requires operator reconciliation. Unknown
attempts never resume automatically on restart. Existing authorized streaming downloads may
finish within their bounded lifetime. Credentials are not garbage-collected in this change.

Drive9's numeric revision CAS is atomic for the current file identity. Identity is also
checked before the request; the provider does not offer an atomic identity-plus-revision
condition. Provider-admin delete/recreate races are outside this guarantee. Public gateway
mutations are serialized with lifecycle deletion; expose this limitation rather than claim
cross-provider linearizability. Local validators change on every write, including identical bytes.
