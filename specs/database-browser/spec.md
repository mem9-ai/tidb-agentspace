# Database table browser

- Feature: DB-BROWSER; owner-requested interactive implementation, 2026-10-28.
- Intent contributor / accountable maintainer: Siddon Tang. Specification and implementation:
  coding agent acting for Siddon. Source baseline: `08daa919415dd063d8294786bedeecf909f6a52c`.
- Status: implementation specification for the task-scoped PR; delivery evidence is recorded
  separately. This is a manually supervised task, not an autonomous specification pilot.
- Dependencies: ADR 0006, the TiUI standard, generated API client, existing Workspace Key policy.

## Outcome and scope

A developer opens a database, chooses a table or view, reads its columns and indexes,
previews up to 100 rows, then opens an editable SELECT in that database's SQL Editor.
An agent can perform the same reads through the public API using its Workspace Key.
Use actual TiUI components with the current spacious layout, 16px text and both themes.

No schema mutations, pagination/full-table export, ER diagrams, cross-schema browsing, new
provider, new credentials or new grants are introduced. Preview is an unordered sample,
not a complete or stable paginated result. Existing SQL execution remains unchanged.

## Observable contract and invariants

Under `/workspaces/{workspaceId}/resources/{resourceId}`:

- `GET /tables`: ordered list of at most 500 table/view names and types, plus mode and
  `truncated`. No full row counts. Only the connection's current database is visible.
- `GET /table?name=...`: exact table identity, columns (type, nullability, default, key,
  extra), ordered index parts, generated SELECT and mode. Missing table returns 404.
- `GET /table/rows?name=...`: fixed `SELECT * ... LIMIT 100`, existing query-result envelope.
  Empty tables still return column names. No automatic retry or automatic SQL Editor run.
- All three require `queries:execute` plus the database resource grant (or local owner).
  Discovery-only `resources:read` does not authorize schema/data reads. Authenticate and
  authorize before provider I/O; no change to existing grants or native credentials.
- Table names are exact identifiers, including Unicode, spaces and escaped backticks;
  reject empty, over-64-character and control-character names. Never treat a name as SQL.
- Existing database readiness/expiry, verified TLS, concurrency, 15-second statement and
  1 MiB result limits apply. Read failures are explicit; stale results must not appear under
  another table. Requests are cancelled/ignored when leaving a selection. No data mutation
  or SQL/row content persistence; normal key-use metadata may update.
- Local demo exposes only the labeled `agent_events` sample. PG remains disabled.
- Routes preserve database/table identity, including reload/history. Existing SQL bookmarks
  still work. Query table prefills an editable SELECT; Run query executes it explicitly.
- Loading, empty, unavailable, expired, denied, oversized/error and retry states are visible.
  Refresh updates list/details; wide tables scroll within their panel on narrow viewports.

## Acceptance baseline

| ID    | Required observation                                                                                                             | Evidence                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| DB-01 | Live list, columns/defaults/nulls, composite index order and exact names come from the selected database; empty tables/list work | Backend fixtures and existing Zero live reads |
| DB-02 | Preview returns at most 100 rows, preserves NULL/precise values and empty columns; limits/errors do not expose stale data        | Backend tests and browser                     |
| DB-03 | Missing scope, wrong resource/workspace, revoked/expired key and file resource fail before provider SQL                          | API regression tests with call spy            |
| DB-04 | SQL-looking/quoted/Unicode names cannot inject SQL or select another schema; absent/invalid names fail clearly                   | Backend identifier and route tests            |
| DB-05 | Tables → Columns/Indexes/Data → Query table → explicit Run works; refresh/reload/history retain context                          | Browser against real Zero                     |
| DB-06 | TiUI, light/dark, 1280×900 and 390×844; readable text, keyboard controls, no page overflow                                       | Browser screenshots and measurements          |
| DB-07 | Existing SQL routes/queries, demo and independent builds remain usable; generated contract covers all reads                      | Route/contract tests and npm run check        |

## Execution, delivery and recovery

Changes are limited to database browsing, its API/client/routes/tests and shared documentation.
CI uses injected providers without credentials. Live verification reuses the existing temporary
Zero database and backend-managed binding; do not create another instance. Read existing sample
tables; any additional verification table must be uniquely named and removed after verification.
Never print credentials or commit local state. Stop a hung query at the existing timeout.

Review the diff, sign commits, run `npm run check`, verify all latest-head CI checks, merge the
focused PR under the owner's existing early-prototype authorization, then fast-forward and
restart the local preview. No public deployment. Changes are additive; rollback code without
modifying databases or private bindings. Completion evidence belongs in
`docs/database-browser-verification.md`. No unresolved product decisions block this scope.
