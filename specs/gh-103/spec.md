# GH-103: Import files from a database workspace

- Parent: [GH-103](https://github.com/siddontang/tidb.ai/issues/103).
- Status: Owner-approved product direction; contract proposed for design-PR acceptance.
- Baseline: `cd4e9a88ab0837cf93616f2a5d184e9f92e45d49` (includes GH-99 upload feedback and GH-100 metadata changes).
- Maintainer/intent contributor: Siddon Tang. Implementation follows current local-agent/DCO/CI authority.
- Decision: [ADR 0023](../../docs/decisions/0023-database-import-workspace.md).

## Outcome and scope

MySQL, db9 PostgreSQL and DuckDB workspaces expose one Import action. A developer or agent
can review a CSV/Parquet file and explicitly create a new table. Sources are a local upload
or a file in a public Workspace File System. Local imports do not require a customer File
System and never publish temporary uploads or DuckDB backing storage as resources.

Reuse existing bounded parsing, field conversion and dialect-safe CREATE/INSERT operations.
No append, overwrite, whole-database migration, arbitrary URL/connection, bulk job, resumable
upload or new provider is included. PostgreSQL remains opt-in; unavailable resources cannot import.

## HTTP contract

All routes are under `/api/v1/workspaces/{workspaceId}`. Browser owners use the existing
loopback session; agents use one scoped Workspace Key. Unknown body/option fields reject.

| Route                                   | Input                                                                                                                               | Result                                                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /database-imports/prepare`        | JSON `{resourceId, source:{resourceId,path}, parsing}`; source is a public File System                                              | Existing preparation response shape: private preparationId, expiresAt, fields, at most 20 sample rows, exact bounded rowCount, sourceVersion, inputBytes and format |
| `POST /database-imports/prepare-upload` | Raw `application/octet-stream`; query resourceId, filename, format; CSV additionally requires header (`true`/`false`) and delimiter | Same preparation response; transfer progress is separate from parsing                                                                                               |
| `POST /database-imports`                | JSON `{resourceId,preparationId,confirmed:true,table,fields}`                                                                       | Existing database export result: kind database, resourceId, table, columns and rowCount                                                                             |

CSV parsing uses the existing explicit header/separator choices. Parquet accepts only its
format. Filenames are bounded basenames, not filesystem destinations. Uploads are at most
1 MiB; File System snapshots retain the existing 16 MiB reader budget. Both paths retain
1,000 rows, 100 columns, 1 MiB parsed result, a 15-second parse deadline and two disposable
worker slots. Reject an oversized result rather than importing a sample. Existing 64 KiB
CREATE/INSERT statement budgets still apply after field/type conversion.

Preparation never mutates the database. Upload bytes live only in bounded request/worker
storage and are discarded after parsing. Private parsed rows expire after five minutes;
retain at most eight preparations per current Workspace process, pruning/evicting older ones.
Restart invalidates preparations. No new metadata migration, persistent upload object, quota,
billing calculation or provider credential exposure is introduced.

## Authorization, identity and writes

Authorize the active supported destination resource and `queries:execute` before provider or
worker I/O. File System sources additionally require that source grant, `files:read` and
`files:analyze`; local upload requires no File System grant. Deny cross-Workspace, wrong-kind,
hidden backing-storage, expired/revoked Key and unavailable resource requests before effects.

Every new preparation is bound to its principal and destination database. Commit reauthorizes
the current principal, destination and any File System source. Check a saved source digest
before writing; reject changed files. Bind target identity even if a ticket is presented through
an existing file-export endpoint. Unbound older export tickets cannot be used as database-import
tickets. Clients cannot replace server rows, change a bound database or replay a started write.

Validate field selections, names, types and the complete write plan before provider mutations.
Consume the preparation atomically before CREATE; concurrent/repeated commits do not duplicate
writes. A confirmed existing-table conflict may retain the review for a different new name.
Create one new table and insert the reviewed rows. Reauthorize before each write. Never append,
retry SQL automatically or DROP as compensation. If CREATE succeeded but INSERT/auth/audit
confirmation fails, report an incomplete or uncertain outcome and tell the caller to inspect
the target before repeating. Preserve existing export error semantics and public compatibility.

## Console behavior

Use TiUI and shared theme/modal/review components. Keep Import beside Connect in the selected
database header; disable while its database or another import/query operation is busy and
explain unavailable/demo destinations. Preserve editor drafts, completed results, table filters,
selection and URLs. Opening/preparing an import never runs the editor SQL.

Flow: source → parse/sample and field/name/type review → explicit Confirm and create table →
acknowledged outcome with Open table. Keep the destination visible and fixed to the owning
database. Source/format/parsing changes invalidate review. A local File remains selectable
for correcting parsing without permanently saving it into File System. File System selection
identifies resource/path and supports folder browsing or an explicit absolute path.

Show actual transfer progress when available, then indeterminate Parsing and Writing phases;
do not invent provider percentages. Keep errors, review and recoverable inputs. Do not present
a failed browser refresh as a failed import after an acknowledged write. Lock duplicate submit
and dismissal during writes. Maintain keyboard labels, focus return and readable narrow layouts.

## Acceptance baseline

| ID     | Required observation                                                                                                                                                                          | Evidence                                                          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| IMP-01 | Local CSV and Parquet prepare/review/commit into a new DuckDB table; exact types/values and original integers preserved                                                                       | Native Rust/Node fixtures and readback                            |
| IMP-02 | Workspace files import through all three dialects; source/target checks happen before worker/provider I/O                                                                                     | Fixture spies, SQL-plan assertions and supported live smoke tests |
| IMP-03 | Destination-only Key can import a local file, cannot read a foreign File System; missing actions, source/target grants, expired/revoked and cross-Workspace calls deny without effects        | API authorization matrix                                          |
| IMP-04 | Forged/foreign/expired/restarted tickets, changed source, changed target and legacy-endpoint bypass reject; concurrent commits write at most once                                             | Negative and race tests                                           |
| IMP-05 | Invalid/malformed/over-budget input, field/type/integer conversion and SQL-plan overflow reject before CREATE; snapshot/temp state bounded and cleaned                                        | Parser/contract tests                                             |
| IMP-06 | Existing table is preserved; partial/uncertain writes retain inspect-target guidance; no implicit SQL retry, append or DROP; post-write refresh failure retains success                       | Failure-injected provider tests                                   |
| IMP-07 | OpenAPI, typed client, Node compatibility and Rust runtime agree; Console/API remain independently buildable; no provider secrets or temporary uploads in resources/files/usage               | Contract/packaging/repository checks                              |
| IMP-08 | Import is reachable from MySQL/PG/DuckDB; source switching, parsing review, progress, busy/errors, success navigation and retained editor/results work in both themes at 1280×800 and 390×844 | Browser interactions and screenshots                              |

## Delivery and recovery

Freeze this design through a specification PR referencing, not closing, GH-103. Implementation
pins the accepted revision. Run `npm run check`, `npm run backend:check`, all latest-head CI,
diff/DCO review and browser evidence before authorized merge. Update the existing loopback
Console and Rust API through its configured deployment with reviewed binary, health check
and rollback artifact; preserve metadata authority and active customer resources.

Use isolated fixtures in ordinary CI. Live validation may use only existing authorized trial
resources and generated uniquely named new tables/files. Keep generated tables for inspection;
do not delete existing data or provision new paid resources. Rollback code does not undo data
already imported. A public production deployment and production identity remain out of scope.
