# ADR 0045: DuckDB creation-time table snapshot

- Status: Implemented locally; live validation is recorded separately.
- Date: 2026-11-03.
- Scope: DuckDB creation response and first Console visit.

Console amendment: standalone DuckDB creation and navigation were removed from the Console on
2026-11-03. Existing data and the API response remain available at the backend; the original
first-navigation behavior below is no longer reachable in the current Console.

## Decision

Creating a new DuckDB already attaches its dedicated storage to verify initialization. Reuse that
same disposable worker to read the bounded table catalog rather than running a separate connection
check and immediately attaching storage again. A successful, newly created DuckDB may return an
optional `initialTableSnapshot` in its creation response. It has the existing `TableList` shape,
represents tables observed during initialization, and is returned only when the authenticated
principal also has `queries:read` (or its existing `queries:execute` implication). Idempotent
replays, other providers, incomplete setup, and callers without that permission omit the snapshot.

The snapshot is not a cache and is never persisted in the resource. Other agents may make changes
immediately after it was observed. The Console keeps it only in memory for the first navigation,
labels it as the creation-time view, and provides an explicit current-table refresh. Reloads,
re-entry, and missing snapshots use the ordinary authorized table endpoint. After a successful
SQL statement or import the Console discards the snapshot and refreshes current tables. While
DuckDB catalog work occupies the per-database execution slot, the Console explains why SQL is
temporarily unavailable. SQL execution, permissions, file storage, worker isolation, cancellation,
and idempotent creation semantics otherwise remain unchanged.

## Verification and limits

Verify that only a fresh, active DuckDB with table-read access can receive a snapshot; other
resources and idempotent replays must not. Browser tests cover first-query availability, explicit
refresh, table changes after SQL, loading/error states, and fallback to ordinary reads. Native
tests remain responsible for authorization, isolation, persistence and worker lifetimes. A live
temporary database measures creation, first visible catalog and first query without interpreting a
single timing as a latency guarantee. Provider deletion acceptance is not proof of erasure.

This does not introduce a reusable process or a cached catalog. The earlier reusable-reader
description in ADR 0012 applies to the retired implementation; Rust's current per-task process
boundary is ADR 0021. Revisit if the execution boundary or provider's storage consistency changes.
