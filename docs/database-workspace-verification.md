# Unified database workspace verification

The later [density correction](database-density-verification.md) compacts the header and
editor. [GH-54's inline columns](#inline-table-columns) supersede default Table details
selection: tables now disclose columns in the sidebar and keep Query results primary.
The earlier observations/screenshots below describe their stated baseline.

Owner-requested UI correction to [DB-BROWSER](../specs/database-browser/spec.md), 2026-10-28.

Reference: [TiDB Cloud SQL Editor](https://docs.pingcap.com/tidbcloud/explore-data-with-sql-editor/)
describes schema browsing within the editor and query results below it. The Workspace adopts
that organization with TiUI 2.9.1 and its existing larger-text overrides; it does not claim
Cloud query-file management or multi-statement execution.

Source base: `47c59cd` (main, including the separately reviewed discovery/design documents).
The implementation PR identifies the evaluated candidate; CI must pass on its latest head.

## Acceptance evidence

| Requirement | Verified outcome                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB-08       | Database links open the table navigator and editor together. Both `/sql?table=...` and the legacy `/tables?table=...` render the same workspace; reload retains the database/table. Columns, Indexes and Data remain available below the editor.                                                                                                                                                                                 |
| DB-09       | Typed `SELECT note FROM workspace_notes WHERE id = 2;` survived table selection, metadata inspection and list refresh. Its one-row result survived inspection/result tab switching. Query table showed Keep my query / Replace query; keeping retained the draft, replacing generated the quoted SELECT without running it. Regression tests cover untouched/blank drafts, edited drafts, cancellation and explicit replacement. |
| DB-10       | Cmd+Enter executed the typed query against existing real Zero data. Run query executed the generated SELECT and returned the two existing rows in Query results. Database-scoped mounting and existing route/API authorization regressions remain in place.                                                                                                                                                                      |
| DB-06       | TiUI 2.9.1 Paper, Stack, NavLink, Tabs, Table, TextInput, Button and shared Modal; official SQL Editor 0.0.6. Light/dark at 1280×900 and 390×844. Body/editor 16px, Run action 48px. Page width matched the viewport; keyboard scrolling moved the narrow data table internally.                                                                                                                                                 |
| DB-07       | `npm run check`: runtime/repository policy, formatting, lint, generated contract, 76 tests, strict types and independent Console/API builds. No contract, dependency or backend changes.                                                                                                                                                                                                                                         |

Loading indicators and a session authorization error were observed in the inspector. A fresh
local session restored the table reads. This preview used an isolated local state copy with
the existing backend-managed binding; no instance, key or fixture table was created. Only
read queries were issued, and the existing `workspace_notes` data was unchanged.

## Screenshots

- [Desktop dark, query results](screenshots/database-workspace/desktop-dark.png)
- [Desktop light, query results](screenshots/database-workspace/desktop-light.png)
- [Mobile light, table data](screenshots/database-workspace/mobile-light.png)
- [Mobile dark, table data](screenshots/database-workspace/mobile-dark.png)

## Limits

Drafts and results are retained while browsing tables within the mounted database workspace.
They are not saved across reloads, leaving the database page or switching databases. Table
inspection still makes bounded reads; it does not refresh automatically after SQL mutations.
Use Refresh tables / Refresh data. Existing provider, authorization, expiry and query budgets
are unchanged; see the [original browser verification](database-browser-verification.md).
No multiple query documents, cross-schema navigation or complete accessibility audit is claimed.
Existing upstream build warnings from `google-libphonenumber` remain non-failing.

## Inline table columns

Owner correction: [GH-54](https://github.com/siddontang/tidb.ai/issues/54), source base
`8c6ff66f37aff5a44bd46610f8ac190e48f5ab7d`. The implementation PR records the evaluated
candidate and final CI result. This changes presentation, not the public table/query API.

Clicking a table expands its columns beneath the row and keeps Query results active. The
current selected table can expand/collapse with click, Enter or Space. Its row-end code icon
is the explicit **Query table in SQL Editor** action: it selects that exact table, prepares
the existing dialect-safe SELECT and focuses SQL. It does not execute SQL. Edited drafts
retain Keep/Replace confirmation. Full Columns/Indexes/Data inspection remains a manually
selected secondary tab; old explicit `/tables?table=...` links still work.

The new table item and metadata hook are small feature modules. One route-local selected-table
snapshot is shared by the inline columns and full inspector. Only selected columns render;
no metadata result is persisted or cached by the backend. Keys include database identity,
exact table name, refresh revision and retry attempt. Old requests are aborted on context
changes, and new metadata reads wait while SQL, listing or row previews are busy. Browser/table
collapse and filtering retain the snapshot and SQL/results. Refresh/retry obtains a new
server-authorized read; no SQL is retried automatically.

Observed verification:

- Real db9 PostgreSQL: `agent_notes` expanded five columns in place, including bigint PK,
  nullable numeric/JSON fields, numeric default and timestamp default. The edited constant
  query and result 54 remained through expansion/collapse. Keep retained that query; Replace
  prepared `SELECT * FROM "workspace"."agent_notes" LIMIT 100;` without execution. Run query
  then returned two rows. No PostgreSQL row contents are retained in screenshots.
- Real native DuckDB: expanding `agent_metrics` during an already running query showed
  Waiting for database. The constant SELECT returned 1, then columns loaded without changing
  the result. Query table prepared `SELECT * FROM "main"."agent_metrics" LIMIT 100;` while
  the previous result remained. Explicit Run returned its three existing synthetic metric
  rows. The columns, query and completed result survived Enter/Space, filtering to no matches
  and back, whole-browser collapse and responsive changes. Refresh stayed disabled during
  active database reads/queries.
- Manual Table details immediately reused the loaded columns; its Data preview returned
  three rows. Clicking the table returned to Query results. A temporary catalog-list failure
  recovered with the existing read-only retry without losing the completed SQL result.
- An unavailable table's explicit legacy details link displayed a safe missing-table error
  and retry. Selecting the valid demo table recovered inline columns and Query results,
  with no stale columns from the prior database. Existing query-draft and route/identifier
  tests cover replacement guards and quoting.
- Light/Dark at 1280×900, 1280×800 and 390×844 were inspected. Column names remained 16px,
  attribute/type text stayed readable, the narrow list retained its 160px scroll bound,
  and document width stayed within the viewport. Buttons expose expanded/controls state,
  hidden columns leave keyboard navigation, and no buttons are nested inside other buttons.
  Sibling query controls retain 44px targets. Upstream NavLink logical-padding defaults
  initially overlapped the query/disclosure icons; explicit shared `px`/`py`/`pe` spacing
  keeps them separate without changing the compact vertical padding.

The shared gate passed 118 tests, runtime/repository policy, formatting, lint, generated
API/client alignment, strict types and independent builds. Existing native/API authorization,
isolation and persistence tests remain unchanged. No database writes, file mutations,
provider configuration, dependencies or deployment were part of this task.

- [Inline columns and SQL results, 1280×900 Dark](screenshots/table-columns/desktop-dark.jpg)
- [Inline columns and SQL results, 1280×900 Light](screenshots/table-columns/desktop-light.jpg)
- [Compact desktop, 1280×800 Dark](screenshots/table-columns/desktop-dark-800.jpg)
- [Narrow columns/SQL/results, 390×844 Dark, full page](screenshots/table-columns/mobile-dark.jpg)
- [Narrow columns/SQL/results, 390×844 Light, full page](screenshots/table-columns/mobile-light.jpg)
