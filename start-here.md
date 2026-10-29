# Start here with TiDB Agent Workspace

This is the shared entry point for people and coding agents opening the repository for the
first time. Follow the reading route, then inspect the sources for your task. The shared
context lives in the repository; private chat history and personal agent settings are not
prerequisites. Read an entry point once rather than following its links in a loop.

This guide explains the project and routes to authoritative documents. Detailed rules remain
in [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and the linked standards.
Explicit user instructions and higher-priority tool requirements still apply.

## What we are building

The project has two connected goals:

1. Build an independent TiDB workspace for developers and agents. MySQL, opt-in db9 PostgreSQL, DuckDB and File System are
   currently available; persistent TiDB Cloud Starter integrations remain planned. Resource
   types have distinct capabilities. Customers use a Workspace Key; backend services manage
   provider credentials. The README and accepted decisions own current provider availability.
2. Make intent, specifications, and acceptance cases useful open source contributions.
   Different agents should implement the same accepted behavior, with a harness supplying
   bounded execution, independent evidence, and authorized delivery.

The design direction is API-first and agent-experience-first. Console and agent interfaces
share domain operations and backend authorization. Observable behavior, permissions, failures,
and compatibility form the agreement between implementations; identical code is not required.
Read the [architecture](docs/architecture.md) and
[development system](docs/standards/intent-driven-development.md) for the full reasoning.

The Console and API build, run, and package independently in this repository. The Console
consumes generated API types and selects its API origin at runtime. This implemented boundary
is documented in [independent delivery](docs/independent-delivery.md) and
[ADR 0005](docs/decisions/0005-independent-console-and-api.md).

## First reading route

| Order | Read                                                                                                                                    | Understand                                                                                 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1     | [Shared instructions](AGENTS.md)                                                                                                        | Working together, coding, validation, and delivery rules; skip rereading if already loaded |
| 2     | [What works](README.md#what-works) and [prototype boundaries](README.md#prototype-boundaries)                                           | Current capabilities, simulations, and limitations                                         |
| 3     | [Architecture](docs/architecture.md) and [accepted decisions](docs/decisions/README.md)                                                 | Product goals and resource, credential, and design boundaries                              |
| 4     | [Development system](docs/standards/intent-driven-development.md) and [GitHub workflow](docs/standards/github-contribution-workflow.md) | Intent, accepted specifications, implementation, evaluation, and delivery                  |
| 5     | [Contribution guide](CONTRIBUTING.md) and [standards index](docs/standards/README.md)                                                   | Reproducible setup and the references required for your task                               |
| 6     | Task Issue, accepted spec revision, affected code/tests, and nested instructions                                                        | Exact behavior, dependencies, authority, and required evidence                             |

Complete this overview before implementation, then read the applicable references deeply.
Load documents relevant to the task rather than every historical screenshot or verification
note. An intent contribution can start with a user problem and a concrete example.

## Understand the current state

| Area                | Current interpretation                                                                                                                                                                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product runtime     | Independently runnable Console and API in a loopback-only prototype. MySQL, PostgreSQL, DuckDB and Files support explicit live-provider modes; labeled local demo behavior also exists. PostgreSQL is available through opt-in db9; retired simulated PG remains hidden. Read the README for current availability, limits, and configuration. |
| Public API          | [Generated OpenAPI](public/openapi.json) and [client types](src/api/schema.d.ts) describe the implemented HTTP surface. The [contract generator](server/generate-openapi.mjs) is the editable source.                                                                                                                                         |
| Product target      | Persistent Starter/PG, production identity, telemetry, billing, SDK/CLI/MCP, and public delivery include proposed work. Use the architecture, README, and accepted decisions to assess each capability.                                                                                                                                       |
| Contribution system | GitHub forms, labels, versioned specs, local checks and PR/CI procedures support the current local agent. `/agent` comments are handoff requests; execution stays in the already running session.                                                                                                                                             |
| Delivery            | [CI/CD policy](docs/ci-cd.md) distinguishes accepted specs, passing checks, merged source, packaged artifacts, and verified deployments.                                                                                                                                                                                                      |

Distinguish **verified implementation**, **accepted project rule**, and **proposal**. Check
relevant behavior against current source, contracts, and tests. When documents disagree,
inspect their status and evidence, explain the conflict, and correct the canonical source
within the task's scope. A proposed architecture does not establish a runtime capability.

## Read for your task

For multi-tenant metadata, storage adapters, ownership, or migration design, read
[GH-74](specs/gh-74/spec.md) and [proposed ADR 0017](docs/decisions/0017-workspace-kv-control-plane.md).
They preserve the owner's logical-KV/local-file direction, TiDB File System candidate and
global/regional control plus regional data-plane separation. Resource placement, dispatch,
consistency, isolation and migration remain proposed behavior, distinct from the running
single-Workspace service.
For millions of Workspaces or a million-resource Workspace, also read the
[metadata scale profile](specs/gh-74/metadata-scale.md): Workspace ownership is distinct from
atomic-group granularity, shared-cell routing, query indexes and workload capacity evidence.
For Global/Region communication, read the [control-channel contract](specs/gh-74/control-channel.md):
Global initiates commands, policy delivery and information reads; Region has no upstream
callback/admission dependency. Production mTLS and bounded local policy leases remain proposed implementation.

| Task                                                      | Required starting points                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intent, specification, or agent delivery                  | [Development system](docs/standards/intent-driven-development.md), [GitHub workflow](docs/standards/github-contribution-workflow.md), and [feature template](docs/templates/feature-spec.md)                                                                                |
| UI, theme, icons, layout, or frontend dependencies        | [Frontend instructions](src/AGENTS.md), [TiUI standard](docs/standards/tiui-design-system.md), and [shared resource workspace verification](docs/resource-workspace-verification.md); reuse the resource header/bar, browser and item adapters in `src/ui/`                 |
| Public API, authorization, or credentials                 | [Architecture](docs/architecture.md), [Workspace Key decision](docs/decisions/0001-unified-workspace-key.md), generator, and affected API tests                                                                                                                             |
| File System providers or regions                          | [Regions and modes](docs/decisions/0003-filesystem-regions-and-modes.md), [Drive9 boundary](docs/decisions/0004-drive9-anonymous-provider.md), and [provider verification](docs/drive9-verification.md)                                                                     |
| SQL providers, query behavior, or database availability   | [Zero SQL boundary](docs/decisions/0006-zero-sql-gateway.md) and [SQL verification](docs/starter-sql-verification.md); table browsing follows [ADR 0007](docs/decisions/0007-database-browser.md); DuckDB follows [ADR 0008](docs/decisions/0008-duckdb-private-storage.md) |
| TiDB Cloud API, protocol, SDK, or CLI integration choices | [TiDB Cloud integration policy](docs/architecture.md#tidb-cloud-integration-policy)                                                                                                                                                                                         |
| Build, review, merge, artifacts, or deployment            | [Contribution guide](CONTRIBUTING.md), [CI/CD policy](docs/ci-cd.md), and [workflow sources](.github/workflows/)                                                                                                                                                            |
| Separate Console/API builds, configuration, or packaging  | [Independent delivery](docs/independent-delivery.md) and [ADR 0005](docs/decisions/0005-independent-console-and-api.md)                                                                                                                                                     |
| Reusable corrections or integration findings              | [Knowledge maintenance](docs/standards/knowledge-maintenance.md); update the canonical standard or ADR and its entry points                                                                                                                                                 |

DuckDB browsing also follows the bounded read-only catalog-reader exception in
[ADR 0012](docs/decisions/0012-duckdb-catalog-reader.md). Customer SQL remains disposable.

Backend action/resource authorization, service-owned provider secrets, shared domain
operations, and actual TiUI components/adapters are central project boundaries. Their detailed
rules and verification stay in these linked sources.

Database SQL and File System Analyze share execution/result adapters in `src/ui/`, alongside
the resource header, browser and item adapters. Follow the
[shared interaction audit](docs/resource-workspace-verification.md#shared-interaction-audit)
for Run query, samples/limits, expansion, row actions and desktop/mobile collapse behavior.
Its [compact toolbar correction](docs/resource-workspace-verification.md#compact-editor-toolbar)
keeps the tool identity/context understated and consolidates auxiliary controls into Editor tools.
The [compact resource header](docs/resource-workspace-verification.md#compact-resource-header)
puts selection, one status badge and actions in a shared row, with supplemental metadata in Details.
Database table rows additionally follow [inline columns](docs/database-workspace-verification.md#inline-table-columns):
disclose schema in the browser, keep SQL/results primary, and prepare table queries explicitly.

The accepted [result export contract](specs/gh-58/spec.md) and
[ADR 0013](docs/decisions/0013-result-snapshot-exports.md) define bounded snapshot downloads and
create-only copies into public workspace resources. Database and File System SQL now share
CSV/JSON/JSON Lines downloads and file/new-table exports; see
[verification, API usage and limits](docs/result-export-verification.md).

DuckDB uses tidbfs native database mode, with ordinary Tables and SQL in the Console; see
[customer experience](docs/duckdb-databases.md#customer-experience). For the separate optional
query-source API over CSV/JSON/Parquet, read [file sources](docs/duckdb-databases.md#workspace-file-sources),
[ADR 0009](docs/decisions/0009-duckdb-file-sources.md) and [GH-34](specs/gh-34/spec.md).
For CSV/Parquet SQL and text/log analysis, read [ADR 0010](docs/decisions/0010-read-only-file-analysis.md),
[engine options](docs/decisions/0014-file-analysis-engine-options.md)
and [Bash input paths](docs/decisions/0015-bash-workspace-paths.md), plus
[the selected-file variable](docs/decisions/0016-bash-selected-file-variable.md) and
[verification](docs/file-analysis-verification.md). The Console/API implement selected-file
snapshot workers; provider-hosted Exec, large remote scans and public compute isolation remain future work.

For db9 PostgreSQL, read [setup/recovery](docs/db9-postgres.md) and
[ADR 0011](docs/decisions/0011-db9-postgres.md) for anonymous account ownership, native role/TLS
boundaries, creation recovery and provider compatibility limits.

## Find the implementation

| Location                                                                                                                                        | Responsibility                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [src/](src/)                                                                                                                                    | React Console; feature modules in `src/features/`, shared TiUI adapters in `src/ui/`           |
| [src/api/](src/api/) and [Console configuration](console/public/config.json)                                                                    | Generated-type HTTP client, API transport, and runtime API-origin selection                    |
| [server/index.mjs](server/index.mjs)                                                                                                            | Current API entry point and request handling                                                   |
| [Authorization](server/access-policy.mjs) and [store](server/store.mjs)                                                                         | Shared resource-grant rules and local persistence                                              |
| [File analysis](server/file-analysis.mjs) and [Console panel](src/features/files/FileAnalysisPanel.tsx)                                         | Selected-file snapshot workers, permissions, DuckDB/Just Bash analysis and result presentation |
| [Providers](server/providers/) and [file transfer](server/file-transfer.mjs)                                                                    | Upstream resource adapters, SQL drivers, and bounded file transfers                            |
| [Contract generator](server/generate-openapi.mjs) and [generated contract](public/openapi.json)                                                 | Editable description and generated public API artifact                                         |
| [Client type generator](tools/api-contract/generate-client.mjs) and [client declarations](src/api/schema.d.ts)                                  | Isolated build-time generation of Console API types                                            |
| [API tests](server/api.test.mjs), [provider tests](server/drive9.test.mjs), and colocated feature tests                                         | Behavior, isolation, persistence, and regression evidence                                      |
| [Contract tests](server/contract.test.mjs) and [deployment tests](server/deployment.test.mjs)                                                   | Actual HTTP schema checks, cross-origin behavior, and retained authorization                   |
| [scripts/](scripts/) and [.github/workflows/](.github/workflows/)                                                                               | Runtime/repository/sign-off checks, packaging, and CI                                          |
| [Standards](docs/standards/) and [decisions](docs/decisions/)                                                                                   | Reusable engineering rules and architectural decisions                                         |
| [Issue forms](.github/ISSUE_TEMPLATE/), [PR template](.github/PULL_REQUEST_TEMPLATE.md), and [feature template](docs/templates/feature-spec.md) | Intake, task handoffs, evidence, and specification authoring                                   |

Accepted feature specifications use `specs/gh-<parent-issue-number>/spec.md` when created through
the GitHub workflow. Verify that a specification directory, interface, or integration actually
exists in the checkout before relying on it. Search and inspect before editing.

An existing accepted example is the [independent Console/API specification](specs/independent-console-api/spec.md).

## Set up and verify

Select Node from [.node-version](.node-version) and npm from [package.json](package.json),
following [reproducible setup](CONTRIBUTING.md#reproducible-setup). Use the committed lockfile:

```sh
npm ci
npm run check
npm run dev
```

The README explains local addresses and optional provider behavior. Default development and
tests need no cloud credentials. Live-adapter use can cause external effects and must stay
within the task's authorization.

`npm run dev` starts both development servers. For separate builds/runs, runtime API-origin
configuration, and the Console/API artifacts, follow [independent delivery](docs/independent-delivery.md).

Use focused checks during development, then `npm run check` before handoff. Public contract
changes update the generator and run `npm run api:generate`, keeping implementation, clients,
and tests aligned. Visible UI changes need browser inspection, viewports, and screenshots.
Report the checks and results that actually ran.

## Take a task through GitHub

1. Find or open the relevant [Issue](https://github.com/siddontang/tidb.ai/issues), using the
   [native forms](https://github.com/siddontang/tidb.ai/issues/new/choose). Check ownership
   and preserve unrelated work.
2. Read the accepted specification at its Git revision, or a sufficient small-fix reproduction.
   Identify requirement IDs, dependencies, allowed changes, and the delivery endpoint.
3. Use a focused branch/checkout. Propose material requirement changes through a specification
   amendment; ordinary Issue edits do not replace the accepted baseline.
4. Open a PR with task/parent/spec links and requirement-to-evidence mapping. A design PR
   references its parent feature without prematurely closing it.
5. Review the actual candidate, run applicable checks, preserve attribution and sign-offs,
   and follow current merge policy. Record evidence before completing the promised endpoint.

The [GitHub workflow](docs/standards/github-contribution-workflow.md) owns roles, labels,
handoffs, and Issue closure. Its `/agent` comments guide the current local agent; they do not
start a model or require a new model key. Deployment needs its own configured target and authority under CI/CD
policy.

## Confirm that you are ready to contribute

Be able to identify the user problem, current implementation limits, accepted behavior and
revision, applicable standards, relevant code/tests, required checks, and authorized delivery
endpoint. Resolve missing facts from the linked sources before guessing. Bring material
unresolved product or permission decisions to the responsible maintainer while continuing
independent authorized work.

Maintain this map when architecture, source layout, document locations, or delivery status
changes. Update detailed rules in their canonical homes and adjust these links. Repository
checks verify required routing and document availability; they cannot prove that a client
loaded the documents or an agent understood them.
