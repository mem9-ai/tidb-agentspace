# GH-40: Anonymous db9 PostgreSQL

- Parent: [Issue #40](https://github.com/siddontang/tidb.ai/issues/40).
- Intent/accountable maintainer: Siddon Tang; specification: coding agent acting for Siddon.
- Status: proposed for the owner-requested integration; merge establishes the implementation baseline.
- Source base: `7fc78a3`; dependencies: Workspace Key policy, Zero SQL budgets, database browser,
  generated contract and TiUI standards. The implementation PR pins the full accepted revision.

## Outcome and scope

Create a PostgreSQL resource backed by db9's anonymous/free service, browse its workspace schema
and execute real SQL in the existing compact database page. Console and agent API share backend
operations. Customers use a Workspace Key; the service manages db9 account and native credentials.
The product says PostgreSQL / db9, not TiDB Cloud Starter. PostgreSQL remains unavailable when
its adapter is not enabled. MySQL, DuckDB and File System keep their existing behavior.

No account claiming, paid tier, billing enrollment, provider CLI, db9 filesystem, branch management,
public hosting, direct native credential export or cross-schema browsing is included.

## Observable contract

- Opt in with `WORKSPACE_POSTGRES_PROVIDER=db9-anonymous`. `/resources` accepts kind `postgresql`
  with `automatic` region, existing name and idempotency rules, `resources:write` and wildcard
  resource access (or local owner). Disabled mode rejects PG creation before provider I/O.
- Capabilities describe actual availability. Native PostgreSQL and official REST provisioning
  are backend-only. Unknown storage/usage allowances are null. Anonymous token expiry is not
  reported as database expiry; no database lifetime or location is invented.
- New resources start provisioning; stored bindings drive active/provisioning/failed status.
  Persist anonymous registration intent, returned account credentials and resource creation intent
  before the next external effect. Persist the provider instance and stable role credentials before
  native setup. Coalesce concurrent same-resource provisioning. Never repeat an uncertain create
  or register POST automatically. Recovery must reuse the saved account and instance; an authorized
  setup retry can look up the deterministic provider name but cannot create a replacement.
- `POST /resources/{id}/setup` uses existing resource-write authorization. Retry incomplete native
  setup on the saved instance. Definitive provider quota/permission failures and uncertain effects
  return structured errors; raw provider responses, SQL and credentials never enter public errors.
- Customer SQL uses a generated non-superuser native role owning only a dedicated `workspace`
  schema. The account token/admin role is never used for customer SQL. Fresh verified-TLS sessions
  execute one extended-protocol statement; close on completion, cancellation, timeout or overflow.
  Limits: 64 KiB SQL, 15 seconds including connection, four concurrent adapter queries, 1,000 rows
  and 1 MiB retained result. Never automatically retry user SQL; writes can commit before an error.
- The existing query envelope and `queries:execute` plus resource grants apply. Keep bigint/decimal
  precision, timestamps, NULLs, duplicate column names and binary results. DDL/DML returns affected
  rows. No persistent transaction/session across requests.
- Existing table APIs expose only `workspace` tables/views, columns/defaults/nullability, indexes
  and at most 100 unordered rows. Use PostgreSQL identifier quoting and safe metadata values.
  Exact identifiers retain their route identity. No schema selector or new grants are introduced.
- PG may share a Workspace Key with selected Files, while other database resources remain denied.
  Expired/revoked/missing/wrong-workspace/scoped credentials fail before native/provider access.
- Legacy retired PG records remain hidden and inaccessible; enabling db9 never silently rebinds
  or advertises those records. Existing MySQL/DuckDB/file data and private vaults are unchanged.

## Console and agent experience

Creation, resource cards, Key picker, connection instructions and database page include PostgreSQL
only with its actual capability. Keep TiUI 2.9.1, SQL Editor 0.0.6 with PostgreSQL dialect, large text,
compact desktop work area and both themes. Tables, editor and results stay together; table selection
retains drafts/results, and generated SELECT requires explicit replacement of edited SQL.

Agents discover capabilities, create with an idempotency key, observe readiness, query, browse and
recover setup through the same public API. Upstream credentials are not accepted as public inputs.
Connection instructions describe the Workspace gateway and use Workspace Key placeholders only.

## Acceptance baseline

| ID    | Required observation                                                                                                                                                               | Evidence                                                     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| PG-01 | Anonymous registration + one database create; stable native application setup, state after restart and same-idempotency concurrency; unavailable mode does no provider I/O         | Injected provider/API fixtures, one authorized live instance |
| PG-02 | No uncertain POST replay; saved-instance retry; token refresh retains account identity; unsafe/invalid vault or destination fails closed                                           | Provider persistence/negative fixtures                       |
| PG-03 | Query/metadata boundaries reject wrong resource/workspace, missing actions, expired/revoked keys and retired PG before upstream calls; a selected PG+Files key excludes another DB | API call-spy regressions + live unified Key check            |
| PG-04 | Verified TLS, one extended statement, bounded rows/bytes/time, canceled/failing sessions close; precise values and DML envelopes preserved; errors sanitized                       | Driver fixtures + native live queries                        |
| PG-05 | Exact quoted names, columns, ordered indexes, bounded rows and missing-table errors from workspace only                                                                            | Browser fixtures + live table/schema/data read               |
| PG-06 | Create → browse → query with TiUI PostgreSQL editor; keep/replace behavior; Key resource selection; light/dark 1280×800/900 and 390×844                                            | Browser screenshots and measurements                         |
| PG-07 | Generated API/client alignment, old resources/queries work and packaged API includes the pinned PG runtime dependency                                                              | Contract/API regression suite + npm run check/package tests  |

## Delivery and recovery

Merge the scoped design first, pin its revision in implementation, then evaluate all mandatory cases.
Use the current local agent and normal CI; CI must not require cloud credentials or create resources.
Live acceptance may create one anonymous account/database and a clearly named sample table, then
reuse it for the local preview. Never print secrets or create additional accounts to bypass quotas.
No database deletion is required. Tests can create/revoke local Workspace Keys and remove explicitly
identified disposable fixture tables. Source rollback preserves public state and the private PG vault;
disabling the adapter stops new PG creation without deleting stored bindings or cloud data.

Review, signed commits, latest-head green CI, authorized merge and updated local preview complete
this task. The parent intent stays open until that endpoint is verified. See ADR 0011 for the
credential/provider decision and official upstream references.
