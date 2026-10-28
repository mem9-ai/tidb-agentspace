# Unified database workspace verification

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
