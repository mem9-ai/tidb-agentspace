# 0010: Read-only analysis of selected File System snapshots

> **Current implementation.** The file authorization and snapshot boundaries remain current. The original JavaScript engine and worker details below were superseded by [native DuckDB and Bashkit workers](0021-native-rust-computation.md).

- Status: Accepted for the loopback prototype, 2026-10-28; implements the owner-approved
  [GH-26 baseline](https://github.com/siddontang/tidb.ai/blob/b76e1dde2a02355552fcba50cb8299ec625ebeff/specs/gh-26/spec.md).
- Context: CSV/Parquet and log analysis belong beside files. The checked Singapore anonymous
  service does not expose the probed hosted Exec routes; Just Bash is an interpreter and
  cannot launch a native DuckDB executable. See [discovery](../file-analysis-discovery.md).

## Decision

File-format and engine selection follow the additive correction in
[ADR 0014](0014-file-analysis-engine-options.md): CSV supports both SQL and raw-text Bash;
the original fields retain default-engine semantics. This does not change the execution
boundary below.

Run analysis in the Workspace API, with actual DuckDB and Just Bash in disposable child
processes. The Console uses the same public operations as agents:

- `GET /api/v1/workspaces/{workspaceId}/file-analyses/capabilities?resourceId=…&path=…`
  requires `files:read` and the selected resource grant.
- `POST /api/v1/workspaces/{workspaceId}/file-analyses` requires **both** `files:read` and
  `files:analyze`, plus the File System grant. Input contains only `resourceId`, `path`,
  `engine`, and exactly one `sql` or `command`. Authorization precedes provider I/O.

Old keys retain their permissions. The owner session shares these domain operations;
provider keys remain in the backend vault. No native credentials, executable paths,
provider URLs, environment variables or engine configuration are accepted from clients.

Fetch exactly one saved file into a private temporary snapshot. Preflight metadata size,
bound reads, use the provider ETag as `If-Match`, and compare metadata again after transfer.
Reject changing or unverifiable versions. Never retry execution automatically. Workers receive
only the selected snapshot, script and trusted limits. They inherit no API/provider credentials.
Snapshot directories are removed after the child closes, including cancellation and errors.

Pin `@duckdb/node-api@2.0.0-r.1` and `just-bash@3.6.0`. The verified published
`drive9@0.3.0` lacks the Just Bash subpath; use the existing provider adapter and snapshots.
The native `tidbfs` extension is not required for this bounded first version.

DuckDB materializes the trusted snapshot as table `file`, then disables external access and
locks configuration **before** preparing guest SQL. Require exactly one parser-classified
SELECT. No extension loading, external reads, configuration changes or writes. Return types,
file schema and exact JSON numeric representations (BIGINT values are strings).

Just Bash sees the selected absolute Workspace path in a read-only in-memory filesystem.
[ADR 0015](0015-bash-workspace-paths.md) supersedes the original fixed-name-only mapping and
defines input discovery and compatibility aliases. Use a small command
allowlist for grep/awk/sed and pipelines; keep interpreter defense guards enabled, Python and
JavaScript disabled, and network commands unavailable. Native shells and arbitrary binaries
are not exposed. Nonzero shell exit status is a normal result; service/limit failures use
structured errors. User SQL/commands and result content are not persisted in audit events.

## Limits and operational consequences

Each run allows 16 MiB input, 64 KiB script, 15 seconds total, 1,000 SQL result rows and 1 MiB
serialized response. Two runs may be active per API process. Over-limit input is rejected
before content transfer; growing streams are bounded too. Cancel disconnects/navigation,
kill the child on timeout, and wait for closure before releasing its temporary files.

Memory limits are explicit: a 128 MiB Node heap and DuckDB `memory_limit=128MB`, with no
spill directory and one native query thread. Just Bash also bounds interpreter live bytes,
strings, output, loops and command count. These are engine budgets, **not a 256 MiB OS RSS
cap**: native/process overhead is additional. A failed child does not terminate the API.
This local prototype does not supply a kernel/container security boundary for hostile public
multi-tenant workloads. Before public hosting, use an OS-isolated runner with hard aggregate
memory/CPU/process/network limits and revisit cancellation, quotas and execution billing.

Every request copies the whole selected file. Large-file streaming scans, Parquet row-group
pruning, multi-file joins, saved sessions and provider-hosted Exec remain future work.
The provider's existing upload limit is unchanged. Unsupported/oversized files keep Download.

The API artifact includes the installed native platform binding and pinned interpreter
closure; the Console artifact includes neither. Package on the deployment OS/architecture.
The scoped `guarded-fetch > undici` override pins patched `7.30.1`; network commands remain
disabled. Revalidate API compatibility, defenses and packaging when upgrading either engine.

## Migration, verification and rollback

No resource or data migration. Grant `files:analyze` explicitly on a new Workspace Key;
existing read-only keys do not acquire compute access. Analysis never writes the source.
Rollback removes the analysis routes/UI and scope without changing files or provider bindings.

See [verification](../file-analysis-verification.md) for FA-01–09, real Singapore observations,
TiUI screenshots, credential/resource negative tests, cancellation/limits and independent
artifact execution. CI uses fixtures and native engines without cloud credentials.
