# GH-58: Export a result snapshot

## Identity and status

- Status: Accepted by PR 59 at `f2e90079fc80757d2cf020e7647b9185da2e8e07`; implementation evidence is recorded in [verification](../../docs/result-export-verification.md).
- Parent: [GH-58](https://github.com/siddontang/tidb.ai/issues/58).
- Intent/maintainer: Siddon; specification prepared with the current local agent.
- Source baseline: `b8101fff6d49e405985292c7d0c38f135dbf9857`.
- Dependencies: shared query results, Workspace Keys, current SQL/file adapters and TiUI.
- Acceptance baseline: EX-01–09 below, frozen at the merged specification revision.
- Risk: bounded additive API and explicit data writes. Existing prototype review/merge
  authority applies; this specification grants no production deployment authority.

## Intended outcome and scope

The current Export JSON button cannot save other formats or send results to another resource.
One Export dialog in Database and File System SQL offers Download, File System and Database.
The owner selected **new tables only**, with a conflict instead of replacing an existing table.
Files likewise use conditional creation. Export the displayed rows without rerunning SQL.

Support CSV, JSON arrays and JSON Lines downloads/files, public File Systems, and active live
MySQL, PostgreSQL and DuckDB targets in this workspace. Local demo databases remain sources,
not writable targets. Do not expose DuckDB backing storage, arbitrary endpoints/credentials,
append/overwrite, source-schema cloning, whole-table export, XLSX/Parquet, or background jobs.

## Observable API contract

Add `POST /api/v1/workspaces/{workspaceId}/result-exports` with:

```json
{
  "sourceResourceId": "db_source",
  "result": { "columns": ["name", "count"], "rows": [{ "name": "agent", "count": 2 }] },
  "target": { "kind": "download", "format": "csv" }
}
```

Targets are one of:

- `download`: `format` is `csv`, `json` or `jsonl`.
- `filesystem`: `resourceId`, absolute `path`, and the same `format`.
- `database`: `resourceId` and a new `table` name.

The snapshot is client-supplied data, not server-attested provenance. The source identity is
authorization context; no source SQL/path is accepted or executed. A database source requires
`queries:execute`; a File System source requires `files:read` and `files:analyze`. Require its
resource grant on every request. A file target additionally requires `files:write` and its
grant; a database target requires `queries:execute` and its grant. Owner sessions use the same
domain operation. Recheck current key/session expiry, revocation, scopes and resource grants
before each destination write. Unknown/private resources are not valid targets.

Return JSON on success: `kind`, `rowCount`, and destination information. Downloads additionally
return `format`, `filename`, `mimeType`, UTF-8 `content` and `bytes`; files return `resourceId`,
`path`, `format`, `bytes`; database writes return `resourceId`, `table` and inferred column
types. Success is returned only after destination writes and the content-free audit complete.
An audit failure after a write explicitly reports that the write may have completed.

Validate the complete plan before provider I/O: at most 1,000 rows, 100 unique columns,
1 MiB request JSON, JSON-safe cells, consistent row keys, and bounded nesting (16 levels).
Downloads have a 4 MiB output ceiling. Files obey 256 KiB local and 1 MiB live gateway limits,
plus negotiated live-provider limits. Database generated CREATE and INSERT statements each
remain within 64 KiB, and each uses the existing 15-second query budget. Exceeding a known
limit causes a structured error before creating a table/file; no silent truncation/chunking.

### Formats and types

JSON/JSON Lines preserve the returned JSON values and column order. CSV uses a header,
CRLF records, double-quote escaping, empty cells for null and JSON strings for nested cells.
Spreadsheet-formula-like strings are prefixed with an apostrophe; the dialog describes this
CSV behavior. JSON formats preserve exact strings when this presentation conversion is unwanted.

For database exports, quote identifiers for the target dialect and encode text independently
of SQL escaping modes. Reject duplicate case-folded names, control characters and identifiers
longer than 63 UTF-8 bytes. Infer BOOLEAN, BIGINT for safe integer numbers, DOUBLE for other
finite numbers, and TEXT for strings/mixed/nested/all-null columns. Preserve precision-bearing
strings as text; serialize nested values as JSON text. No source keys, defaults or indexes are
copied. MySQL uses its compatible boolean/text/double definitions. Reject values that cannot
be represented losslessly, including nonfinite numbers, malformed Unicode and NUL text.

### Writes, conflicts and recovery

Files are created conditionally at the provider/store boundary; existing files and directories
are untouched. A missing parent is a structured failure. There is no implicit retry.

Databases receive a plain CREATE TABLE followed, for nonempty results, by one bounded INSERT.
Validate both statements first. Do not use IF NOT EXISTS, REPLACE, DROP, or a read-then-write
existence test. Native CREATE resolves races and reports conflicts. This also supports TiDB
without relying on CREATE TABLE AS SELECT compatibility. Empty results create the typed table.

DDL and insertion are **not an atomic transaction across all providers**. If insertion fails
after CREATE, report `EXPORT_INCOMPLETE` and the selected table name with recovery guidance:
inspect the new table before retrying. A timeout/disconnect during CREATE or INSERT may leave
an unknown write outcome; never retry automatically or drop a table to compensate. A duplicate
submission cannot append into an existing table because CREATE must succeed first. Unrelated
concurrent native SQL is outside the export operation's transaction boundary.

The API returns ordinary structured 400/401/403/404/409/413/422/429/5xx errors with request IDs.
Keep raw provider errors, SQL values, credentials and result contents out of errors/audit logs.
Audit only destination identity and counts. No new scope is granted to existing keys.

## Console behavior

Use one shared TiUI Export dialog. Show row count, destination and format; fetch permitted
targets only when needed. Label live versus demo resources accurately. Show empty/loading/error
target states and retry discovery without repeating a write. File paths and table names are
editable, and a summary precedes the explicit Download / Save file / Create table action.
Display the database type inference rule and bounded-result scope. A success view offers a
link to the saved file/table. A conflict preserves the input for correction.

While submitting, lock fields and repeated submission; prevent accidental dialog dismissal.
Restore focus on close and preserve SQL, rows, selection and source-file state. Exporting is
separate from rerunning the query or mutating the source file. Light/Dark and 1280×800/900,
390×844 use the existing readability/target standards. No new UI library is needed.

## Acceptance cases

| ID    | Scenario                                                                                                       | Required observation/evidence                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| EX-01 | Formats with null, Unicode, quotes/newlines, nested data, formula strings and precision strings                | Parsed JSON/JSONL remain equal; CSV escaping, order and documented safe-cell conversion match fixtures; no source execution                    |
| EX-02 | Missing source/destination scopes/grants, other workspace, expired/revoked key, private or unavailable targets | HTTP denial before destination I/O; reauthorization before each write; no provider secrets                                                     |
| EX-03 | Local/live file target, conflict and missing parent                                                            | One conditional creation; readback equals encoded content; conflict leaves original bytes; local persistence survives restart                  |
| EX-04 | MySQL/PostgreSQL/DuckDB new table and zero rows                                                                | Quoted CREATE plus one INSERT, matching column/value semantics; real native DuckDB readback; controlled driver tests for other dialects        |
| EX-05 | Malicious identifiers/text, duplicate names, malformed JSON, oversized request/output/SQL                      | Reject or safely encode before any side effect; no statement injection or silent value loss                                                    |
| EX-06 | Native name collision, insert failure, timeout, audit failure or interrupted request                           | Existing table untouched; no automatic retry/drop; partial/unknown outcome clearly reported; repeat cannot append                              |
| EX-07 | Database and File System SQL export                                                                            | Shared entry/dialog, all three destinations, explicit final action, success links, preserved source/result, no query rerun                     |
| EX-08 | Keyboard, busy state, errors, themes and narrow viewport                                                       | Focus return, no duplicate submit, clear correction path, legible 16px form values and 44–48px actions, no page overflow; retained screenshots |
| EX-09 | Public client, contract and packaging                                                                          | Generated API/client aligned; endpoint schema tests, full npm run check and latest-head CI green; no provider credentials required             |

## Execution, delivery and recovery

Allowed changes: focused export domain/contract tests, existing route/provider error integration,
shared Console result/export components, generated contract/client and canonical documentation.
Use the pinned runtime and temporary fixtures/native DuckDB files. Test writes against isolated
temporary state; no new cloud resource or real user-data transfer is needed for acceptance.
Record live-provider verification limits honestly. Do not add paid services or worker machinery.

Delivery: reviewed signed spec PR, then implementation pinned to that revision, all acceptance
evidence and latest-head CI, merged under current policy. Deployment is outside scope. Code
rollback removes the added route/UI; exported files/tables remain customer data and are not
automatically removed. Revisit for larger exports, type metadata, append/overwrite, transactional
imports, resumable operations, Parquet/XLSX or external destinations.

No blocking product decision remains: the owner selected new-table export. Implementation and
verification status will be recorded separately; specification acceptance is not delivery.
