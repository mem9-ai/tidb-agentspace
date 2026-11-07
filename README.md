# TiDB Agent Workspace

An independent Workspace for developers and agents to use databases and files through one scoped Global Workspace Key and Region access Tokens. The Console is React/TiUI; the hosted/local API and regional Meta services use Rust. PostgreSQL-compatible databases and File Systems have separate provider capabilities and credential boundaries. File System SQL analysis runs on DuckDB.

Start with [start-here.md](start-here.md), [contribution rules](CONTRIBUTING.md) and [architecture](docs/architecture.md). The Rust API supports local guest and hosted shared-Workspace SSO; production multi-tenant identity remains planned.

## Hosted Studio and runtime selection

Rust implements TiDB Account code + S256 PKCE, exact issuer/JWKS verification, explicit owner grants and `/studio` routing. All admitted accounts own the same Workspace. Automatic native image delivery and independent Console publication remain separate. The owner authorizes a fresh S3 prefix and new metadata encryption keys; old Node data is not migrated. See [native deployment and local login](docs/native-studio-deployment.md) and [ADR 0026](docs/decisions/0026-native-hosted-studio.md). Real provider sign-in/live rollout must be verified separately from local tests.

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
  "postgresProvider": "db9-anonymous"
}
```

These modes enable explicit resource creation in the Console; startup does not provision instances. Defaults use local demo files with PostgreSQL disabled. The service manages native credentials internally; callers use scoped Workspace Keys. See [Rust configuration](docs/rust-backend.md), [PostgreSQL](docs/db9-postgres.md), and [the retirement decision](docs/decisions/0048-postgresql-only-databases.md) for boundaries and limits.

## Build and verification

| Component       | Build                   | Run                                                                  |
| --------------- | ----------------------- | -------------------------------------------------------------------- |
| Console         | `npm run build:console` | `npm run start:console` or static hosting                            |
| Rust API / Meta | `npm run build:api`     | `workspace-backend serve --config /absolute/private/deployment.json` |

`npm run check` verifies Console, generated contracts and tooling tests. `npm run backend:check` checks native format, build, Clippy, unit tests, isolated real S3/API/SSO and native packaging. `npm run build:api` and all API start commands select Rust. The old Node backend and its dedicated tests are removed; Node is build/operator tooling and a native-test driver only.

`npm run package -- FULL_REVIEWED_SOURCE_SHA` packages a reviewed clean native backend and separate Console assets with source SHA and checksums. Configuration and credentials remain outside artifacts. Console `/config.json` selects the API origin. Follow [independent delivery](docs/independent-delivery.md) and [CI/CD policy](docs/ci-cd.md).

Set `product.providers.filesProvider` to `drive9-anonymous` in the private native API configuration.

Create a File System in the Console. The backend provisions the trial and retains its internal
credential; customers still use a scoped Workspace Key. Existing local files remain local.
See [the provider decision](docs/decisions/0004-drive9-anonymous-provider.md) for limits,
private storage, recovery, and live verification instructions.

## PostgreSQL with db9

Set `product.providers.postgresProvider` to `db9-anonymous` in private native configuration,
then create **PostgreSQL Compatible** in the Console. Official REST calls create an anonymous account
and database; SQL uses a restricted native PostgreSQL role over verified TLS. Customers use
Workspace Keys for queries, table browsing and files; upstream credentials stay in the service.
Anonymous accounts currently allow five databases. Provider quotas/compatibility apply and
usage is not metered. db9 NUMERIC supports 28–29 significant digits, rather than PostgreSQL's
larger precision range. See [setup and recovery](docs/db9-postgres.md),
[the provider decision](docs/decisions/0011-db9-postgres.md) and [verification](docs/db9-verification.md).

## What works

- Top-level destinations include overview, File Systems, databases, tutorials, agent connection, keys, API documentation, billing and settings. Each database has one SQL workspace with a persistent table list, editor, query results, columns, indexes and up to 100 preview rows at `#databases/<resource-id>/sql`, preserving the selected database on reload and browser history navigation.
- Table links preserve exact names and keep the SQL editor visible. Table selection retains drafts; Query table explicitly prepares a SELECT. Agents use the same scoped table APIs; see [unified workspace verification](docs/database-workspace-verification.md) and [database API evidence](docs/database-browser-verification.md).
- Local files by default, plus opt-in PostgreSQL-compatible databases and Drive9 anonymous File Systems in Singapore. Creation persists idempotency and provider bindings across restarts.
- Local UTF-8 files up to 256 KiB; live text/binary uploads up to the negotiated gateway maximum of 1 MiB, metadata listings, bounded previews, streaming downloads, and empty-directory deletion. Markdown, JSON, CSV, code, and text render in a side panel; oversized/binary content remains downloadable.
- Read-only file analysis in the file side panel: CSV/Parquet use real DuckDB SQL; UTF-8 logs/text use Just Bash grep/awk/pipelines. The API takes bounded snapshots from local or live files, with no hosted Exec requirement. Agents need both `files:read` and `files:analyze` plus the File System grant, carried by a Region access Token. See [limits and verification](docs/file-analysis-verification.md).
- Global Workspace Keys with explicit action/resource grants and expiry. Keys are revealed once and exchanged for scoped access Tokens. Global records revocation immediately and reports Region policy application separately; disconnected Regions remain pending.
- Direct Region REST APIs, Global Owner-only Key administration, separate OpenAPI 3.1 contracts, API documentation with executable examples, and agent instructions.
- Local action counts, file usage, latest 200 successful mutation events, and saved profile / workspace settings.
- Responsive layouts, keyboard search, modal focus management, and reduced-motion support.

## Prototype boundaries

Chart series are simulated and labeled in the UI. Local demo files are text records in encrypted native metadata. File Systems marked `drive9-anonymous` store their content in the real Singapore service, with internal credentials in encrypted native records. Database usage is not metered; local filesystem allowances are a reference snapshot. Live trial storage usage, quotas, and billing are not measured. One Workspace Key works across its permitted database and file APIs. Both action scopes and resource IDs are enforced; selected resources do not automatically expand to future resources. Path-level policies and native protocol gateways are not implemented.

Persistent Starter provisioning, production secret management, native protocol gateways, real telemetry, MCP, multi-tenant sign-in, payments, and invoices are proposed in [the architecture document](docs/architecture.md). The native loopback guest profile remains for local validation. Native SSO supports explicitly configured personal Workspace isolation; team sharing and production identity operations retain separate delivery limits.

The console uses `@tidbcloud/uikit@2.9.1` components, provider, official icons, and TiUI SQL Editor 0.0.6. Shared overrides preserve 16px body text, 48px primary controls, spacious layouts, and Light/Dark/System modes. Inter is self-hosted. See the [TiUI standard](docs/standards/tiui-design-system.md) for compatibility, extension rules, and [migration verification](docs/tiui-migration-verification.md).

## Code map

- `src/App.tsx`, `src/main.tsx`, `src/styles.css`: interactive frontend prototype.
- `backend/api/` and `backend/host/`: native HTTP/SSO policy and executable composition.
- `backend/providers/`: anonymous provisioning, private provider credentials and native SQL drivers.
- `backend/product/`: resource lifecycle, database browsing, files, analysis and exports/imports.
- `backend/workspace/`: resource/action authorization and native record repositories.
- `src/features/keys/ResourceAccessPicker.tsx`: explicit customer key resource selection.
- `server/generate-openapi.mjs`: canonical API contract source.
- `public/openapi.json`, `public/owner-openapi.json`, `src/api/schema.d.ts`: generated Agent and regional Owner contracts and Portal client types.
- `src/api/`: shared generated-type HTTP client and runtime API configuration.
- `console/public/config.json`: runtime API origin; `scripts/serve-console.mjs`: optional static runner.
- `server/rust-product.test.mjs`, `server/rust-backend.test.mjs`, `server/contract.test.mjs`: native behavior, authorization and HTTP schema tests with isolated RustFS/S3.
- `docs/architecture.md`: product model, page design, backend boundaries, integration strategy, and release acceptance criteria.

The live adapter creates real anonymous trials only when enabled and explicitly requested. CI uses injected provider fixtures and never provisions cloud resources. Native SlateDB credentials use the encrypted record profile; the old Node JSON/vault runtime is retired. Multi-tenant native public deployment remains separate work.

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

`npm run check` is the common local/CI gate. It checks required standards and instruction links as well as application quality; it does not certify visual fidelity. The [CI/CD policy](docs/ci-cd.md) describes PR review, immutable artifacts, and future protected deployments. GitHub CI runs in `mem9-ai/tidb.ai`; deployment depends on the target environment and its configured protections.

The product uses one customer-facing Workspace Key; upstream provider credentials are owned by internal services. See [ADR 0001](docs/decisions/0001-unified-workspace-key.md). Retired direct regional Keys are discarded under [ADR 0036](docs/decisions/0036-global-keys-only.md); resources and provider/native credentials remain intact. Read [the API guide](docs/api-guide.md) for Global Key creation, Token exchange, Region data access and local renewal.

Read [SlateDB Metadata Architecture Version 1](docs/slatedb-metadata-design.md) for the complete
Global/Region metadata design, domain model, durability, security, recovery and iteration plan.
The document distinguishes the target architecture from current implementation limits.
