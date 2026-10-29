# TiDB Agent Workspace

An independent Workspace for developers and agents to use databases and files through one scoped Workspace Key. The Console is React/TiUI; the installed hosted API uses Node with SSO, while the native regional API/Meta profile uses Rust. MySQL, opt-in db9 PostgreSQL, native DuckDB and independent File Systems have separate provider capabilities and credential boundaries.

Start with [start-here.md](start-here.md), [contribution rules](CONTRIBUTING.md) and [architecture](docs/architecture.md). Proposed hosted multi-tenancy and production identity remain distinct from the current trusted loopback development profile.

## Hosted Studio and runtime selection

The hosted Node API retains TiDB Account SSO and `/studio` routing. [`.env.example`](.env.example) documents issuer, public client, callback and owner grants. Verified-email rules grant shared workspace ownership; they do not create separate customer tenants. Existing main-only API CD preserves its JSON/vault volume; native Rust/SlateDB cutover is a separate migration. See [the integration boundary](docs/decisions/0025-consolidated-runtime-profiles.md).

## Local setup

Use the exact Node/npm versions in `.node-version` and `package.json`, Rust from `rust-toolchain.toml`, and installed RustFS 1.0.4.

```sh
npm ci
npm run backend:build
npm run meta:local -- init --directory .data/meta-runtime --api-port 4318
npm run meta:local -- serve --directory .data/meta-runtime
```

Then run `npm run dev:console` in another terminal and open http://127.0.0.1:5173. The operator starts independent Global and regional Meta roles and the regional API. First creation produces an empty Workspace with no cloud provisioning or sample resources. Subsequent starts reuse its versioned encrypted SlateDB/S3 records. No JSON import is required or supported.

Provider configuration lives in private `.data/meta-runtime/rust-api.json`, under `product.providers`:

```json
{
  "filesProvider": "drive9-anonymous",
  "mysqlProvider": "tidb-cloud-zero",
  "postgresProvider": "db9-anonymous"
}
```

These modes enable explicit resource creation in the Console; startup does not provision instances. Defaults use local demo files/MySQL with PostgreSQL disabled. Native DuckDB also requires a separately verified tidbfs extension under `product.compute`. The service manages native credentials internally; callers use scoped Workspace Keys. See [Rust configuration](docs/rust-backend.md), [db9](docs/db9-postgres.md), [MySQL](docs/starter-sql-verification.md) and [DuckDB](docs/duckdb-databases.md) for boundaries and limits.

## Build and verification

| Component       | Build                    | Run                                                                  |
| --------------- | ------------------------ | -------------------------------------------------------------------- |
| Console         | `npm run build:console`  | `npm run start:console` or static hosting                            |
| Rust API / Meta | `npm run build:api:rust` | `workspace-backend serve --config /absolute/private/deployment.json` |

`npm run check` runs the shared Node/Console quality gate. `npm run backend:check` runs the Rust and real isolated S3/API/native artifact suites. The hosted-compatible Node API also builds with `npm run build:api` and starts with `npm run start:api`; its runtime closure stays independent of the Console. See [ADR 0025](docs/decisions/0025-consolidated-runtime-profiles.md) for the explicit storage/rollout boundary.

`npm run package -- FULL_REVIEWED_SOURCE_SHA` packages a reviewed clean native backend and separate Console assets with source SHA and checksums. Configuration and credentials remain outside artifacts. Console `/config.json` selects the API origin. Follow [independent delivery](docs/independent-delivery.md) and [CI/CD policy](docs/ci-cd.md).

```sh
WORKSPACE_FILES_PROVIDER=drive9-anonymous npm run dev:api:node
```

Create a File System in the Console. The backend provisions the trial and retains its internal
credential; customers still use a scoped Workspace Key. Existing local files remain local.
See [the provider decision](docs/decisions/0004-drive9-anonymous-provider.md) for limits,
private storage, recovery, and live verification instructions.

## Real MySQL with TiDB Cloud Zero

Enable anonymous database creation alongside the Singapore File System:

```sh
WORKSPACE_MYSQL_PROVIDER=tidb-cloud-zero WORKSPACE_FILES_PROVIDER=drive9-anonymous npm run dev:api:node
```

Create a MySQL database in the Console, then open its SQL editor. The backend creates the
Zero instance and a database-scoped application user; no provider account or customer-supplied
credential is needed. Customers use Workspace Keys with `queries:execute` and resource grants.
That action permits both reads and writes. Native passwords stay in a separate 0600 private
file. Existing demo resources retain their labeled local behavior.

Zero databases expire after up to 30 days; the Console shows the provider's exact expiry.
Export important data before expiry. Region assignment is automatic. This integration does not
claim/upgrade trials or automatically replace expired/uncertain instances. Legacy simulated PG
records remain hidden on disk; db9 resources use new private bindings.
See [the SQL boundary and recovery](docs/decisions/0006-zero-sql-gateway.md) and
[real verification evidence](docs/starter-sql-verification.md).

## PostgreSQL with db9

Enable `WORKSPACE_POSTGRES_PROVIDER=db9-anonymous` alongside the existing provider flags,
then create **PostgreSQL · db9** in the Console. Official REST calls create an anonymous account
and database; SQL uses a restricted native PostgreSQL role over verified TLS. Customers use
Workspace Keys for queries, table browsing and files; upstream credentials stay in the service.
Anonymous accounts currently allow five databases. Provider quotas/compatibility apply and
usage is not metered. db9 NUMERIC supports 28–29 significant digits, rather than PostgreSQL's
larger precision range. See [setup and recovery](docs/db9-postgres.md),
[the provider decision](docs/decisions/0011-db9-postgres.md) and [verification](docs/db9-verification.md).

## DuckDB databases

Select DuckDB in Databases to create an analytical database with dedicated service-managed
storage in Singapore. Customers see only the database; its backing File System and credentials
remain internal. The same scoped Workspace Key works with MySQL, DuckDB and standalone Files.
The operator supplies a verified DuckDB 2.0 tidbfs artifact; without it, creation is unavailable.
See [runtime setup and recovery](docs/duckdb-databases.md) and
[verification](docs/duckdb-verification.md). Native remote storage is experimental.

## What works

- DuckDB queries can use selected CSV, JSON/NDJSON and Parquet from public File Systems as query-scoped `files.name` tables, including joins. Require query/read/analyze actions and both database/File System grants. Four sources / 16 MiB input, read-only SELECT and the existing bounded worker. See [file sources](docs/duckdb-databases.md#workspace-file-sources).

- Nine top-level destinations: overview, databases, files, agent connection, keys, API explorer, monitoring, billing, settings. Each database has one SQL workspace with a persistent table list, editor, query results, columns, indexes and up to 100 preview rows at `#databases/<resource-id>/sql`, preserving the selected database on reload and browser history navigation.
- Table links preserve exact names and keep the SQL editor visible. Table selection retains drafts; Query table explicitly prepares a SELECT. Agents use the same scoped table APIs; see [unified workspace verification](docs/database-workspace-verification.md) and [database API evidence](docs/database-browser-verification.md).
- Simulated databases/local files by default, plus opt-in real Zero MySQL, db9 PostgreSQL databases and Drive9 anonymous File Systems in Singapore. Creation persists idempotency and provider bindings across restarts.
- Local UTF-8 files up to 256 KiB; live text/binary uploads up to the negotiated gateway maximum of 1 MiB, metadata listings, bounded previews, streaming downloads, and empty-directory deletion. Markdown, JSON, CSV, code, and text render in a side panel; oversized/binary content remains downloadable.
- Read-only file analysis in the file side panel: CSV/Parquet use real DuckDB SQL; UTF-8 logs/text use Just Bash grep/awk/pipelines. The API takes bounded snapshots from local or live files, with no hosted Exec requirement. Agents need both `files:read` and `files:analyze` plus the File System grant; existing keys are unchanged. See [limits and verification](docs/file-analysis-verification.md).
- Unified Workspace Keys with action scopes and explicit resource access, 7/30/90-day expiration, last-used metadata, and immediate revocation. Keys are revealed once; only a digest is stored.
- Working Bearer-authenticated REST APIs, owner-only key administration, OpenAPI 3.1, API explorer, and agent instructions.
- Local action counts, file usage, latest 200 successful mutation events, and saved profile / workspace settings.
- Responsive layouts, keyboard search, modal focus management, and reduced-motion support.

## Prototype boundaries

Unbound database instances and chart series are simulated and labeled in the UI. Demo SQL supports only `SELECT 1 [AS connected]` and `SELECT * FROM agent_events [LIMIT n]`; this is not a MySQL or PostgreSQL server. Legacy/local files remain text in JSON. File Systems marked `drive9-anonymous` store their content in the real Singapore service, with internal tokens in a separate owner-only ignored file. Database usage is not metered; local filesystem allowances are a reference snapshot. Live trial storage usage, quotas, and billing are not measured. One Workspace Key works across its permitted database and file APIs. Both action scopes and resource IDs are enforced; selected resources do not automatically expand to future resources. Path-level policies and native protocol gateways are not implemented.

Persistent Starter provisioning, production secret management, native protocol gateways, real telemetry, MCP, multi-tenant sign-in, payments, and invoices are proposed in [the architecture document](docs/architecture.md). The native loopback guest profile remains for local validation. Hosted Node SSO is an explicitly configured shared workspace, without customer/team isolation.

The console uses `@tidbcloud/uikit@2.9.1` components, provider, official icons, and TiUI SQL Editor 0.0.6. Shared overrides preserve 16px body text, 48px primary controls, spacious layouts, and Light/Dark/System modes. Inter is self-hosted. See the [TiUI standard](docs/standards/tiui-design-system.md) for compatibility, extension rules, and [migration verification](docs/tiui-migration-verification.md).

## Code map

- `src/App.tsx`, `src/main.tsx`, `src/styles.css`: interactive frontend prototype.
- `server/index.mjs`: standalone API and resource/file/key/query handlers; no Console serving.
- `server/providers/zero.mjs`, `server/providers/sql-drivers.mjs`: anonymous MySQL provisioning and bounded native SQL.
- `server/providers/drive9.mjs`, `server/file-transfer.mjs`: internal provider adapter and bounded transfers.
- `server/access-policy.mjs`: shared action/resource authorization support.
- `src/features/keys/ResourceAccessPicker.tsx`: explicit customer key resource selection.
- `server/store.mjs`: serialized atomic local state persistence and capability snapshot.
- `server/generate-openapi.mjs`: canonical API contract source.
- `public/openapi.json`, `src/api/schema.d.ts`: generated contract and client types.
- `src/api/`: shared generated-type HTTP client and runtime API configuration.
- `console/public/config.json`: runtime API origin; `scripts/serve-console.mjs`: optional static runner.
- `server/api.test.mjs`: behavior tests using temporary state and isolated ports.
- `docs/architecture.md`: product model, page design, backend boundaries, integration strategy, and release acceptance criteria.

The live adapter creates real anonymous trials only when enabled and explicitly requested. CI uses injected provider fixtures and never provisions cloud resources. Hosted Node credential vaults remain private plaintext files on the existing volume; native SlateDB credentials use the encrypted record profile. Multi-tenant native public deployment remains separate work.

## Collaboration and delivery

Contribute a user problem, detailed specification, acceptance case, implementation, or harness
improvement. The [intent driven development system](docs/standards/intent-driven-development.md)
defines API-first and agent-experience principles and a staged design for safe automated
delivery. Start a specification with [the feature template](docs/templates/feature-spec.md).
The autonomous harness remains proposed; existing quality and delivery policies apply.

Use the [GitHub contribution workflow](docs/standards/github-contribution-workflow.md) to take
an [intent Issue](https://github.com/mem9-ai/tidb.ai/issues/new?template=01-intent.yml)
through a specification PR, bounded implementation tasks, evaluation, and delivery. Different
agents can take successive roles against the same accepted Git revision. Native Issue forms
support intent, tasks, and acceptance cases; automatic dispatch is not yet implemented.

Every coding tool uses the shared [agent instructions](AGENTS.md), [contribution guide](CONTRIBUTING.md), and [standards index](docs/standards/README.md). The [knowledge-maintenance workflow](docs/standards/knowledge-maintenance.md) captures reusable user feedback and integration findings in repository docs, so future contributors can use them without this chat's history.

`npm run check` is the common local/CI gate. It checks required standards and instruction links as well as application quality; it does not certify visual fidelity. The [CI/CD policy](docs/ci-cd.md) describes PR review, immutable artifacts, and future protected deployments. GitHub CI runs in `siddontang/tidb.ai`; repository protections and a real deployment target are not configured.

The product uses one customer-facing Workspace Key; upstream provider credentials are owned by internal services. See [ADR 0001](docs/decisions/0001-unified-workspace-key.md). Existing prototype keys without an explicit resource grant must be reissued.
