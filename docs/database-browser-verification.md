# Database browser verification

Verified on 2026-10-28 against the [DB-BROWSER specification](../specs/database-browser/spec.md)
and [ADR 0007](decisions/0007-database-browser.md). Source baseline:
`08daa919415dd063d8294786bedeecf909f6a52c`. The implementation PR identifies the evaluated head;
CI must pass again if that head changes. No new dependency or provider was introduced.

## Acceptance evidence

| Requirement | Evidence and outcome                                                                                                                                                                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB-01       | Real Zero returned `workspace_notes`, its two columns and primary index. A uniquely named verification table with spaces/backtick returned nullable/default metadata and ordered prefix/composite index parts. Empty lists, views and truncation use deterministic fixtures.                                                           |
| DB-02       | Live empty-table preview retained column names; a 101-row fixture returned exactly 100 rows and preserved BIGINT/DECIMAL strings. A single value over 1 MiB returned `422 RESULT_TOO_LARGE`, without partial results. UI clears prior content on selection changes.                                                                    |
| DB-03       | API regression tests check all three reads against missing scope, wrong resource/workspace, invalid/revoked/expired credentials, file resources and expired databases, with no provider SQL. A live discovery-only key was denied.                                                                                                     |
| DB-04       | Native acceptance covers spaces/backticks; fixtures and route tests cover Unicode, SQL-looking names, percent/hash/slash characters, invalid/control/overlong names and missing tables. Metadata is restricted to `DATABASE()` and SELECT quotes the entire identifier.                                                                |
| DB-05       | Browser: select table → Columns → Indexes → Data → Query table. The editor showed a SELECT before execution; Cmd+Enter returned the two existing real rows. Browser Back and reload preserved the database/table. Search-empty, loading, authorization error, missing-table recovery, refresh and keyboard tab switching were checked. |
| DB-06       | TiUI 2.9.1 Paper, Stack, NavLink, Tabs, Table, TextInput, Button, Alert and Loader; official SQL Editor 0.0.6. Light/dark at 1280×900 and 390×844. Computed body 16px, cells 15px, actions 48px; page width matched viewport. Keyboard horizontal scroll moves the table region on narrow screens.                                     |
| DB-07       | Full `npm run check`: runtime/repository policy, formatting, lint, generated OpenAPI/client, 74 tests, type checking and independent Console/API builds. Contract validation covers every new JSON operation. Existing SQL-route and demo-query regressions pass.                                                                      |

CI uses injected provider connections and no cloud secrets. The optional live check is:

```sh
node scripts/verify-database-browser.mjs http://127.0.0.1:4318 RESOURCE_ID
```

It reuses an existing Zero resource through the public Workspace API, creates a temporary
resource-scoped Workspace Key and a uniquely named fixture table, verifies reads/limits, then
removes that table and revokes its keys in `finally`. It never provisions an instance or reads
native credentials. Run only on an authorized temporary database; a process termination may
require operator cleanup. Both completed live runs cleaned their fixture tables and keys;
the final run passed. Existing `workspace_notes` data was not modified.

## Screenshots

- [Desktop light, columns](screenshots/database-browser/desktop-light.png)
- [Desktop dark, data](screenshots/database-browser/desktop-dark.png)
- [Mobile light, columns](screenshots/database-browser/mobile-light.png)
- [Mobile dark, columns](screenshots/database-browser/mobile-dark.png)
- [Table query executed in SQL Editor](screenshots/database-browser/editor-query.png)

## Limits and delivery

Only the connection's current database is browsed. Listing stops at 500 entries with an
explicit notice; previews are unordered samples of at most 100 rows, not pagination, exact
counts or complete exports. The existing 1 MiB result budget, 15-second per-statement timeout
and concurrency limit still apply; metadata requires several bounded statements. Concurrent
DDL can invalidate a read; refresh after the error. No snapshot consistency is promised.

SQL-capable keys still permit writes through the editor/query API. `resources:read` alone does
not permit schema/data browsing. No credential/data migration is needed. Temporary Zero expiry,
PG withdrawal and loopback-only identity remain unchanged. Build warnings from TiUI's existing
`google-libphonenumber` dependency remain; they do not fail the build. Production deployment,
read-only SQL roles and accessibility audits beyond the stated browser checks are outside scope.
