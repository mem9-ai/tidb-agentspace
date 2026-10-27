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

`preview` serves the built frontend and API together at http://127.0.0.1:4318. Agent connection samples use the current page origin, so they work with either preview mode. Regenerate the checked-in API contract after contract changes with `node server/generate-openapi.mjs`.

## What works

- Ten complete frontend routes: overview, databases, SQL editor, files, agent connection, keys, API explorer, monitoring, billing, settings.
- Creation of simulated resources with capability and free-tier validation, plus retry-safe idempotency keys.
- Persistent UTF-8 file and directory operations, text uploads up to 256 KiB, editing, downloading, and empty-directory deletion.
- Unified Workspace Keys with action scopes and explicit resource access, 7/30/90-day expiration, last-used metadata, and immediate revocation. Keys are revealed once; only a digest is stored.
- Working Bearer-authenticated REST APIs, owner-only key administration, OpenAPI 3.1, API explorer, and agent instructions.
- Local action counts, file usage, latest 200 successful mutation events, and saved profile / workspace settings.
- Responsive layouts, keyboard search, modal focus management, and reduced-motion support.

## Prototype boundaries

Cloud instances, native connection addresses, and chart series are simulated and labeled in the UI. SQL supports only `SELECT 1 [AS connected]` and `SELECT * FROM agent_events [LIMIT n]`; this is not a MySQL or PostgreSQL server. Files are stored as text in a local JSON state file, not in TiDB Cloud File System. Database usage is not metered; filesystem allowance values are a configurable reference snapshot. One Workspace Key works across its permitted database and file APIs. Both action scopes and resource IDs are enforced; selected resources do not automatically expand to future resources. Path-level policies and native protocol gateways are not implemented.

Real cloud adapters, internal credential management, native protocol gateways, real telemetry, MCP, sign-in, payments, and invoices are proposed in [the architecture document](docs/architecture.md). This loopback-only guest server is for local validation, not public deployment. The UI follows the visual direction of TiDB Cloud; official TiUI packages were not available in this empty workspace.

## Code map

- `src/App.tsx`, `src/main.tsx`, `src/styles.css`: interactive frontend prototype.
- `server/index.mjs`: local API, resource/file/key/query handlers, and built frontend serving.
- `server/access-policy.mjs`: shared action/resource authorization support.
- `src/features/keys/ResourceAccessPicker.tsx`: explicit customer key resource selection.
- `server/store.mjs`: serialized atomic local state persistence and capability snapshot.
- `public/openapi.json`: implemented public API contract.
- `server/api.test.mjs`: behavior tests using temporary state and isolated ports.
- `docs/architecture.md`: product model, page design, backend boundaries, integration strategy, and release acceptance criteria.

No cloud credentials are configured and no real cloud resources or charges were created.

## Collaboration and delivery

Every coding tool uses the shared [agent instructions](AGENTS.md) and [contribution guide](CONTRIBUTING.md). `npm run check` is the common local/CI gate. The [CI/CD policy](docs/ci-cd.md) describes PR review, commit sign-off, immutable artifacts, and future protected deployments. Workflow files are prepared; repository protections and a real deployment target are not configured in this local folder.

The product uses one customer-facing Workspace Key; upstream provider credentials are owned by internal services. See [ADR 0001](docs/decisions/0001-unified-workspace-key.md). Existing prototype keys without an explicit resource grant must be reissued.
