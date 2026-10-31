# ADR 0021: Native computation in the Rust serving artifact

- Status: Implemented under GH-92; Region-internal Execute under GH-52, canonical-only interfaces under GH-54 (2026-10-31).
- Date: 2026-10-29.
- Complements [ADR 0020](0020-modular-rust-backend.md); preserves the selected-file and
  credential boundaries of [ADR 0010](0010-read-only-file-analysis.md).

## Decision

Bundle DuckDB **2.0.0** through pinned `duckdb` **1.20000.1**, and use pinned Bashkit **0.19.0**
with default features disabled. PostgreSQL uses SQLx **0.8.6**; MySQL uses mysql_async **0.37.1** with verified TLS.
The regional Rust API never forwards queries, analysis or exports to a Node service. Node
is limited to build/operator tools and native fixtures; the old business implementation is
retired under [the native source boundary](../native-backend-retirement.md).

Expose computation as the Region-internal `Executor.execute(task)` module in `backend/execute`.
Its default exec strategy starts the same executable as `workspace-backend execute`, rather
than deploying a Worker service. It needs no listener, service role, broker or task queue.
Use one task command, `execute`, and one configuration field, `product.execute`. The owner
explicitly permits replacing pre-production interfaces instead of carrying compatibility
aliases; the initial GH-52 alias choice is superseded. Public HTTP behavior, provider
identities and stored records stay unchanged. See the current
[interface iteration policy](../standards/intent-driven-development.md#preserve-compatibility-and-recovery).
No in-process/thread strategy is added by this decision.

Run each task in a short-lived child with an empty environment, bounded stdin/stdout,
discarded stderr, a 15-second deadline and kill-on-drop cancellation. Server-generated native
import writes retain their existing 30-second cold-storage commit deadline.
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
immutability. Native S3 integration tests cover public API cases and provider recovery,
including retained credentials and Global unavailable. Live read-only canaries verify the
existing native artifact and database/file providers separately from offline fixtures.

A process deadline, virtual filesystem and DuckDB configuration are the existing local demo
boundary. They do not provide production kernel/container isolation against a compromised
native engine. Public compute needs OS/container CPU/memory/filesystem/network controls
before public hosting. The API and internal execution child share one distributed executable
without sharing a process. Native CLI tests cover the task command without a private
deployment plan or Node; lifecycle tests verify child termination on cancellation and deadline.
See [the runtime guide](../rust-backend.md#regional-execute) for execution and compatibility.

Upstream implementation references:
[DuckDB Rust API](https://docs.rs/duckdb/1.20000.1/duckdb/) and
[Bashkit Rust API](https://docs.rs/bashkit/0.19.0/bashkit/).
