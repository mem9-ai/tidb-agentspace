# ADR 0021: Native computation in the Rust serving artifact

- Status: Implemented for the trusted loopback profile under GH-92.
- Date: 2026-10-29.
- Complements [ADR 0020](0020-modular-rust-backend.md); preserves the selected-file and
  credential boundaries of [ADR 0010](0010-read-only-file-analysis.md).

## Decision

Bundle DuckDB **2.0.0** through pinned `duckdb` **1.20000.1**, and use pinned Bashkit **0.19.0**
with default features disabled. PostgreSQL uses SQLx **0.8.6**; MySQL uses mysql_async **0.37.1** with verified TLS.
The regional Rust API never forwards queries, analysis or exports to a Node service. Node
remains a migration/build/test tool and a retained compatibility implementation for rollback.

Run computation as `workspace-backend worker` in a separate process with an empty environment,
bounded stdin/stdout, discarded stderr, a 15-second deadline and kill-on-drop cancellation.
Selected-file workers receive only a private immutable snapshot and execution parameters;
they receive no metadata token, provider credential or host shell. Two analysis slots, four
native database slots and per-database exclusion bound admission. Database workers receive
only their private database storage binding, never unrelated selected-file credentials.

Bashkit exposes the selected Workspace path, `$FILE` and the conflict-safe legacy alias in
an in-memory read-only filesystem. Disable default rootfs population, network/system
integrations and all commands outside the existing 23-command allowlist. Bound commands,
loops, recursion and intermediate/output bytes. Bash syntax/diagnostics come from this pinned
interpreter; it is not an unrestricted host Bash installation.

DuckDB workers bound memory to 128 MiB, one thread and no temporary disk spill. Materialize
selected sources before disabling external access and locking configuration for customer SQL.
Fixed preview/import readers retain source access only for server-generated queries. Validate
one statement before preparation: the Rust binding's prepare API otherwise executes prefix
statements. Check CTE read-only intent with DuckDB's parser before execution. Preserve exact
large numeric values and duplicate columns. Native databases retain the existing private
`tidbfs+db` layout; load only an ordinary extension file matching the configured SHA-256 and
prove runtime compatibility before advertising native database availability.

## Evidence and limits

Rust tests cover prefix-statement rejection without side effects, precision, persistence,
empty results, `RETURNING`, read-only CTE rejection, host-file/network exclusion and snapshot
immutability. S3 integration tests compare Node/Rust public API cases and provider recovery,
including retained credentials and Global unavailable. Live read-only canaries verify the
existing native artifact and database/file providers separately from offline fixtures.

A process deadline, virtual filesystem and DuckDB configuration are the existing local demo
boundary. They do not provide production kernel/container isolation against a compromised
native engine. Public compute needs OS/container CPU/memory/filesystem/network controls
before public hosting. The API and worker can still share one distributed executable without
sharing a process. See [the runtime guide](../rust-backend.md) for deployment and rollback.

Upstream implementation references:
[DuckDB Rust API](https://docs.rs/duckdb/1.20000.1/duckdb/) and
[Bashkit Rust API](https://docs.rs/bashkit/0.19.0/bashkit/).
