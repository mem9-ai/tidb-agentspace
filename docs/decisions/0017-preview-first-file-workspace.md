# 0017: Preview-first file workspace

- Status: Accepted owner direction, 2026-10-29; implementation pending.
- Contract and acceptance: [GH-76 specification](../../specs/gh-76/spec.md).
- Supersedes the top-level Preview/Analyze separation, preserving ADR 0010 and 0014–0016
  execution, method and path boundaries.

## Decision

Use one selected-file workspace with a default content/data preview and an expandable SQL
or Bash tool. Keep tools mounted when switching content/results or hiding the editor so
drafts and results survive. Source editing is a secondary explicit operation, with existing
save/discard guards. Preserve TiUI, readable typography, both themes and file/resource URLs.

Add a fixed, read-authorized CSV/Parquet schema/sample endpoint under Files. It accepts no
custom SQL and returns at most 20 rows/50 columns/128 KiB from a version-verified snapshot.
Parquet row count comes from metadata; CSV count remains unknown and types are labeled inferred.
The server owns all parsing and provider access. Custom analysis still requires analyze
permission and explicit Run. Provider credentials never enter the disposable worker.

## Consequences, compatibility and recovery

Preview shares the existing two-worker concurrency budget and 16 MiB whole-input/15-second
limits. This does not implement range reads, large-file scanning or automatic full profiling.
Over-budget/invalid files retain Download and navigation. Add a saved-byte digest to preview
and optionally to analysis results; warn when their versions differ rather than silently
comparing incompatible data. Canceling reads/execution cleans snapshots as before.

No persisted data, grant or credential migration. Legacy analyze links expand tools; old APIs
can still analyze, with a recoverable unavailable tabular preview. Rolling back code restores
the previous UI/API without changing saved files. Verify the specification's worker/HTTP
negative cases and browser workflows before declaring implementation complete.
