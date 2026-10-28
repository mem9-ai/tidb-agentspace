# Result snapshot export: implementation and verification

Implemented against [GH-58](../specs/gh-58/spec.md) as accepted in PR 59 at
`f2e90079fc80757d2cf020e7647b9185da2e8e07`. [ADR 0013](decisions/0013-result-snapshot-exports.md)
defines the authorization and create-only boundary. No production deployment is implied.

## Behavior and API

Database SQL and File System SQL share Export in the result header. Download and File System
offer CSV, JSON arrays and JSON Lines. Database offers active live MySQL, PostgreSQL and DuckDB
resources in the current workspace and creates a new table. Demo databases cannot be targets.
Export operates on the displayed snapshot; it never reruns the query or clones source schema.
The browser refreshes after saving, with filters/drafts/results retained, and success links
open the saved object. The same public operation is available to agents:

```http
POST /api/v1/workspaces/ws_agentlab/result-exports
Authorization: Bearer <workspace-key>
Content-Type: application/json

{
  "sourceResourceId": "<source-resource-id>",
  "result": { "columns": ["region", "total"], "rows": [{ "region": "APAC", "total": 30 }] },
  "target": { "kind": "download", "format": "csv" }
}
```

Replace target with `{ "kind": "filesystem", "resourceId": "<file-system-id>",
"path": "/outputs/results.jsonl", "format": "jsonl" }` or
`{ "kind": "database", "resourceId": "<database-id>", "table": "query_results" }`.
Use an existing parent folder. Downloads return filename, MIME type, content, byte and row
counts. Saved outputs return destination identity and counts; tables include inferred types.
See the generated OpenAPI contract for the exact union and structured errors/request IDs.

Both source and destination require resource grants. Database sources require queries:execute;
file sources require files:read and files:analyze. File targets additionally require files:write;
database targets require queries:execute. Current key/session expiry and revocation are checked
before each destination write. The client-supplied source ID is authorization context, not
attested lineage. DuckDB private backing storage and provider credentials remain internal.

Limits: 1 MiB request, 1,000 rows, 100 columns, 16 nesting levels; encoded downloads up to 4 MiB;
local files 256 KiB and live files at most 1 MiB plus provider-negotiated limits. Database CREATE
and INSERT each fit the existing 64 KiB / 15-second statement budgets. Both are preflighted
before any table is created. Files and tables are created conditionally, never overwritten.

JSON formats preserve values, precision-bearing strings and explicit column order. CSV uses
CRLF records, quote escaping, empty nulls, nested JSON text and an apostrophe before formula-like
strings; the dialog explains this conversion. Database inference uses boolean, safe integer,
double and text types. Nested/mixed/string/all-null values use text; keys/indexes are not copied.
Identifiers are quoted and text is UTF-8 hex encoded for each dialect. Invalid Unicode, NUL
database text, duplicate case-folded column names and identifiers over 63 UTF-8 bytes are rejected.

CREATE plus one INSERT is not atomic across providers. `EXPORT_INCOMPLETE` means inspect the
created table before retrying; it may be empty or contain the rows. Uncertain writes are never
retried automatically, and no compensating DROP occurs. A post-write audit failure explicitly
reports completed data with a missing activity record. Audit records omit result contents.

## Evidence, 2026-10-28

| Acceptance | Completed evidence                                                                                                                                                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EX-01      | Serialization tests cover nulls, Unicode, embedded quotes/newlines, nested JSON, formula strings, precision strings, numeric-key ordering and zero rows. Browser-downloaded CSV/JSON/JSONL match both displayed sample rows.                                                                  |
| EX-02      | API tests deny missing source/target actions or grants, wrong workspace, expired/revoked keys and hidden storage before I/O. Revoking during live status prevents PUT; revoking after CREATE prevents INSERT.                                                                                 |
| EX-03      | Local/live fixture writes read back exactly; file/directory conflicts and missing parents fail without replacement; local files survive service restart; negotiated limits block PUT.                                                                                                         |
| EX-04      | Native DuckDB readback verifies values/types and hostile names; zero rows create only a table. Controlled MySQL/PostgreSQL adapters receive quoted CREATE plus one encoded INSERT.                                                                                                            |
| EX-05      | Invalid JSON values, malformed Unicode, inconsistent/duplicate columns, nesting/count/request/file/SQL limits and NUL text fail before effects. Native hostile identifiers/text cannot drop an existing table.                                                                                |
| EX-06      | Native collisions, insert failure, uncertain CREATE, revocation, abort after CREATE and post-write audit failure preserve explicit outcomes without retries/DROP.                                                                                                                             |
| EX-07      | Browser verified Database and File System entry points, all three destinations, downloads, saved file preview, native table readback, success links, unchanged SQL/results/source files and current-database list refresh.                                                                    |
| EX-08      | Light/Dark at 1280×800/900 and 390×844. Measured 16px form text, 48px inputs/actions, 44px close button and no horizontal page overflow. Busy fields/actions/dismissal are locked; Escape afterward restores Export focus without closing file preview. Conflict retains name for correction. |
| EX-09      | Generated schema/client checks, all destination response variants in contract tests, API packaging, lint/types/build and full `npm run check` pass (126 tests). Latest-head remote CI is recorded on the implementation PR.                                                                   |

Sources: `server/result-exports.test.mjs`, `server/contract.test.mjs`, isolated
`server/test-support/export-fixture.mjs`, and actual Console browser interactions. Fixtures use
temporary local state and native DuckDB. MySQL/PostgreSQL and live Drive9 transports are controlled
fixtures; this is not a claim of testing export writes against hosted services or the live
tidbfs extension. Existing adapters retain their separately documented integration boundaries.

| Screenshot                                                                            | Viewport                           |
| ------------------------------------------------------------------------------------- | ---------------------------------- |
| [Database download, dark](screenshots/result-exports/database-download-dark-1280.png) | 1280×800                           |
| [New table, dark](screenshots/result-exports/database-target-dark-1280.png)           | 1280×800                           |
| [File SQL download, light](screenshots/result-exports/file-download-light-1280.png)   | 1280×900                           |
| [File target, light](screenshots/result-exports/file-target-light-390.png)            | 390×844                            |
| [Table conflict, dark](screenshots/result-exports/database-conflict-dark-390.png)     | 390×844, dialog scrolls vertically |
| [File SQL to database, dark](screenshots/result-exports/file-database-dark-390.png)   | 390×844                            |
| [Saved CSV preview, dark](screenshots/result-exports/saved-file-dark-390.png)         | 390×844                            |

No credentials, new dependencies or migrations are required. Removing the feature does not
delete exported customer files/tables. Larger transfers, append/overwrite, external databases,
Parquet/XLSX, schema cloning and resumable jobs remain outside this implementation.
