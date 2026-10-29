# ADR 0023: Destination-owned database imports

- Status: Accepted through PR #104; implemented under GH-103.
- Date: 2026-10-29.
- Contract: [GH-103 specification](../../specs/gh-103/spec.md).
- Extends [ADR 0013](0013-result-snapshot-exports.md) and [ADR 0018](0018-contextual-file-exports.md).

Offer Import in MySQL, db9 PostgreSQL and DuckDB workspaces. Upload retains its meaning of
saving a file; Import parses data into a reviewed new table. Local CSV/Parquet does not require
a customer File System. Keep public Workspace credentials at the gateway and native provider
credentials inside the Rust service.

Add bounded prepare/prepare-upload/commit API operations. Reuse private parsing workers,
field/type review and dialect-safe create-only writes. Uploaded bytes are ephemeral request/
worker input, never a public file or a hidden database backing resource. Preparations bind
principal, target database and the saved-source version where applicable; retain existing
expiry/count/result budgets and consume once before provider writes. Every commit path,
including an older export endpoint presented with a new ticket, must enforce target binding.

Local imports require destination queries:execute and resource access. Workspace file sources
also require source files:read/analyze and resource access. Reauthorize before side effects.
No scope is broadened, no automatic write retry/append/overwrite/DROP is added, and partial
outcomes require inspection. Old APIs and preparations retain their existing contract.

The Console shares TiUI review/progress and keeps database SQL state mounted. Source/parsing
changes invalidate review; acknowledgement and browser refresh remain distinct. No persistent
upload staging, background job, billing or metadata migration is introduced.

The accepted specification is pinned at `69b3adfc770e346047205638475d6966a5442961`.
Rust and Node compatibility routes, generated contracts and the Console now implement this
boundary; see [verification](../database-import-verification.md) for evidence and limitations.
Revisit this boundary for append/upsert,
larger/resumable input, durable jobs, cross-Workspace transfers or production compute isolation.
