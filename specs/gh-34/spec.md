# GH-34: DuckDB queries over authorized Workspace files

- Owner/intent contributor: Siddon Tang; [intent #34](https://github.com/siddontang/tidb.ai/issues/34).
- Status: Design baseline revision 1, 2026-10-28; implementation pending.
- Source baseline: `7031f139ef5f4fbd66d549a4c3867b960d268a93`.
- Dependencies: GH-28 DuckDB, existing File System APIs, ADRs 0001/0004/0008, shared TiUI.
- Relation: Extends database SQL with selected file inputs. The separate File System analysis
  and Just Bash surface in GH-26 remains pending; this does not close that parent.

Current implementation note, 2026-10-28: this baseline was implemented; see
[verification](../../docs/duckdb-sources-verification.md). The Console picker requirement is
superseded by the owner's native-database correction in [GH-50](https://github.com/siddontang/tidb.ai/issues/50)
and the [ADR 0009 amendment](../../docs/decisions/0009-duckdb-file-sources.md#console-presentation-amendment).
The query-source API and its permission/snapshot boundary remain supported. The earlier
Console requirements below are historical; File System Analyze is implemented separately.

## Outcome and API

In a DuckDB database workspace, choose public File System files, name each source, then query
`files.orders` using the existing SQL editor. CSV, JSON arrays/objects, NDJSON/JSONL and Parquet
are supported. Sources are explicit, read-only, per-request snapshots; they do not become
persistent tables or database storage. Multiple selected sources may be joined with each other
and existing database tables. Choosing sources never executes customer SQL automatically.

Extend `POST /workspaces/{id}/queries` additively:

```json
{
  "resourceId": "db_example",
  "sql": "SELECT region, SUM(amount) AS total FROM files.orders GROUP BY region",
  "sources": [{ "name": "orders", "resourceId": "fs_example", "path": "/orders.csv" }]
}
```

`sources` is optional, max four entries, with unique lower-case SQL names matching
`[a-z][a-z0-9_]{0,31}`. Paths are exact absolute Workspace paths without traversal, globbing,
URLs or credentials. Formats follow supported suffixes; unknown fields, directories, empty
files, malformed data and unsupported formats return structured errors. An empty array behaves
like ordinary database SQL. Nonempty sources on MySQL/demo resources are rejected.

Require `queries:execute` and the selected DuckDB resource grant, plus **both** `files:read`
and new `files:analyze` and every public source File System resource grant. Validate all inputs
and authorization before any provider/worker I/O. Existing read/query keys gain no new action.
The owner session follows the same domain operations. Recheck expiry/revocation before file
reads, native execution and returning file-derived results. Hidden backing stores remain
unaddressable, even with wildcard grants. No public request accepts native paths/options/tokens.

## Execution and failure boundary

The backend fetches only explicitly selected files into a private query directory, with a
16 MiB combined input ceiling and checks before and during reads. Compare metadata/size before
and after the read, including revision/ETag where supplied; report a conflict on observed
change. This is a query snapshot, not a transaction across remote files. Provider upload limits
are unchanged. Oversized/unsupported files retain the existing Download path.

Trusted initialization opens the selected database read-only, registers materialized source
tables in an in-memory `files` catalog using fixed native readers, then disables all external
access and locks configuration before parsing customer SQL. Require exactly one native SELECT
statement (including CTEs/aggregates/joins); reject writes, COPY, configuration, secrets, external
reads, extensions and attach operations. Source filesystem credentials stay in the parent
adapter; the existing private database credential remains backend worker IPC only.

Retain 64 KiB SQL, 1,000 rows / 1 MiB output, 256 MB configured native memory, two threads,
disabled temp spill, four active database operations and one per database. File loading and
execution share a 15-second deadline. Cancel abandoned work; terminate the worker and remove
private snapshots on success, error, timeout and disconnect. Never retry SQL automatically.
DuckDB settings supplement the existing trusted loopback boundary, not an OS sandbox or
authorization for public untrusted SQL hosting.

## Console and agent experience

Use installed TiUI 2.9.1 and SQL Editor 0.0.6, shared 16px typography, spacing and themes.
Keep sources, selected File System/path/name, SQL and results inside the database workspace.
Allow adding/removing sources and browsing file directories; preserve SQL while changing
sources and clear stale file-derived results. Disable edits during execution. Show query-only
source lifetime, limits and useful errors; no provider/native setup in customer flows.
Add the analyze action to Key configuration and document the same generated API for agents.

## Mandatory acceptance

| ID       | Required evidence                                                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DFILE-01 | Native CSV, JSON/NDJSON and Parquet fixtures yield known aggregates, joins, NULLs and precise numbers; same formats work on real Singapore files.                                                                     |
| DFILE-02 | Missing query/read/analyze actions, either resource grant, wrong workspace, expiry, revocation and hidden backing IDs deny before provider/engine I/O; revocation during load discards results.                       |
| DFILE-03 | Native SELECT semantics and read-only attachment prevent database/source writes; external/local/network reads, globbing, attach, COPY, settings/secrets and second statements are denied without leaking credentials. |
| DFILE-04 | Input/result/time/concurrency ceilings, file growth/change, invalid data, cancellation and failed setup clean snapshots/workers; no implicit retries.                                                                 |
| DFILE-05 | Inputs/catalogs do not survive the request or appear in public resources/keys; ordinary DuckDB/MySQL/files behavior remains compatible.                                                                               |
| DFILE-06 | API generator/client/implementation align; extracted API packages new modules and native dependencies; CI needs no cloud credentials.                                                                                 |
| DFILE-07 | Source picker, SQL execution and errors work in Light/Dark at 1280×900 and 390×844 with keyboard execution and no stale results.                                                                                      |

## Delivery

Merge the reviewed specification first; implement against its frozen Git revision in a separate
PR. Run `npm run check`, adversarial native/provider/API tests, task-owned live CSV/JSON/Parquet
verification and browser inspection. Merge only latest-head green CI with correct sign-offs,
then update and verify the local preview before closing #34. Use existing anonymous resources
and task-owned sample files. No new paid/public infrastructure, native CLI dependency, generic
external URLs, persistent mounts, upstream writes or Just Bash work is included.

Rollback disables source queries; original remote files and private database bindings remain
unchanged. Implementation evidence will link requirement IDs, candidate/source revisions,
observed checks and remaining limitations. No material product decision remains unresolved.
