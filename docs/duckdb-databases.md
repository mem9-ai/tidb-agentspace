# DuckDB databases

Status: implemented for the loopback prototype. [ADR 0008](decisions/0008-duckdb-private-storage.md)
and [GH-28](../specs/gh-28/spec.md) define the accepted isolation and acceptance boundary.

## Customer experience

Choose DuckDB when creating a database. The API creates one public database in AWS Singapore,
with its own Tables and SQL Editor. Use `queries:execute` and that database's resource grant;
the same Workspace Key can separately permit MySQL and standalone Files. Creating DuckDB
requires the existing `resources:write` action and workspace-wide resource grant.

The backend creates a dedicated anonymous File System and keeps the binding private. The
backing store is absent from resource lists, File System pages, Key targets, usage and events.
File APIs cannot address it, even with a wildcard key. Customers cannot supply/select a
backing filesystem or discover its native credential. Existing standalone File Systems retain
their own resource permissions. Native database and WAL files must not be edited through a
public file interface.

## Operator runtime setup

For CSV, JSON and Parquet in public File Systems, see [Workspace file sources](#workspace-file-sources).

Use Node/npm from the repository pins and `npm ci`. The pinned `@duckdb/node-api@2.0.0-r.1`
provides DuckDB 2.0.0. Supply the exact matching platform/version of the native tidbfs artifact
from [drive9-ai/duckdb](https://github.com/drive9-ai/duckdb). Its release build statically links
its runtime dependencies. No Community Extensions publication, Ti CLI, DuckDB CLI or runtime
extension download is required by this product.

```sh
WORKSPACE_DUCKDB_EXTENSION=/absolute/runtime/tidbfs.duckdb_extension \
WORKSPACE_DUCKDB_EXTENSION_SHA256=<verified-64-character-sha256> \
WORKSPACE_MYSQL_PROVIDER=tidb-cloud-zero \
WORKSPACE_FILES_PROVIDER=drive9-anonymous npm run dev
```

The File System flag controls separately created public File Systems. DuckDB always uses a
separate Singapore anonymous backing store. Configure the artifact on each API host; never
accept its path/hash from an HTTP request. Capability `duckdb.available` is false without a
verified artifact; creation returns 503 before reserving/provisioning a resource. A credential-free worker probe also verifies that the artifact actually loads with this native runtime before exposing availability. The hash is
rechecked before provisioning and every worker launch. This checks operator-selected bytes;
it is not a substitute for reviewing their source/provenance. Native storage remains experimental.

The independent API build bundles native Node bindings and their installed dependency closure
for the build platform, so no runtime install is needed. It does not bundle the operator's
tidbfs binary, state or credentials. Keep the separately supplied artifact available at its
configured path after promotion/rollback. CI tests native SQL with temporary local databases
and injected storage provisioning; it never creates cloud resources.

## Persistence and recovery

For state `.data/workspace.json`, private `.duckdb.json` records bind public database IDs to
opaque backing-store IDs. The sibling `.providers.json` holds upstream File System tokens;
public state never contains the binding, token, native filename or endpoint. Private files are
owner-only and ignored by Git. Back up and restore these files together without exposing them.

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
disabled. DuckDB's memory setting is not an operating-system memory limit. Each worker has a
minimal environment and no public listener; secrets travel in private IPC, not process arguments.

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
Details use one SELECT; a backend read-only reader is reused for browsing for at most 15 seconds
idle / 60 seconds total. Every request is authorized again, with no result cache. An idle reader
is released before customer SQL or switching databases; native errors/cancellation dispose it.
Customer SQL and file-source queries remain disposable. See [ADR 0012](decisions/0012-duckdb-catalog-reader.md).

A real Singapore check on 2026-10-28 measured table details at 26,434 ms before this fix.
After a cold list (5,370 ms), details took 29 ms, repeated details 16 ms and 100-row preview
300 ms. These are individual local observations, not a latency SLA. Cold attachment remains
several seconds, and ordinary customer SQL still pays that cost.
The editor uses TiUI SQL Editor with standard SQL highlighting; execution is DuckDB's dialect,
not MySQL or PG protocol support. Cloud usage/allowances are unmeasured (null).

## Workspace file sources

In the DuckDB workspace, choose **Add file source**, select a File System and file, and give
it a unique table name. Browse folders or enter a directory. CSV, JSON, JSONL/NDJSON and Parquet
are supported. **Query orders** prepares `SELECT * FROM files."orders" LIMIT 100;`; it does
not run it. Existing edited SQL requires a replace/keep choice. Add multiple named sources
to join them and existing database tables. Removing/changing sources clears prior results.
Source selections stay in this page's memory; every execution reads fresh snapshots.

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

See [file query evidence](duckdb-sources-verification.md) for format/permission/cleanup tests and
real-service/browser checks. Run explicit task-owned acceptance with:

```sh
node scripts/verify-duckdb-sources.mjs http://127.0.0.1:4318 DUCKDB_ID FILESYSTEM_ID
```

It uploads synthetic CSV/JSON/NDJSON/Parquet to a new task directory, verifies real queries and
Key denials, revokes verification keys and retains examples. To reconcile/recheck an existing
sample directory, pass its exact `/duckdb-query-demo-XXXXXXXX` as the fourth argument; that
mode only reads existing examples and never repeats file creation.

## Database verification

See [verification evidence](duckdb-verification.md) for requirement mappings, live results,
checked viewports and screenshots. Explicit operator acceptance can run:

```sh
node scripts/verify-duckdb.mjs http://127.0.0.1:4318 DUCKDB_ID MYSQL_ID FILESYSTEM_ID
```

The script uses only Workspace APIs, creates/revokes verification keys, removes its uniquely
named test table and retains a verification Markdown file. Use task-owned data and scoped
resources. It never reads native credentials or provisions resources. No public cloud deletion
or automatic orphan cleanup is introduced by this feature.
