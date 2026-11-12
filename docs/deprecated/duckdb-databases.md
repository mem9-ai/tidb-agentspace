# DuckDB databases

> **Deprecated.** Standalone DuckDB databases have been retired
> under [ADR 0058](../decisions/0058-public-resource-kinds.md). [File System analysis](../decisions/0010-read-only-file-analysis.md) still
> uses DuckDB. Provider-specific manual acceptance scripts and tests have been removed; a
> future restoration requires new verification before the provider can be enabled.

The Rust API uses the private deployment described in the
[Rust runtime guide](../rust-backend.md), with record metadata under [ADR 0024](../decisions/0024-fresh-record-metadata.md).

Historical status: implemented for the loopback prototype before retirement. [ADR 0008](decisions/0008-duckdb-private-storage.md)
and [GH-28](../../specs/gh-28/spec.md) define the accepted isolation and acceptance boundary.

## Customer experience

Choose DuckDB when creating a database. The API creates one public database in AWS Singapore,
with its own Tables and SQL Editor. Use `queries:execute` and that database's resource grant;
the same Workspace Key can separately permit MySQL and standalone Files. Creating DuckDB
requires the existing `resources:write` action and workspace-wide resource grant.

DuckDB is a native persistent database through tidbfs **native database mode**, not a set of
selected source files. The service loads the extension, attaches
`tidbfs+db:///workspace.duckdb` as `workspace`, and makes that catalog current. Tables, views,
SQL execution, WAL and checkpoints use DuckDB's own engine. Customers use normal DuckDB SQL
such as `CREATE TABLE`, `INSERT`, `SELECT` and `CHECKPOINT`; they do not configure storage
secrets or attach the backing file themselves. See the plugin's
[native database guide](https://github.com/drive9-ai/duckdb/blob/main/docs/native-database.md).

The Console uses the same resource selector, Tables, SQL Editor and results layout as the
other databases. Following the owner correction in [GH-50](https://github.com/siddontang/tidb.ai/issues/50),
it does not show the custom File sources picker/counter or send snapshot sources with editor
queries. File System Analyze and the separate query-source API described below are optional
file-analysis capabilities; neither defines DuckDB storage or is needed for database SQL.

The backend creates a dedicated anonymous File System and keeps the binding private. The
backing store is absent from resource lists, File System pages, Key targets, usage and events.
File APIs cannot address it, even with a wildcard key. Customers cannot supply/select a
backing filesystem or discover its native credential. Existing standalone File Systems retain
their own resource permissions. Native database and WAL files must not be edited through a
public file interface.

## Operator runtime setup

For the optional API for CSV, JSON and Parquet in public File Systems, see
[Workspace file sources](#workspace-file-sources).

The native Rust executable statically links the pinned official DuckDB 2.0.0 prebuilt libraries, avoiding a C++ source build. See [build setup](../rust-backend.md#build-check-and-package). Supply the exact matching platform/version
of the native tidbfs artifact from [drive9-ai/duckdb](https://github.com/drive9-ai/duckdb).
Its release build statically links its runtime dependencies. No Community Extensions
publication, Ti CLI, DuckDB CLI or runtime extension download is required by this product.

Configure the private regional API's `product.execute`:

```json
{
  "extensionPath": "/absolute/runtime/tidbfs.duckdb_extension",
  "extensionSha256": "verified-64-character-sha256"
}
```

Set `product.providers.filesProvider` to `drive9-anonymous` for public File System creation.
Start the reviewed native executable with its deployment plan, as in the Rust runtime guide.

The File System provider setting controls separately created public File Systems. DuckDB always uses a
separate Singapore anonymous backing store. Configure the artifact on each API host; never
accept its path/hash from an HTTP request. Capability `duckdb.available` is false without a
verified artifact; creation returns 503 before reserving/provisioning a resource. A credential-free worker probe also verifies that the artifact actually loads with this native runtime before exposing availability. The hash is
rechecked before provisioning and every worker launch. This checks operator-selected bytes;
it is not a substitute for reviewing their source/provenance. Native storage remains experimental.

The independent API package contains the native Rust executable and its build/contract
metadata, without Node dependencies. It does not bundle the operator's tidbfs artifact, state
or credentials. Keep the separately supplied artifact available at its configured path after
promotion/rollback. CI tests native SQL with temporary local databases and injected storage
provisioning; it never creates cloud resources.

## Persistence and recovery

Regional Meta stores each public database's private DuckDB binding and its backing-store
credentials as separate encrypted records, committed atomically where paired. Public records
never contain the private token, native filename or endpoint. Preserve the regional object-store
metadata and its encryption keys together; see [metadata operations](../meta-service.md). The old
sibling JSON vaults remain only in isolated regression fixtures, with no serving/import path.

Creation persists binding intent before the upstream POST. Retries with the same Idempotency-Key
reuse the public database and store. A lost provision response is never repeated automatically.
An instance whose credential was saved can resume initialization through the existing setup
endpoint. Unknown outcomes require operator reconciliation. Do not delete private bindings to
make an error disappear or create a replacement without checking the previous outcome.

A fresh child process opens the attached native database for each request, executes one
statement, closes it and returns bounded results. Subsequent requests reopen the same remote
file and WAL. One query per database and four workers per API process are admitted at a time.
No cross-request session/transaction state is offered. Native advisory locks apply; a crashed
or interrupted worker may retain a remote lock until its session expires. Do not force-release
locks or retry writes automatically. A lost response or timeout is not proof of rollback.

## SQL and security boundary

Limits: 64 KiB SQL, 15 seconds including native startup and storage open, 1,000 result rows /
1 MiB output, 256 MB configured DuckDB memory and two threads per worker. Temp spilling is
disabled. DuckDB's memory setting is not an operating-system memory limit. Confirmed database
Import has a bounded exception: server-generated CREATE/
INSERT statements receive 30 seconds each for cold storage commit/close. Parsing and ordinary
SQL keep 15 seconds, and uncertain writes are never retried; see [ADR 0023](../decisions/0023-database-import-workspace.md).

Each worker has a separate process, minimal environment and no public listener; secrets
travel in private IPC, not process arguments.

Use SELECT, table/view/index DDL, INSERT/UPDATE/DELETE/MERGE, SHOW/DESCRIBE and CHECKPOINT.
Settings, secrets, extension installation/loading, attach/detach, COPY/export/import and
cross-request transactions are not offered. The engine parses exactly one statement and blocks
unsupported categories before preparing it. External file/network access and auto extensions
are disabled, persistent/unredacted secrets are disabled and configuration is locked after
internal attachment. Return structured errors without native paths, credentials or raw SQL.

These measures preserve the current trusted loopback product boundary. DuckDB's
[security guidance](https://duckdb.org/docs/2.0/operations_manual/securing_duckdb/overview)
requires additional OS/container isolation for public untrusted-SQL hosting; this release
implements no such deployment. Native filesystem storage is experimental and is not distributed
query execution or concurrent multi-worker writing.

Table browsing reads the selected `main` schema through DuckDB information/constraint/index
functions. Identifiers use double quotes, and previews retain the existing 100-row bound.
The current Rust runtime uses disposable workers for catalog and customer SQL; it does not retain
the reusable reader described in the historical ADR 0012. Every request is authorized again and
there is no live table-result cache. A new database can return its initialization-time catalog
snapshot in its create response, labeled as such; current tables still require an authorized
read. See [ADR 0045](decisions/0045-duckdb-creation-table-snapshot.md).

A real Singapore check on 2026-10-28 measured table details at 26,434 ms before this fix.
After a cold list (5,370 ms), details took 29 ms, repeated details 16 ms and 100-row preview
300 ms. These are individual local observations, not a latency SLA. Cold attachment remains
several seconds, and ordinary customer SQL still pays that cost.

On 2026-11-03, an independent local preview compared two real, temporary DuckDB databases. Before
ADR 0045, creation took 15,011 ms and the first current-table request took 6,056 ms; the SQL
button became available 6,211 ms after creation. With the creation-time snapshot, creation took
11,193 ms and the snapshot and SQL button were ready 198 ms after creation, without a separate
table-list request. The first `SELECT 1` took 7,545 ms; the subsequent current-table request
still took 6,447 ms. A real `CREATE TABLE` followed by a refresh returned the new table. These
single observations are not a controlled benchmark or an SLA; the optimization removes a separate
initial attachment rather than making an ordinary current-table request faster. Deletion requests
for both trial databases were accepted and Guest cleanup was scheduled; physical deletion was not
confirmed by the provider during the observation window.
The editor uses TiUI SQL Editor with standard SQL highlighting; execution is DuckDB's dialect,
not MySQL or PG protocol support. Cloud usage/allowances are unmeasured (null).

## Workspace file sources

This optional snapshot API is retained for compatibility. It is separate from native database
mode and is no longer exposed in the Console database workspace. The earlier Add file source /
Query controls are historical; [GH-50](https://github.com/siddontang/tidb.ai/issues/50) supersedes
that Console presentation. Use File System **Analyze** for selected-file analysis in the Console.
CSV, JSON, JSONL/NDJSON and Parquet sources can still be joined with native database tables
through explicit API requests; every execution reads fresh snapshots.

Agents use the same query API, with **all** of `queries:execute`, `files:read`, `files:analyze`,
the DuckDB resource grant and each source File System grant. Existing Keys do not gain the
new analyze action automatically. Key administration remains owner-only. Example JSON for
`POST /workspaces/ws_agentlab/queries`:

```json
{
  "resourceId": "db_example",
  "sql": "SELECT region, SUM(amount) AS total FROM files.orders GROUP BY region",
  "sources": [{ "name": "orders", "resourceId": "fs_example", "path": "/orders.csv" }]
}
```

Source names use `[a-z][a-z0-9_]{0,31}` and must be unique. Only exact absolute Workspace paths
are accepted; no traversal, globs, external URLs, credentials or native paths. Maximum four
sources and 16 MiB combined input. Preflight sizes before fetching and enforce bounds while
streaming. Compare size, revision, ETag and file identity where supplied before/after reads;
observed replacement/growth returns a conflict. No atomic snapshot across files is promised.
Malformed, empty or unsupported files fail clearly; download originals from File System for
larger/local analysis. The existing 1 MiB anonymous gateway upload limit is unchanged.

File queries admit one native SELECT statement, with the selected database attached read-only.
The parent service downloads only authorized snapshots to owner-only temporary files; source
provider tokens never enter SQL or the native worker. Trusted setup materializes a separate
in-memory `files` catalog, then disables external access and locks settings before customer SQL.
Source tables and snapshots are disposed after every request; files are never imported into
the persistent database. Ordinary SQL without sources retains its existing read/write behavior.
See [ADR 0009](decisions/0009-duckdb-file-sources.md).

Input loading and native execution share the 15-second deadline and existing admission, memory
and output bounds. Disconnect, timeout, parse error and rejected SQL clean snapshots and workers.
Expiry/revocation is checked before reads, native execution and returning file-derived data.
No request or SQL is retried automatically. These controls retain the trusted loopback boundary;
they do not supply OS isolation for public untrusted SQL. Native remote storage remains experimental.

See [historical file query evidence](duckdb-sources-verification.md) for the former
format, permission, cleanup, real-service and browser checks. The retired database's manual
acceptance script is no longer included.

## Database verification

See [historical verification evidence](duckdb-verification.md) for requirement mappings,
live results, checked viewports and screenshots. The retired database's manual acceptance
script is no longer included.
