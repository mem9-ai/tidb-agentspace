# TiDB Agent Workspace

An independent developer and agent console prototype for MySQL-compatible TiDB Starter, PostgreSQL-compatible TiDB Starter, and TiDB Cloud File System.

## Run locally

Use Node **24.22.1** and npm **11.6.2**. See [CONTRIBUTING.md](CONTRIBUTING.md) for version-manager setup. Shared agent instructions are in [AGENTS.md](AGENTS.md).

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. The API listens on 127.0.0.1:4318. Both bind only to loopback. There is no sign-in screen; the frontend obtains a local owner session. Session state is in memory and resets when the server restarts. Workspace contents persist under the ignored `.data/` directory.

```sh
npm run check
npm run preview
```

`preview` serves only the built Console at http://127.0.0.1:4173. Start the API separately with
`npm run start:api`. Console requests and agent examples use the API origin in `/config.json`.
Run `npm run api:generate` after contract changes to generate both OpenAPI and client types.

The frontend and backend build and run independently in this repository:

| Component | Build                   | Development           | Run built output                           |
| --------- | ----------------------- | --------------------- | ------------------------------------------ |
| Console   | `npm run build:console` | `npm run dev:console` | `npm run start:console`                    |
| API       | `npm run build:api`     | `npm run dev:api`     | `cd dist/api` then `node server/index.mjs` |

The API build requires only Node and no frontend dependencies. The Console output is static;
its API origin can change without rebuilding JavaScript. See [independent delivery](docs/independent-delivery.md)
for configuration, separate artifacts, contract checks, and current deployment limits.

To enable real Singapore anonymous File System creation (explicit opt-in):

```sh
WORKSPACE_FILES_PROVIDER=drive9-anonymous npm run dev
```

Create a File System in the Console. The backend provisions the trial and retains its internal
credential; customers still use a scoped Workspace Key. Existing local files remain local.
See [the provider decision](docs/decisions/0004-drive9-anonymous-provider.md) for limits,
private storage, recovery, and live verification instructions.

## What works

- Nine top-level destinations: overview, databases, files, agent connection, keys, API explorer, monitoring, billing, settings. Each database has its own SQL editor at `#databases/<resource-id>/sql`, preserving the selected database on reload and browser history navigation.
- Simulated databases/local files by default, plus opt-in live Drive9 anonymous File Systems in Singapore. Creation persists idempotency and provider bindings across restarts.
- Local UTF-8 files up to 256 KiB; live text/binary uploads up to the negotiated gateway maximum of 1 MiB, metadata listings, bounded previews, streaming downloads, and empty-directory deletion. Markdown, JSON, CSV, code, and text render in a side panel; oversized/binary content remains downloadable.
- Unified Workspace Keys with action scopes and explicit resource access, 7/30/90-day expiration, last-used metadata, and immediate revocation. Keys are revealed once; only a digest is stored.
- Working Bearer-authenticated REST APIs, owner-only key administration, OpenAPI 3.1, API explorer, and agent instructions.
- Local action counts, file usage, latest 200 successful mutation events, and saved profile / workspace settings.
- Responsive layouts, keyboard search, modal focus management, and reduced-motion support.

## Prototype boundaries

Database instances, native database connection addresses, and chart series are simulated and labeled in the UI. SQL supports only `SELECT 1 [AS connected]` and `SELECT * FROM agent_events [LIMIT n]`; this is not a MySQL or PostgreSQL server. Legacy/local files remain text in JSON. File Systems marked `drive9-anonymous` store their content in the real Singapore service, with internal tokens in a separate owner-only ignored file. Database usage is not metered; local filesystem allowances are a reference snapshot. Live trial storage usage, quotas, and billing are not measured. One Workspace Key works across its permitted database and file APIs. Both action scopes and resource IDs are enforced; selected resources do not automatically expand to future resources. Path-level policies and native protocol gateways are not implemented.

Database cloud adapters, production secret management, native protocol gateways, real telemetry, MCP, sign-in, payments, and invoices are proposed in [the architecture document](docs/architecture.md). This loopback-only guest server is for local validation, not public deployment.

The console uses `@tidbcloud/uikit@2.9.1` components, provider, official icons, and TiUI SQL Editor 0.0.6. Shared overrides preserve 16px body text, 48px primary controls, spacious layouts, and Light/Dark/System modes. Inter is self-hosted. See the [TiUI standard](docs/standards/tiui-design-system.md) for compatibility, extension rules, and [migration verification](docs/tiui-migration-verification.md).

## Code map

- `src/App.tsx`, `src/main.tsx`, `src/styles.css`: interactive frontend prototype.
- `server/index.mjs`: standalone API and resource/file/key/query handlers; no Console serving.
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

The live adapter creates real anonymous trials only when enabled and explicitly requested. CI uses injected provider fixtures and never provisions cloud resources. Local credential files are not encrypted; public deployment is unsupported.

## Collaboration and delivery

Contribute a user problem, detailed specification, acceptance case, implementation, or harness
improvement. The [intent driven development system](docs/standards/intent-driven-development.md)
defines API-first and agent-experience principles and a staged design for safe automated
delivery. Start a specification with [the feature template](docs/templates/feature-spec.md).
The autonomous harness remains proposed; existing quality and delivery policies apply.

Use the [GitHub contribution workflow](docs/standards/github-contribution-workflow.md) to take
an [intent Issue](https://github.com/siddontang/tidb.ai/issues/new?template=01-intent.yml)
through a specification PR, bounded implementation tasks, evaluation, and delivery. Different
agents can take successive roles against the same accepted Git revision. Native Issue forms
support intent, tasks, and acceptance cases; automatic dispatch is not yet implemented.

Every coding tool uses the shared [agent instructions](AGENTS.md), [contribution guide](CONTRIBUTING.md), and [standards index](docs/standards/README.md). The [knowledge-maintenance workflow](docs/standards/knowledge-maintenance.md) captures reusable user feedback and integration findings in repository docs, so future contributors can use them without this chat's history.

`npm run check` is the common local/CI gate. It checks required standards and instruction links as well as application quality; it does not certify visual fidelity. The [CI/CD policy](docs/ci-cd.md) describes PR review, commit sign-off, immutable artifacts, and future protected deployments. GitHub CI runs in `siddontang/tidb.ai`; repository protections and a real deployment target are not configured.

The product uses one customer-facing Workspace Key; upstream provider credentials are owned by internal services. See [ADR 0001](docs/decisions/0001-unified-workspace-key.md). Existing prototype keys without an explicit resource grant must be reissued.
