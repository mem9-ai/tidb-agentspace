# Contextual original-file and output exports

- Intent: [GH-79](https://github.com/siddontang/tidb.ai/issues/79).
- Accepted specification: [FE-01–06](../specs/gh-79/spec.md) at
  `23f97b37f797ebf351b12f0fce9a6989a7e0d62a` (design PR #80).
- Decision: [ADR 0018](decisions/0018-contextual-file-exports.md).
- Components: installed TiUI 2.9.1 Modal, NativeSelect, TextInput, Checkbox, Table, Alert,
  Button, Stack and Group; existing Workspace theme/execution/results adapters and official
  SQL Editor 0.0.6. No dependencies, palette or global typography changes.

## User flow and authority

Preview shows Download original and Export original. Source drafts retain Download draft;
save/discard before copying or importing the saved original. Run selects a result view whose
header offers Export results (SQL) or Export output (Bash). The source footer is absent there.
Switching preview/results/methods retains scripts and results without executing them again.

The export dialog identifies the original file, completed SQL result or selected stdout/stderr,
then offers computer, public Workspace File System and database destinations. Bash exports
include empty/error streams and nonzero exits. Raw copies/downloads preserve their source;
format conversion is confined to an explicit database import. A prepared download retains a
real download link if the browser defers the asynchronous attempt.

Original/Bash database imports separate Parse and review from Confirm and create table.
Choose CSV (header and separator), Parquet original, or text lines. Arbitrary Bash output
defaults to text lines. Review the parsed sample, total bounded row count, selected fields,
destination names and TEXT/BIGINT/DOUBLE/BOOLEAN types. The confirmation names source and target.
CSV begins as strings to retain leading zeros and exact integers; decimals default to TEXT.
Unquoted empty CSV cells are NULL; quoted empty strings stay empty. Invalid conversions identify
the field/row before any CREATE. DOUBLE deliberately permits approximate conversion.

The API accepts client-supplied Bash output snapshots; it does not attest execution lineage.
It never accepts a script, arbitrary reader SQL, host path or provider credential for export.
Source read/analyze and destination write grants remain server-enforced. Preparing performs
no destination writes. Confirmation uses private server rows, checks the saved-original digest,
rechecks current grants before CREATE/INSERT/PUT and consumes the review when writing starts.
An existing table/file is not replaced. An uncertain INSERT reports the possibly empty/partial
table, never retries or issues DROP. Inspect the target before preparing another import.

## API usage and bounds

Use the usual Workspace Key Bearer header and workspace prefix for these JSON operations:

```json
{
  "source": { "kind": "original", "resourceId": "fs_example", "path": "/orders.csv" },
  "parsing": { "format": "csv", "header": true, "delimiter": "," }
}
```

POST that body to `/api/v1/workspaces/{workspaceId}/file-exports/prepare`. The response supplies
`preparationId`, `expiresAt`, `fields`, at most 20 sample `rows`, full bounded `rowCount`,
`sourceVersion`, `inputBytes` and `format`. Review those fields, then POST to `/file-exports`:

```json
{
  "preparationId": "RETURNED_PREPARATION_ID",
  "confirmed": true,
  "fields": [
    { "source": "id", "name": "account_id", "type": "TEXT" },
    { "source": "amount", "name": "amount", "type": "BIGINT" }
  ],
  "target": { "kind": "database", "resourceId": "db_example", "table": "reviewed_orders" }
}
```

For exact raw output, POST to `/file-exports`:

```json
{
  "source": {
    "kind": "output",
    "resourceId": "fs_example",
    "stream": "stderr",
    "text": "ERROR upstream unavailable\n"
  },
  "target": { "kind": "filesystem", "resourceId": "fs_destination", "path": "/errors.txt" }
}
```

Download uses `target:{"kind":"download"}` for output. Original download keeps the existing
authenticated content endpoint. Original File System copy uses the original source shape and
the file target above, without parsing. Live file targets preserve binary bytes; local text-only
targets reject invalid UTF-8. Provider upload limits and existing destination SQL budgets apply.

| Operation                         | Required actions, in addition to the applicable public resource grants                   |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| Original download/copy            | `files:read`; copy also requires destination `files:write`                               |
| Prepare/import original or output | Source `files:read` and `files:analyze`; import also needs destination `queries:execute` |
| Raw output download/save          | Source `files:read` and `files:analyze`; save also needs destination `files:write`       |

Limits: original input 16 MiB, output text 1 MiB, parsed data 1,000 rows/100 columns/1 MiB,
15 seconds and the existing shared two-worker admission budget. Excess rows reject the entire
preparation; a 20-row sample is never silently imported instead of the full bounded input.
Fixed readers run in disposable credential-free workers. CSV reader options are explicit,
including quote/escape; see the [official DuckDB CSV reference](https://duckdb.org/docs/2.0/data/csv/overview).
The two new routes alone accept an 8 MiB JSON envelope for escaped output. Older route limits
remain unchanged. Reviews expire after five minutes; at most eight are retained per process,
bound to the exact session/Key. Restart invalidates reviews, not completed files/tables.
Larger imports, JSON records, append/overwrite and persistent jobs are outside this change.

## Acceptance evidence

| Requirement | Evidence                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FE-01       | Browser: preview original labels; SQL/Bash result headers have their own export and no original footer. Retained scripts/results and draft protections checked separately.                                                                                                                                                                                                                               |
| FE-02       | `server/file-exports.test.mjs`: exact stdout/stderr/empty/Unicode/control text, conditional file creation, binary live copy and local invalid-UTF-8 rejection. Browser copied CSV and Parquet and saved stdout/stderr separately.                                                                                                                                                                        |
| FE-03       | Native fixed readers: multiline/headerless/separated CSV, null/empty semantics, canonical suggestions, exact 64-bit values, Parquet schema and 25 rows versus 20-row review. Mapping, conversion, identifier and row/column/output limits reject before destination statements. Browser changed id to BOOLEAN, recovered to TEXT, renamed/deselected fields and read back `001` from real native DuckDB. |
| FE-04       | HTTP/provider spies: missing scopes/resources, foreign workspace, invalid/expired/revoked/foreign Keys, hidden storage and injected reader/script options denied before I/O. Revocation after CREATE blocks INSERT and reports its outcome without DROP. Existing SQL-export authorization tests remain applicable to the shared authorizer.                                                             |
| FE-05       | No statements on prepare; original saved-byte changes reject; single-use/replay, concurrent commit, TTL/eviction, known table conflict recovery and partial writes covered. New import-mode cancellation/admission test proves the shared preview budget is released. Existing snapshot/worker tests retain stream cancellation, deadline and cleanup coverage.                                          |
| FE-06       | Browser: original/output/SQL source labels and destination forms, file/table success navigation, native DuckDB readback, stream/format review, focus return and Light/Dark 1280×800 and 390×844. Screenshots below retain 15px sample cells and 48px inputs; no document overflow. No live customer writes are used for destination verification.                                                        |

Destination writes use `server/test-support/export-fixture.mjs`: isolated file transport and
native local DuckDB. MySQL/PostgreSQL adapters are deterministic fixtures here; their existing
dialect/provider tests remain in the quality gate. This is not a claim of a new cloud database
or cloud write integration. Existing live Singapore data can be read after local preview refresh.

Screenshots from the isolated fixture, with the dialog internally scrolled to field review:

- [Dark, 1280×800](screenshots/contextual-file-exports/original-review-dark-1280x800.png)
- [Light, 1280×800](screenshots/contextual-file-exports/original-review-light-1280x800.png)
- [Dark, 390×844](screenshots/contextual-file-exports/original-review-dark-390x844.png)
- [Light, 390×844](screenshots/contextual-file-exports/original-review-light-390x844.png)

The implementation PR records its evaluated candidate, full quality gate, remote CI and local
preview refresh. There is no persisted-data migration or production deployment. Rolling back
code does not remove exported files or tables; do not repeat an uncertain write automatically.
