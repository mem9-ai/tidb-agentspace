# Contextual original-file and output exports

- Intent: [GH-79](https://github.com/siddontang/tidb.ai/issues/79).
- Accepted specification: [FE-01–06](../specs/gh-79/spec.md) at
  `23f97b37f797ebf351b12f0fce9a6989a7e0d62a` (design PR #80).
- Decision: [ADR 0018](decisions/0018-contextual-file-exports.md).
- Components: installed TiUI 2.9.1 Modal, NativeSelect, TextInput, Checkbox, Table, Alert,
  Button, Stack and Group; existing Workspace theme/execution/results adapters and official
  SQL Editor 0.0.6. No dependencies, palette or global typography changes.

## User flow and authority

Preview now shows one Export action in its content header, following the GH-84 owner correction.
The dialog identifies Original file and includes Download original as its computer destination.
Source drafts retain Download draft and Save changes in that header;
save/discard before copying or importing the saved original. Run selects a result view whose
header offers the same Export action for SQL results and Bash output. The source footer is absent there.
Switching preview/results/methods retains scripts and results without executing them again.
There is no separate transfer footer below the preview.

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

POST that body to `/api/v1/workspaces/{workspaceId}/file-export-preparations`. The response supplies
`id`, `status`, `createdAt`, `expiresAt`, `fields`, at most 20 sample `rows`, full bounded `rowCount`,
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

## Preview header correction (GH-84)

The owner requested the same content-panel action pattern for Preview as for results. This
small correction follows [GH-84](https://github.com/siddontang/tidb.ai/issues/84), against
`2ef2419a402c40d02dc8b236f32d9bedea5f86de`. Preview/source now reuse `WorkspaceResultPanel`
with an explicit heading and action slot; existing SQL/Bash callers retain the default Results
heading. One Export opens the existing original-file dialog. The old transfer footer and its
parent/child view-reporting callback are removed; native content-panel visibility owns the action.

Draft download/save actions are in the preview/source header. A dirty draft offers Download
draft rather than original-file copy/import. No export API, source authority, format/type
review, permission, provider or persisted-data contract changes. This supersedes only the
former top-level Download original / Export original placement in the GH-79 design.

Browser verification used a private copy of existing workspace state, additional disposable
local text fixtures and read-only access to the existing Singapore Parquet. No real cloud
resource/file/table was created or modified. Observed checks:

- Saved Preview has exactly one Export in its header, no standalone Download original and no
  transfer footer. SQL/Bash result views keep only their own Export results/Export output;
  returning to Preview restores its Export without resetting execution state.
- The existing dialog identifies Original file and offers all three destinations. Original
  download produced a valid 526-byte Parquet with its native magic bytes. Closing/downloading
  restores focus to Export. Destination controls retain format/field/type review for import.
- A local Markdown draft downloaded byte-exact edited text, blocked original export and
  retained the Keep editing guard. Saving the disposable local fixture restored Export;
  Download original then matched the saved text exactly.
- A 55-column CSV exceeded fixed-preview limits, and a 128 KiB-plus text fixture exceeded
  rendering limits. Both kept enabled Export; the failed preview opened its original-file
  download dialog. Source editing and Save changes remain available under their existing bounds.
- Light/Dark at 1280×800 and 390×844: header actions stay readable, with 22px shared headings
  and 48px buttons. Draft controls wrap within the narrow panel; wide data scrolls internally
  and document width equals viewport width. The responsive file-browser disclosure retains
  the selected preview. No dependency, global typography or palette changes.

Screenshots (narrow captures use the existing browser collapse to keep file content primary):

- [Dark Preview, 1280×800](screenshots/preview-export-header/preview-dark-1280x800.png)
- [Light Preview, 1280×800](screenshots/preview-export-header/preview-light-1280x800.png)
- [Dark Preview, 390×844](screenshots/preview-export-header/preview-dark-390x844.png)
- [Light Preview, 390×844](screenshots/preview-export-header/preview-light-390x844.png)
- [Original-file dialog](screenshots/preview-export-header/export-dialog-dark-1280x800.png)
- [Explicit draft actions](screenshots/preview-export-header/draft-light-390x844.png)

The PR records the final candidate, complete quality gate, latest-head CI and local preview
refresh. Existing API/authorization/export tests remain unchanged; this correction is checked
through browser interactions. Revisit the header pattern for additional preview modes or destinations.

## Unified entry action (GH-96)

Owner feedback identified three inconsistent entry buttons: Export results with an icon,
Export without an icon, and Export output without an icon. The scoped correction follows
[GH-96](https://github.com/siddontang/tidb.ai/issues/96), based on
`0e98bc5e0203fb828c3d554348a6d040f12e8f96`. Preview, Database/File System SQL and Bash now
reuse `WorkspaceExportButton`: Export, official IconDownload01 at 18px, TiUI large size and
the shared default variant. Dirty-draft download remains a distinct action. The existing
dialog titles and source summaries still identify Original file, SQL result or the selected
Bash stream; destinations, parsing, permissions and snapshot authority are unchanged.

Browser checks used the existing isolated export fixture, with no cloud requests or writes.
At 1280×800 and 390×844, Light and Dark, all three contexts had identical computed label,
width, height, font, weight, padding, radius, foreground/background/border and icon dimensions
within each theme. Observed buttons were 97.78125×48px, 16px text and 18×18px icons; page width
matched the viewport. Each opened the correct source dialog and returned focus to Export.
SQL/Bash output and drafts stayed unchanged when opening/closing the dialog or switching views.
An ordinary database SQL run also returned its row and opened Export results with the same
97.78125×48px action, 16px text and 18×18px icon.

Screenshots retain the running context; narrow captures use the existing file-browser collapse:

- [Preview, Dark desktop](screenshots/unified-export-action/preview-dark-1280x800.png)
- [SQL result, Light desktop](screenshots/unified-export-action/sql-light-1280x800.png)
- [SQL result, Dark narrow](screenshots/unified-export-action/sql-dark-390x844.png)
- [Bash output, Light narrow](screenshots/unified-export-action/bash-light-390x844.png)

The PR records the final quality gate and all latest-head CI checks. This presentation-only
change retains TiUI 2.9.1 and SQL Editor 0.0.6; no dependencies, API, metadata or backend runtime
are changed. Revisit the shared action when introducing additional export entry points.

The preparation URI in `Location` supports GET and DELETE. The returned `id` is the
`preparationId` foreign key used in the subsequent confirmed export. GET is a cached,
currently authorized actor-bound review, not another parse. DELETE returns 204 for an
unconsumed review; a consumed review returns 409. Five-minute expiry and process-local
restart behavior remain explicit. Historical command URLs have no compatibility aliases.
