# db9 PostgreSQL verification

Implementation of [GH-40](../specs/gh-40/spec.md), accepted at
`309637b13308bb61a14efbac3b2a979e9359847e`. The implementation PR pins the evaluated candidate
and current CI results. [ADR 0011](decisions/0011-db9-postgres.md) and
[the runtime guide](db9-postgres.md) own provider/credential and compatibility rules.

## Evaluated behavior

On 2026-10-28 one anonymous db9 account and one free database were created through the
Workspace API. The sample resource is `db9-playground`; `workspace.agent_notes` contains two
sample rows and is retained for the local preview. No paid tier or additional account was used.
The provider instance, account credentials and native role password are private local state,
excluded from this record and Git. The temporary verification Workspace Key was revoked.

| Requirement | Completed evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PG-01       | `server/db9.test.mjs`: concurrent idempotency, restart and readiness fixtures. Live API created the one instance, then the generated application role created/inserted the sample table.                                                                                                                                                                                                                                                                                           |
| PG-02       | Provider tests: uncertain create recovers by exact saved name, no replacement POST; incomplete setup retries the same instance; account refresh keeps identity; unsafe permissions, destinations, roles and schema ownership fail closed.                                                                                                                                                                                                                                          |
| PG-03       | API spies cover missing action, resource/workspace mismatch, expiry, revocation and retired PG before provider access. Live one-Key PG+Drive9 read passed, another MySQL resource was denied, filtered discovery contained only the selected resources, and revoked access returned 401.                                                                                                                                                                                           |
| PG-04       | `server/postgres-driver.test.mjs`: verified TLS configuration, extended single-statement protocol, cleanup, cancellation/timeouts, exact text values, empty/duplicate columns and byte/row bounds. Live queries preserved bigint `9007199254740993` and a 28-digit numeric; UPDATE reported one affected row; multiple statements, >1 MiB and 1,001 rows were rejected. Privileged role flags were false, `SET ROLE admin` was denied, and the application role owned `workspace`. |
| PG-05       | `server/postgres-browser.test.mjs`: escaped exact names, ordered composite indexes, missing tables and metadata limits. Live list/columns/primary index/100-row preview returned the sample table and its five columns.                                                                                                                                                                                                                                                            |
| PG-06       | Browser: db9 creation option and automatic region, real table Columns/Indexes/Data, explicit Run and keyboard Run, keep/replace edited SQL, PostgreSQL quoting, provider Details and PG+Files resource selection. Screenshots below. Creation in the browser was inspected then canceled to avoid a second database; actual creation used the same public service operation through the API.                                                                                       |
| PG-07       | `npm run check` validates generated contract/client, regression suite, types, Console/API builds and packaged PG runtime. CI runs without cloud credentials; the implementation PR records the evaluated head and latest results.                                                                                                                                                                                                                                                  |

## UI evidence

TiUI **2.9.1**, official SQL Editor **0.0.6** and its PostgreSQL dialect remain installed;
shared Workspace theme/adapter overrides are unchanged. No new component migration gap is
introduced. Browser computed body and SQL editor text are **16px**. Desktop 1280×900 and narrow
390×844 were checked in Light and Dark; page width equaled viewport width. The two-column sample
query's complete result panel ended at y=820 on desktop. Wider multi-column results scroll inside
their data region; narrow layouts stack tables/editor/results and use vertical page scrolling.

| View                    | Screenshot                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Desktop Dark, 1280×900  | [Live query](screenshots/db9/desktop-dark-1280.png)                                                                                 |
| Desktop Light, 1280×900 | [Live query](screenshots/db9/desktop-light-1280.png)                                                                                |
| Narrow Dark, 390×844    | [Full page](screenshots/db9/mobile-dark-390.png)                                                                                    |
| Narrow Light, 390×844   | [Full page](screenshots/db9/mobile-light-390.png)                                                                                   |
| PostgreSQL creation     | [Provider option and free-tier explanation](screenshots/db9/create-postgresql.png)                                                  |
| Workspace Key selection | [Selected PostgreSQL and File System](screenshots/db9/key-resource-picker.png), [SQL/read actions](screenshots/db9/key-actions.png) |
| Connection instructions | [Gateway examples and private credential boundary](screenshots/db9/connect-postgresql.png)                                          |

## Compatibility and limits

This is **db9 PostgreSQL compatibility**, separate from TiDB Cloud PG Starter. Official
[db9 data types](https://db9.ai/docs/sql/data-types/) limit NUMERIC to approximately **28–29
significant digits**. A live 30-digit input lost its last digit upstream; the gateway preserves
returned native text but cannot restore it. Details and the runtime guide state this limitation.
Expression index positions without column identities use explicit `Expression N` labels.
Cross-schema browsing, full PostgreSQL semantics, production identity/secret storage and provider
storage/billing telemetry are not implemented or claimed.
