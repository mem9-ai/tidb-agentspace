# ADR 0007: Database browsing through the SQL boundary

- Status: Accepted project choice for the owner-requested database browser, 2026-10-28.
- Implementation evidence: [verification](../database-browser-verification.md).

Developers and agents need table structure and bounded row previews without discovering native
credentials or constructing metadata SQL. Add three read operations to the Workspace API:
resource-scoped `/tables`, `/table?name=...` and `/table/rows?name=...`.

All reads require `queries:execute` and the selected database grant, just like SQL Editor.
`resources:read` remains resource discovery only. This does not create a read-only SQL role:
keys with `queries:execute` can already execute reads and writes. A separate read-only capability
would require a separately reviewed permission contract and native enforcement.

Use the existing provider adapter and database-scoped native connection. Restrict metadata to
`DATABASE()`, quote identifiers and encode metadata comparison values independently. Listing
is bounded to 500 entries with explicit truncation; preview is an unordered first 100 rows,
subject to the existing byte/time/concurrency budgets. Never count full tables for navigation.
On errors keep navigation and an explicit retry/query action; don't silently return a partial
result. Metadata/rows are not persisted. Native credentials remain backend-only.

The Console uses one SQL workspace per database, with a persistent table navigator beside the
editor and query results/table inspection underneath (owner correction, 2026-10-28). Table
selection preserves the editor draft and previous results. Query table explicitly generates a
SELECT and protects edited SQL with a replace/keep choice; it does not execute automatically.
Following [GH-54](https://github.com/siddontang/tidb.ai/issues/54), table selection expands column
names/properties inline and keeps Query results active. Table details is an explicit secondary
choice. Both column views share the same selected-table API result in route-local memory;
refresh/retry obtains a new authorized read. New metadata reads wait for active SQL/list/row
operations rather than competing with DuckDB's single-operation admission. The API contract
and backend authorization remain unchanged; no metadata is persisted.
For MySQL column expansion, fetch table identity, columns and index parts in one server-generated
`UNION ALL` catalog query instead of opening three sequential TLS sessions. Filter every branch
to `DATABASE()` and the same hex-encoded table name, order column/index parts, and retain the
native 15-second, 1,000-row/1 MiB error boundary across the combined result (no silent truncation).
No shared native connection or automatic SQL retry is introduced. Both Rust and the Node
compatibility API implement this MySQL optimization; DuckDB retains its provider-specific path.
Rust PG metadata reads table identity, columns and indexes through one disposable native session
under a combined 15-second/1,000-row/1 MiB budget. Every statement is server-generated, scoped
to `workspace` and prepared separately; an error stops the remaining reads and returns no partial
description. The application role and verified TLS remain required. Customer SQL continues to
use independent sessions; this is neither a connection pool nor a persistent customer session.
The route-local Console cache retains at most 16 successful table descriptions for 30 seconds;
revisiting a table does not extend that window. Resource changes, refresh and retry discard it.
Errors and aborted reads are not cached. Explicit refresh remains the way to observe external
schema changes immediately. Do not add background catalog reads that compete with DuckDB work
or cache authorization/provider credentials to hide latency. Measure actual API requests and
cold/revisited UI paths separately when changing this behavior. See [latency verification](../database-column-latency-verification.md).
Console table-list, metadata and row reads have a 20-second whole-read deadline, including body
decoding. A stalled request aborts and becomes an explicit retryable error; navigation aborts
remain silent, and failed/aborted reads never enter the success cache. This UI bound does not
retry SQL or imply that a timed-out database write was rolled back. See
[PG latency and timeout verification](../postgres-column-latency-verification.md).

Existing `/tables` and `/sql` links both open the unified workspace and retain table identity.
Demo tables remain labeled. See [unified workspace verification](../database-workspace-verification.md).

This additive contract needs no persisted-data migration or new grants. Roll back application
code without modifying database data. Revisit with read-only roles, pagination, multiple schemas
or another database protocol. See the [acceptance specification](../../specs/database-browser/spec.md)
and [TiDB Cloud integration policy](../architecture.md#tidb-cloud-integration-policy).

Verified upstream reference (2026-10-28): TiDB's
[Information Schema](https://docs.pingcap.com/tidb/stable/information-schema/) exposes TABLES,
COLUMNS and STATISTICS; [STATISTICS](https://docs.pingcap.com/tidb/stable/information-schema-statistics/)
provides index part order and prefix length. This implementation filters those reads to the
connection database. Live acceptance verifies the installed provider behavior.
