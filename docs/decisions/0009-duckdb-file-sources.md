# ADR 0009: Authorized query-scoped file sources

- Status: Accepted and implemented for the loopback prototype; see [verification](../duckdb-sources-verification.md).
- Date: 2026-10-28. [GH-34 baseline](../../specs/gh-34/spec.md).

## Console presentation amendment

The owner clarified in [GH-50](https://github.com/siddontang/tidb.ai/issues/50) that DuckDB's
Console must follow the tidbfs native database model in [ADR 0008](0008-duckdb-private-storage.md).
The custom File sources picker/counter is removed from the database workspace. This supersedes
GH-34's Console picker acceptance; its historical verification remains evidence of that earlier
implementation. The optional `sources` API, selected-file authorization and snapshot isolation
below are retained unchanged. File System Analyze remains the Console entry for file analysis.

## Decision

DuckDB SQL may use explicit public Workspace File System sources. Add a `sources` array to
the existing query API and expose named sources in an ephemeral `files` catalog. Authorize
the DuckDB and every File System plus query/read/analyze actions before I/O. The new
`files:analyze` action prevents automatic compute access for existing file-read Keys.

Do not give customer SQL a provider-wide filesystem credential or enable arbitrary external
access. The parent adapter fetches bounded selected-file snapshots; trusted native setup
materializes them, opens the native database read-only and disables external access before
customer SELECT execution. No SQL rewriting, user-supplied provider URL or runtime path is
needed. Source tables exist only in that query and cannot expose the private database/WAL
store. Future larger remote scans require a separately verified constrained access path.

## Evidence and consequences

The pinned native Node runtime 2.0.0-r.1 was locally checked: an in-memory `files` catalog
retains selected CSV data after `enable_external_access=false` and `lock_configuration=true`,
while direct external readers fail. Native prepared statements report a SELECT statement
type; enforce it instead of relying only on SQL prefixes. DuckDB's
[security guidance](https://duckdb.org/docs/2.0/operations_manual/securing_duckdb/overview)
describes these settings as defense in depth, requiring OS isolation for public untrusted SQL.

This trades remote scan/pruning for a bounded 16 MiB snapshot and an explicit per-query source
list. Validate size and metadata changes where observable; no multi-file transactional snapshot
is promised. Existing ordinary database SQL stays unchanged. Source queries cannot persist
data, mounts, credentials or new file permissions. Read/write operations on standalone Files
remain governed by their existing actions. GH-26's separate single-file analysis/Just Bash UI is implemented in [ADR 0010](0010-read-only-file-analysis.md); query-scoped database sources are implemented separately by GH-34.

## Verification and recovery

GH-34 defines format, permission, native restriction, limit/cancellation/cleanup, packaging,
live and theme/viewport acceptance. CI uses local native fixtures and injected providers only.
Versioned implementation evidence maps these requirements to native/API, real-service and browser checks. Revisit for larger
streaming scans, persistent imports or public hosting. Rollback removes source-query capability
without changing remote source files or private database storage.
