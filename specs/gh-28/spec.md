# GH-28: DuckDB with private dedicated storage

- Status: Accepted owner direction; revision 1, 2026-10-28. Implementation pending.
- Intent: [#28](https://github.com/siddontang/tidb.ai/issues/28), contributor/maintainer Siddon Tang.
- Source baseline: `cee381a`; dependency: existing MySQL, Drive9, Workspace Key and table APIs.
- Decision: [ADR 0008](../../docs/decisions/0008-duckdb-private-storage.md).

## Outcome and contract

A developer selects DuckDB in Databases, names it and creates it. The backend creates a
separate Singapore anonymous File System, binds it exclusively to that DuckDB and initializes
a native database/WAL through tidbfs. The customer sees one DuckDB database, its Tables and
SQL Editor. Agents perform the same work using existing resource/query/table APIs and one
Workspace Key. Existing MySQL and standalone File Systems retain their behavior.

`POST /resources` adds `kind: duckdb`, region `aws-ap-southeast-1`. Require resources:write
and the existing workspace-wide grant. Return only the database resource, with provider
`duckdb-drive9` and provisioning/active/failed status. No filesystem ID, endpoint, token or
native path enters the public resource. Reusing Idempotency-Key returns/resumes the same
resource and binding. Persist intent before external creation; an unconfirmed response must
require recovery instead of a duplicate creation. The setup endpoint can resume a known
binding; missing runtime fails before cloud creation. Capability discovery states availability.

`queries:execute` and database resource access authorize SQL and all table reads. Existing
limits remain: one statement, 64 KiB SQL, 15 seconds including setup, 1,000 rows / 1 MiB.
Return the existing live result shape, exact large integers, safe errors and affected rows.
Support ordinary SELECT/DDL/DML and database-scoped Tables/Columns/Indexes/Data; do not offer
cross-request transactions. Reject settings/secrets/extensions, attach/detach, export/import,
COPY and host file/network access. No automatic SQL retry after uncertain writes.

## Invariants and operational boundary

- One private filesystem binding per database, never a shared public File System. It cannot
  be discovered, granted to keys, addressed by file APIs, or listed separately in usage/events.
- Persist backend-only credentials in owner-only ignored state, separate from public metadata.
- Use exact compatible DuckDB 2.0 and an operator-provided, SHA-256 checked tidbfs artifact.
  Missing/mismatched artifacts fail closed. No runtime downloads or CLI dependency.
- Execute with the native Node API in a separate bounded process; four concurrent workers
  maximum and one per database. Lock engine configuration and disable external file/network
  access, extension installation/loading and persistent/unredacted secrets after setup.
- A successful SQL response survives worker close/reopen. Cancellation/timeout kills the
  worker; remote advisory locks can take time to expire and write outcomes must be reconciled.
- Cloud storage, quotas and billing remain unmeasured. Native tidbfs is experimental; this
  loopback prototype does not claim public multi-tenant sandboxing or distributed SQL.
- Deletion, paid enrollment, HA scheduling, automatic replacement, arbitrary remote datasets,
  native external clients and community-extension submission are outside this change.

## Acceptance baseline

| ID      | Required result                                                                                                                             | Evidence to supply                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| DUCK-01 | API/Console creation yields one DuckDB and one private filesystem, never an extra public resource                                           | Provider/API tests and live Console        |
| DUCK-02 | All public discovery/bootstrap/usage/events/key/file paths conceal or deny the backing store, including wildcard keys and guessed IDs       | Negative API tests and response review     |
| DUCK-03 | Same key executes real DuckDB DDL/CRUD, MySQL and Files where granted; missing/wrong/expired/revoked grants do no provider I/O              | Authorization tests and live smoke         |
| DUCK-04 | Repeated/concurrent creation and restart reuse a binding; uncertain provision is not repeated; partial setup resumes                        | Injected failure/persistence tests         |
| DUCK-05 | Real native table data survives close/reopen on dedicated Singapore storage; table schemas/indexes/rows use DuckDB dialect                  | Native tests and bounded live verification |
| DUCK-06 | Multiple statements, host reads, network calls, secret/configuration changes, attach, extension load and oversized/slow results fail safely | Native engine regression tests             |
| DUCK-07 | CI uses no cloud credentials; independent API packages native dependencies and starts without Console; runtime configuration is documented  | Full check and extracted-artifact test     |
| DUCK-08 | TiUI creation, database pages, key targets, Light/Dark desktop 1280px and narrow 390px work with readable layout                            | Browser evidence and screenshots           |

## Delivery and recovery

Design PR references the parent. Implementation pins this accepted spec SHA and maps every
case to evidence. Run npm run check, review authorization/secret boundaries and the diff,
verify sign-offs and latest-head CI, then follow the authorized prototype merge policy.
Update the local preview only after live verification. Preserve previous resources, files and
keys. Keep private state and runtime artifacts outside Git; the supplied DuckDB repository is
read-only reference material. Limit live validation to task-owned anonymous databases and
reuse the already created probe store; never blindly repeat uncertain creation. Code rollback
preserves bindings and cannot undo committed SQL or recover expired provider data.
