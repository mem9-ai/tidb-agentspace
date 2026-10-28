# 0014: Separate file format from supported analysis engines

- Status: Accepted owner correction for the loopback prototype, 2026-10-28.
- Scope: additive capability discovery and explicit CSV analysis-method selection.
- Baseline and acceptance: [GH-65](https://github.com/siddontang/tidb.ai/issues/65), source
  `c599211b8be2035e4c55960d68844a2318ad065a`. This corrects the exclusive format-to-engine
  mapping in [ADR 0010](0010-read-only-file-analysis.md); its isolation and authorization
  decisions remain in effect.

## Context and decision

CSV has two useful interpretations: parsed rows/columns for SQL, and raw UTF-8 text for
text commands. A filename extension must not force one interpretation when both existing
workers support it. Separate the file format, the default engine and the supported engines.

The existing capabilities response adds required `engines`, an ordered array of
`{ engine, available, reason }` objects. CSV advertises DuckDB followed by Bash; Parquet
advertises only DuckDB; the existing recognized text types advertise only Bash. Unsupported
types return an empty array. No JSON SQL reader or other format is introduced by this change.
The existing `engine`, `available` and `reason` fields retain their original meaning as the
**default engine's** status, preserving old clients. CSV still defaults to DuckDB.

Availability is per engine. Empty CSV is unavailable for SQL but remains valid empty text
for Bash. Input-size/version limits apply to every engine. Discovery checks metadata, not
parse success or UTF-8 validity; the selected worker still validates the actual snapshot.
Malformed CSV can be inspected as text; binary or invalid UTF-8 input is rejected by Bash.

Execution still requires an explicit `engine` and exactly one `sql` or `command`. Validate
the requested engine against the format's supported set before snapshot I/O. The service
performs the same current Workspace Key checks for both engines: File System grant,
`files:read` and `files:analyze`, workspace, expiry and revocation. No SQL failure silently
falls back to Bash, and changing the Console method never starts a request.

The Console uses capability options rather than its own extension-to-engine rules. Where
multiple options exist, show **DuckDB SQL** and **Just Bash** with a short explanation:
SQL queries parsed table `file`; Bash reads raw text at the input path discovered under
[ADR 0015](0015-bash-workspace-paths.md), which supersedes the fixed-name-only mapping. Shell tools
do not implement CSV quoting or embedded-newline semantics. Keep independent in-memory
drafts, results and errors while the same file panel stays open; hide inactive views and
disable method switching during execution. File navigation/unmount still cancels work and
discards these transient views. No scripts/results are added to URLs or persistence.

## Compatibility, operations and verification

No data/credential migration, broader grant, new worker, file mount, network access or writes.
Console and API remain independently deployable: the new Console falls back to the legacy
single-engine fields when talking to an older API; an older Console uses the retained
default fields with the new API. Rollback restores the previous CSV SQL-only selection
without modifying files. Restart a running API to activate its new validation/capabilities;
updating only Console code cannot enable Bash execution for CSV.

Verify real SQL and Bash against the same quoted/multiline CSV and unchanged source, empty
CSV's individual availability, invalid engines/script fields before snapshot I/O, binary
rejection, and both engines' authorization denials. Exercise the generated OpenAPI contract,
independent API artifact, mode/draft/result/error retention, busy/cancel behavior, keyboard,
16px editors, both themes and desktop/narrow layouts. See [usage and evidence](../file-analysis-verification.md#csv-analysis-methods).
Revisit this decision before adding another engine/format, persistent sessions or multi-file
contexts; extend discovery without conflating file type, preferred interpretation and access.
