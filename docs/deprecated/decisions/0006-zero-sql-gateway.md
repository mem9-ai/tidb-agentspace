# ADR 0006: Anonymous Zero SQL through the Workspace gateway

> **Deprecated.** The public Zero MySQL gateway was retired. For current database availability see [ADR 0058](../../decisions/0058-public-resource-kinds.md) and the [db9 provider](../../decisions/0011-db9-postgres.md).

- Date: 2026-10-28.
- Scope: Anonymous provisioning, credential isolation, SQL execution, expiry, and PG withdrawal.

The PG withdrawal described here is historical. [ADR 0011](../../decisions/0011-db9-postgres.md) adds opt-in
real db9 PostgreSQL while keeping retired simulated PG records inaccessible. TiDB Cloud PG
Starter remains a separate future integration.

HTTP naming in this historical decision is superseded by
[ADR 0032](../../decisions/0032-rest-workflow-resources.md): use addressable setup attempts and
`/resources/{id}/tables/{tableName}[/rows]`. Old command/singular-table URLs are removed.

## Decision and verified sources

The owner explicitly chose TiDB Cloud Zero for the first real SQL integration and asked to
remove PG if no equivalent is available. The running product offers MySQL and Files. Persistent
Starter and PG remain future integrations, not capabilities implied by the current Console.

The implementation follows the shared [TiDB Cloud integration policy](../../architecture.md#tidb-cloud-integration-policy):
direct HTTP provisioning and native MySQL execution, with no Ti CLI product dependency.

Verified on 2026-10-28:

- [TiDB Cloud Zero](https://zero.tidbcloud.com/) documents anonymous
  `POST https://zero.tidbapi.com/v1beta1/instances` with an optional tag, native MySQL credentials,
  and expiry up to 30 days. No account or management key is required. No equivalent anonymous
  PG endpoint was found. Region selection is not documented; expose `automatic`, never infer
  a promised region from the hostname. Use the response expiry, not a fabricated renewal date.
- [PG Starter quickstart](https://docs.pingcap.com/tidbcloud/pg-quickstart/) describes a separate
  PG product; it does not establish an anonymous PG Zero API.
- Installed [mysql2](https://sidorares.github.io/node-mysql2/docs/documentation) 3.24.6 needs
  both `rejectUnauthorized: true` and `verifyIdentity: true` for verified server identity.
- Live Zero requires the provider login prefix in both `CREATE USER` and the connection user;
  the complete username must fit 32 characters. Generate the suffix within that budget.
- mysql2 emits `fields: undefined` for DDL/DML completion packets. Treat these as affected-row
  results, not rowsets. TiDB's [error 8130](https://docs.pingcap.com/tidb/stable/error-codes/)
  rejects disabled multi-statements; mysql2 may expose only its numeric errno.

## Provisioning and private credentials

Opt in with `WORKSPACE_MYSQL_PROVIDER=tidb-cloud-zero`. The existing resource create API accepts
`mysql` with region `automatic`; the backend selects the provider. No API accepts native
credentials, connection URLs, TLS options, or arbitrary provider destinations. Without opt-in,
creation remains labeled local demo behavior. Existing resources are not silently rebound.

Persist a resource and creation intent before the external POST. Persist returned credentials
before SQL setup. Create a `workspace` database and generated application user with only
SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX and REFERENCES on `workspace`.*.
Verify the application login, then discard the stored admin credential. Customers query only
through the application role; there is no global, FILE, CREATE USER, or GRANT OPTION privilege.
Each Workspace resource owns a separate Zero instance.

Native bindings live in `<state-file>.databases.json`, mode 0600, separate from public metadata
and the Drive9 credential vault. Startup rejects a group/world-readable existing vault. Only
explicit supported fields and `*.tidbcloud.com` hosts are accepted. Credentials, claim URLs,
SQL text/results and raw provider errors are not returned in public metadata or audit events.
The claim capability is not exposed or persisted. Private local files are not production secret
management; public/multi-tenant deployment is unsupported.

`POST /resources/{resourceId}/setup` requires `resources:write` and the resource grant. It resumes
incomplete setup on the same saved instance, using stable credentials and idempotent setup SQL.
An uncertain creation with no saved response fails closed: never repeat its POST automatically.
Operator recovery must inspect the private state and upstream outcome before deliberately
creating another resource. Expired instances return 410 for queries; there is no replacement,
claim, upgrade, billing enrollment, or automatic renewal. Export important data before expiry.
The five-database prototype cap is local admission control, not a statement of provider quotas.

## Public SQL contract

`POST /workspaces/{id}/queries` retains Workspace Key action/resource/workspace checks before
provider I/O. `queries:execute` permits reads and writes under the native role, not read-only
SQL. Expired/revoked or incorrectly scoped keys cannot open a connection. The local Console uses
its existing HttpOnly owner session. One key can address both a permitted MySQL resource and
File System while excluding others.

Each request uses a fresh TLS connection, disabled multi-statements and local-file loading,
and closes on completion, failure, disconnect, deadline or overflow. No sessions or transaction
state span requests. Limits: SQL 64 KiB, four concurrent queries per gateway process, 15 seconds
including connection setup, 1,000 rows and 1 MiB retained serialized results. Individual protocol
rows still have to be decoded by the driver. Multi-result procedures are unsupported.

Never retry SQL automatically. Timeout, lost responses, connection close, result overflow or
activity-record failure can leave an unknown write outcome; the user must inspect it before
retrying. Native error messages are mapped to structured safe errors without SQL or passwords.
Results preserve `columns`, `rows`, `rowCount`, `durationMs`, `mode` and live `affectedRows`.
Duplicate names get stable suffixes, bigint/decimal remain precise strings, binary is base64,
and NULL stays null. DDL/DML without a rowset returns empty columns/rows and an affected count.
Cloud usage and billing are unmeasured (null), not fabricated zeros. The packaged backend
includes mysql2 and its pinned dependency closure for offline runtime startup.

## Migration, rollback and evidence

PG is removed from creation, discovery, UI choices, capability snapshots, new resource grants,
and query execution. Existing PG records, events and key grants remain on disk; no cloud data
is deleted. The server filters retired resources and denies their access. This intentional API
narrowing is acceptable in the early prototype; restore a real PG adapter and acceptance tests
before advertising it again. Disabling Zero creation does not erase or relabel existing trials.
Back up private/public state before a rollback and preserve bindings; reverting code cannot
recover expired upstream data.

[Verification evidence](../starter-sql-verification.md) maps the intended behavior to CI tests,
a credential-free live verification script, and real browser screenshots. CI uses injected
transports/connections and never provisions cloud resources. Distributed admission, encrypted
secrets, public identity, persistent Starter/PG, real billing and reliable server cancellation
remain separate future work.
