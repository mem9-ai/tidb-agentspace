# ADR 0005: Starter SQL through the Workspace gateway

- Status: Implementation complete for internal binding and SQL execution; real-cloud verification pending.
- Date: 2026-10-28.
- Scope: MySQL/PG data-plane connections, credential isolation, query limits, and public results.

## Decision and verified sources

The owner requested real MySQL-compatible and PostgreSQL-compatible TiDB Cloud Starter SQL
behind the existing Workspace Key. Keep separate resources and native connections; never send
provider management keys or native passwords to browsers or agents.

Official references checked on 2026-10-28:

- [PostgreSQL Starter quickstart](https://docs.pingcap.com/tidbcloud/pg-quickstart/): PG wire protocol,
  console creation, and public-preview quotas. This does not establish a PG provisioning API.
- [Starter CLI](https://docs.pingcap.com/ai/ti-starter-database/): Starter management and SQL roles.
  The locally inspected CLI's create command is MySQL-only. Do not invent a protocol flag.
- [TiDB Cloud Zero](https://zero.tidbcloud.com/): anonymous, temporary MySQL databases, up to
  30 days. Zero is not silently substituted for a persistent Starter or a PG resource.
- [mysql2](https://sidorares.github.io/node-mysql2/docs/documentation) 3.24.6 and
  [node-postgres](https://node-postgres.com/apis/client) 8.23.1 provide native connections.
  The installed mysql2 TLS implementation requires explicit `verifyIdentity: true` in addition
  to `rejectUnauthorized: true` to check the server hostname. Both are enforced here.

## Binding and credential boundary

`tidb-cloud-starter` marks an explicitly bound database. Existing resources stay demos until an
operator binds them. The customer API cannot submit connection addresses, provider tokens,
passwords, TLS options, or provider selections. New Console database creation still creates a
demo: automated cloud creation is not implemented or implied by SQL execution support.

An operator verifies the upstream instance is Starter, belongs to this Workspace integration,
and has the intended region/protocol. Use separate instances for separate Workspace resources,
and a native role limited to the Workspace's database/schema. Never bind a general admin/root
role or a role with access to another Workspace's data. PG role membership, schema access and
extension privileges must be reviewed by the operator; the initial privilege check does not
prove every possible cross-database/extension permission is safe.

Stop the local server and run `scripts/bind-starter.mjs` with an existing resource ID and a
private connection JSON file. It checks a TLS connection and basic role restrictions before
persisting the binding. MySQL grants must be limited to the selected database (plus global
USAGE), without GRANT OPTION. PG rejects membership in superuser, role/database creation,
replication, or RLS-bypass roles. Keep provider management credentials separate from SQL roles.

For the default state file, run this from the repository with the local server stopped:

```sh
chmod 600 /private/path/starter-connection.json
node scripts/bind-starter.mjs .data/workspace.json db_memory /private/path/starter-connection.json
```

Use the PG resource ID and its separate connection file for PostgreSQL. Take a private state
backup first. Region/kind must match the chosen resource; do not relabel an instance to fit a
configuration. Restore public metadata to its prior demo provider to roll back the binding;
that does not delete any cloud data. Avoid concurrent state editors.

The connection file has `kind`, `region`, `host`, `port`, `user`, `password`, and `database`.
Only `*.tidbcloud.com` hosts and validated explicit fields are accepted; connection URLs,
client-supplied destinations, plaintext connections, and TLS overrides are not accepted.
Native credentials are stored in `.data/workspace.json.databases.json` (0600), separately from
public metadata and the Drive9 vault. Missing, mismatched or readable-by-others bindings fail
closed; a live resource never falls back to demo results. This is local private storage, not
production secret management. Credentials and local state are excluded from Git and artifacts.

## Public execution contract

Existing `POST /workspaces/{id}/queries` retains Workspace Key authentication and action/resource
checks before provider I/O. `queries:execute` permits reads and writes within the bound native
role. It is not a read-only permission. Revoked/expired/wrong-resource keys cannot open a
connection. Console owners use the existing local HttpOnly session.

Each request uses a new verified TLS connection and closes it after completion, failure,
client disconnect, deadline, or result-limit failure. Connections and transaction state are not
shared between requests. Run one statement per request. MySQL disables multiple statements and
local-file loading; PG uses extended protocol to reject multiple statements. Multi-result
procedures are unsupported. Multi-request transactions and interactive sessions are not offered.

Limits: SQL 64 KiB, four concurrent requests per gateway process, 15 seconds total connection /
execution time, 1,000 result rows and 1 MiB serialized columns/rows. The row/byte limit bounds
retained output; an individual protocol row still has to be decoded by the native driver.
The gateway closes the connection on overflow. PG additionally requests a server statement
and lock timeout. Connection close does not prove a write rolled back. Timeout, disconnect,
result overflow, or lost responses may have an unknown write outcome; do not automatically
retry SQL. Inspect the database first. Query activity is recorded without SQL text or results.

Results keep `columns`, `rows`, `rowCount`, `durationMs`, and `mode` (`demo` or `live`). Live
statements add `affectedRows`; DDL/DML without a rowset returns no columns/rows. Duplicate column
names receive stable suffixes so values are not overwritten. PG values and MySQL bigint/decimal
values retain text precision; MySQL binary values use base64. NULL stays JSON null. Raw native
error messages, SQL snippets, passwords, and connection details are not forwarded.

Cloud RU/storage/billing remain unmeasured, represented as null rather than fabricated zeros.
The runtime artifact includes the pinned SQL drivers and their installed dependency closure,
so the packaged backend can load both drivers without a network install.

## Validation and remaining work

CI uses fake connections/transports with temporary private state. It verifies authorization,
restart persistence, no demo fallback, role checks, secret-safe errors, TLS options, fresh
sessions, limits, cancellation, results, and runtime packaging. UI evidence is in
[Starter SQL verification](../starter-sql-verification.md), explicitly labeled as fixtures.

Real MySQL and PG Starter create/insert/select/update/delete verification, role isolation probes,
and a single Workspace Key across both protocols are required before calling this integration
validated, merging its PR, or replacing the owner's local preview. The management credential
available during implementation returned HTTP 401; no live database was provisioned or rebound.
Revisit provisioning, quotas, native role setup, distributed admission control, secret encryption,
and query cancellation before any public/multi-tenant deployment.
