# GH-26: Read-only File System analysis

- Intent contributor/accountable maintainer: Siddon Tang.
- Parent: [GH-26](https://github.com/siddontang/tidb.ai/issues/26); keep open until implementation
  and live/browser acceptance complete. This design change references it without closing it.
- Status: Proposed implementation baseline, revision 1, 2026-10-28. No analysis UI/API is shipped.
- Source baseline: `08daa919415dd063d8294786bedeecf909f6a52c`.
- Evidence: [capability discovery](../../docs/file-analysis-discovery.md).
- Scope: CSV/Parquet DuckDB queries and text/log Just Bash analysis for one selected file.
  Remote OS terminals, persistent compute sessions, file writes, package installation, paid
  sandbox provisioning, multi-file joins and unrestricted network access are outside v1.

## Intended outcome

A developer opens a file in File System and chooses its analysis action. CSV/Parquet opens a
DuckDB view with columns, a bounded sample query, SQL input and tabular results. Text/log files
open a Just Bash view with grep/head/tail/awk samples and stdout/stderr/exit status. The selected
File System and path remain visible; opening an analysis view never executes submitted code.
The same operations must be usable by agents through a documented Workspace API.

Hosted Exec is optional capability information. Current anonymous Singapore returns 404; this
must not block the two independent backend-hosted analysis engines. Just Bash cannot launch
DuckDB as an arbitrary native command. Preserve the direct-API/protocol integration policy.

## Proposed API and permission contract

These are design targets, not paths in the current OpenAPI. Implementation must define them
in the generator before clients and keep generated types, code, docs and tests aligned.

- Resource analysis capabilities report engine availability, input/output/time limits and
  unsupported reasons. Report actual backend/provider readiness; no false enabled flags.
- One execution request identifies `resourceId`, canonical absolute `path`, engine (`duckdb`
  or `bash`), and exactly one `sql` or `command`. Clients cannot submit provider destinations,
  credentials, host paths, environment variables, executable paths or runtime configuration.
- Introduce an explicit `files:analyze` action in addition to `files:read`, with the File System
  resource grant. Old read keys do not automatically gain compute permission. The local owner
  session can use the same domain operation. Analysis never grants `files:write`.
- DuckDB returns columns/rows/count/duration; Bash returns stdout/stderr/exitCode/duration.
  Nonzero shell exit status is a command result; transport/provider failures remain structured
  errors. Bound every response and clear stale results after failures or file/engine changes.
- V1 is stateless. Fetch only the selected file into a private bounded snapshot, then run in a
  disposable worker without upstream credentials, host filesystem or network access. Expose
  a read-only `file` table to SQL and `/workspace/input.log` (or a labeled format-specific alias)
  to Bash; temporary output may exist only in disposable memory. Do not imply upstream writes.
- Starting ceilings: 16 MiB input snapshot, 64 KiB query/command, 15 seconds total execution,
  1,000 result rows, 1 MiB serialized result/output, two active analyses per gateway process,
  and a 256 MiB engine memory budget. Reject over-limit input before content fetch; enforce
  limits during reads/execution too. A compressed file can expand past the memory budget.
  Provider upload limits are unchanged and may be lower. Return explicit unsupported/limit
  errors with Download available. No implicit execution retry.
- Only SELECT-style analytical SQL over the supplied snapshot is permitted. Enforce actual
  statement semantics and engine restrictions; a prefix regular expression is insufficient.
  Block external reads, extension loading, configuration changes, credential inspection and
  OS execution. Bash may read the selected snapshot and use disposable scratch space, but
  cannot read another Workspace file or write upstream. Do not rely on the UI to enforce this.
- Detect replacement/removal or a revision change while fetching; return a conflict/retry
  explanation rather than silently combining versions. Reject binary data in the log engine.
  Parquet may be analyzable even when the ordinary preview cannot render it.

## Console behavior

Keep the feature under File System rather than database navigation. A file's side panel offers
Preview and the applicable analysis action. The analysis surface may expand for editing/results,
but must keep file context and offer return navigation. Reuse actual TiUI and the official SQL
editor with verified dialect configuration, 16px text, spacious controls and Light/Dark/System.

Cover loading, empty files/results, unsupported/binary/oversized files, missing engine,
permission denial, missing/changed file, timeout/output limit, nonzero shell status and canceled
navigation. Cancel abandoned work and discard stale responses. Download remains available where
reading the original file is authorized. No native/provider password appears in the UI or API.

## Acceptance baseline

| ID    | Required observation                                                                                                                      | Implementation evidence required                            |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| FA-01 | Capability discovery correctly reports a 404/disabled hosted Exec while independent engines remain usable                                 | Provider fixtures and existing real anonymous-service probe |
| FA-02 | CSV and Parquet known aggregates agree; schema, NULL and numeric values are represented correctly                                         | Fixture queries and real file API + worker integration      |
| FA-03 | Log grep/pipeline gives expected matching lines and count; nonzero exit is distinguished from service failure                             | Actual Just Bash execution tests and real sample            |
| FA-04 | Wrong workspace/resource, missing read/analyze action, expiry and revocation cause denial before provider/engine I/O                      | Backend negative tests with I/O spies                       |
| FA-05 | Guest SQL/Bash cannot access another file, host paths, network, upstream credentials or writable provider operations                      | Adversarial engine/worker and credential-redaction tests    |
| FA-06 | Input/time/output/memory/concurrency ceilings hold, including file growth, malformed Parquet and loop-heavy commands                      | Failure injection and measured resource-limit tests         |
| FA-07 | File change/navigation cancellation does not show stale results; workers and private snapshots are cleaned up                             | Service and browser lifecycle tests; no orphan snapshots    |
| FA-08 | TiUI flows work in Light/Dark at 1280×900 and 390×844; keyboard execution works; oversized files retain Download                          | Browser evidence tied to implementation candidate           |
| FA-09 | API and Console share domain behavior; generated contract/client drift fails; independent artifacts contain the required engine code only | Contract, generation, packaging and full quality checks     |

The discovery already proves small-file remote reads/aggregates, log pipelines, read-only
adapter rejection and deployed Exec 404. It does not fulfill FA-02–09 for a production-shaped
Workspace API/Console or prove arbitrary guest confinement. Do not mark the feature complete
using discovery results alone.

## Delivery and recovery

Implement in a separate scoped PR against the accepted design revision. Add an ADR for the new
public authorization and worker boundary, following current numbering at that time. Preserve
other contributors' work and independent Console/API packaging. Pin exact native/interpreter
versions and test on CI's platform without cloud credentials; do not require Ti CLI.

Run `npm run check`, meaningful engine/authorization/limit tests and bounded live/browser
verification. Use only task-owned sample files in an authorized existing trial. Ship only after
the implementation's latest-head CI and diff/sign-off review pass. Code rollback disables the
analysis entry points and disposes workers; original remote files must remain unchanged.
No public or paid deployment is authorized by this specification.

## Remaining implementation decisions

Select and pin the DuckDB library/worker packaging and Just Bash/SDK distribution using verified
exports and compatible versions. The checked npm `drive9@0.3.0` does not export `./just-bash`,
although the checkout does; use a verified release/source build or the existing provider's
bounded snapshot path. The native extension proof is one option for future larger
remote scans, not a requirement to use an unsigned native extension in v1. Validate the snapshot
read-only implementation and engine access controls before exposing user code. Any expansion to
multi-file access, writes or remote sandbox compute needs an amended permission and acceptance
boundary. These choices must not weaken the mandatory isolation/limit cases above.
