# ADR 0008: DuckDB owns a private File System

- Status: Accepted owner direction, 2026-10-28; implementation complete; verification is recorded in [DuckDB evidence](../duckdb-verification.md).
- Intent/specification: [GH-28](../../specs/gh-28/spec.md).

## Decision

Expose DuckDB as a database resource. Automatically provision a dedicated anonymous Singapore
File System and keep its identity/credential exclusively in a private backend binding keyed by
the database ID. Do not create a public filesystem resource. Public grants, file operations,
usage and discovery operate on customer-visible resources only. No client can select a public
filesystem as DuckDB storage. This avoids accidental access to native database/WAL files and
keeps database and standalone file permissions independent.

Use [drive9-ai/duckdb](https://github.com/drive9-ai/duckdb), inspected at source
`797d2c6250592d2b84716ebf43198b39bdfd3241`. Its experimental native
`tidbfs+db:///workspace.duckdb` mode persists database/WAL using existing extent/session/advisory
lock APIs. SQL executes in DuckDB, not in the filesystem server. A bounded local probe loaded
the extension with DuckDB's official Node API, created a private Singapore trial, wrote/read a
row and checkpointed successfully on 2026-10-28. That probe does not establish complete product
acceptance. No Community Extensions publication or monitoring is part of this work.

Pin `@duckdb/node-api` 2.0.0-r.1 and require an exact-version/platform tidbfs binary with an
operator-pinned SHA-256. Load only that verified artifact during backend worker initialization.
Use the direct APIs/native runtime per the [integration policy](../architecture.md#tidb-cloud-integration-policy).
No CLI or runtime extension download is needed. Unconfigured DuckDB creation reports unavailable
before any external effect; existing bound resources never return demo SQL.

A fresh separate process opens the selected native database for each customer query, with bounded
memory/results and a deadline. Reject concurrent requests to the same database, serialize
provider setup and close workers explicitly. Disable external access and automatic extensions,
lock configuration and restrict statement categories before customer SQL. DuckDB's hardening
settings supplement the loopback trust boundary; public hosting requires OS/container isolation.
Server-generated catalog reads use the bounded read-only exception in [ADR 0011](0011-duckdb-catalog-reader.md).
See [DuckDB security](https://duckdb.org/docs/2.0/operations_manual/securing_duckdb/overview)
and [native storage limits](https://github.com/drive9-ai/duckdb/blob/main/docs/native-database.md).

## Persistence, failure and compatibility

Store binding intent before provisioning. A timeout or lost creation response never triggers
a new tenant automatically. Resume known partial initialization on the same filesystem. Keep
credentials/private paths out of HTTP errors, events, exports and child process arguments.
Timeout/disconnect can leave committed data or remote locks pending expiry; never retry SQL
blindly. Checkpoint/close and reopen verify persistence, with no guarantee of concurrent writers
across processes or HA takeover. Storage usage/billing remain null and native storage is labeled
experimental. Existing MySQL and standalone Files resources/grants are preserved.

The existing query/table contract gains a DuckDB dialect and `duckdb` resource type. Retain
backend action/resource enforcement and generated clients. Validation and rollback follow the
spec's acceptance cases; tests use temporary local data or injected providers, never cloud
credentials. A rollback keeps private bindings and data intact. Public deletion is not introduced.
