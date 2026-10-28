# ADR 0013: Export bounded result snapshots through Workspace authorization

- Status: Proposed with [GH-58](../../specs/gh-58/spec.md); accepted on design PR merge.
- Date: 2026-10-28.
- Scope: additive result export API, create-only destination semantics and Console workflow.

The owner requests multiple download formats plus direct export into another workspace
database or File System, selecting new tables with collision errors. The existing result
snapshot is sufficient; rerunning a source query could repeat writes or return different data.

Add one authenticated result-export operation accepting bounded client-supplied rows and a
source authorization context. It never claims server-attested result provenance or reruns SQL.
Check source grants/actions and every destination grant/action using current Workspace Key
or owner authority. Reuse private SQL/file adapters; provider credentials and DuckDB backing
storage never become user-selectable targets. Existing scopes do not acquire broader rights.

Offer CSV/JSON/JSON Lines download/file output and create-only live database tables. Validate
the complete serialization/write plan before I/O. Preserve precision strings and use explicit
types plus dialect-safe identifier/text encoding. Retain the existing SQL/upload budgets.
The specification defines CSV's null/nested/formula-string conversion and exact JSON alternative.

File creation is conditional in the provider or store. Database export uses CREATE and one
INSERT, rather than assuming cross-provider transactional DDL or CREATE TABLE AS SELECT.
Report an incomplete/unknown outcome if the second step fails or a write times out. Never
append to a conflicting table, retry automatically, or DROP as compensation. Audit no values.
This is a bounded data-copy operation, not a schema clone or a whole-database migration.

No migration or credential change is needed. Existing SQL/file endpoints remain compatible.
Rollback of code leaves exported customer objects intact. The implementation PR must cover
the specification's authorization, serialization, conflicts, partial writes, packaging and
browser cases. Review this boundary before adding durable jobs, overwrite/append, larger
transfers, external connections or transactional imports. Implementation is pending.
