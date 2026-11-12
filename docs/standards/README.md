# Shared engineering standards

For first-session project context and a guided reading route, start with
[the project entry point](../../start-here.md).

These versioned documents are the project's shared memory for humans and coding agents.
Read the applicable standard before implementation. They apply to Codex, Claude Code,
Cursor, Copilot, and other tools through the root [AGENTS.md](../../AGENTS.md); no personal
plugin, skill, or conversation history is required.

Approximate product analytics is outside authoritative System State: use the separate
SlateDB service in [ADR 0050](../decisions/0050-isolated-analytics-service.md), not Meta.

Product flows and cross-page reviews also follow [product experience](product-experience.md):
consumer product clarity and care, consistent interactions and minimum complete paths to useful value.

| Task                                                                                       | Required reference                                                                                                            |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Any UI, component, typography, theme, layout, icon, or frontend dependency change          | [TiUI design system](tiui-design-system.md) and [frontend instructions](../../src/AGENTS.md)                                  |
| Capturing user feedback, reusable conventions, integration findings, or recurring mistakes | [Knowledge maintenance](knowledge-maintenance.md)                                                                             |
| Intent/specification contributions, API/agent experience, or delivery harness design       | [Intent driven contribution](intent-driven-development.md) and [feature specification template](../templates/feature-spec.md) |
| GitHub intent intake, design PRs, agent handoffs, task state, or Issue closure             | [GitHub contribution workflow](github-contribution-workflow.md)                                                               |
| Product boundaries, resources, or provider integration                                     | [Architecture](../architecture.md) and relevant [ADRs](../decisions/README.md)                                                |
| TiDB Cloud APIs, database protocols, SDKs, or CLI dependency choices                       | [TiDB Cloud integration policy](../architecture.md#tidb-cloud-integration-policy)                                             |
| Regional defaults, provider modes, or free-tier assumptions                                | [File System regions and modes](../decisions/0003-filesystem-regions-and-modes.md)                                            |
| Public authorization or credentials                                                        | [Workspace Key decision](../decisions/0001-unified-workspace-key.md)                                                          |
| SlateDB metadata, authority boundaries, transactions, recovery or scale design             | [Metadata architecture version 1](../slatedb-metadata-design.md) and [current Meta runtime](../meta-service.md)               |
| Independent Console/API builds, runtime configuration, or packaging                        | [Independent delivery](../independent-delivery.md) and [ADR 0005](../decisions/0005-independent-console-and-api.md)           |
| Test planning, classic core, risk-specific suites, or full regression                      | [Test selection](testing.md)                                                                                                  |
| Build, review, merge, release, or environment behavior                                     | [Contribution guide](../../CONTRIBUTING.md) and [CI/CD policy](../ci-cd.md)                                                   |

For live file integrations, also read [the Drive9 provider boundary](../decisions/0004-drive9-anonymous-provider.md): authenticate before provider I/O, persist credentials privately, bound preview reads, and never retry uncertain tenant creation.

For browser journeys and UI acceptance, follow [browser verification](browser-verification.md):
assert rendered behavior and request/results, use traces for diagnosis, and reserve screenshots
for visual review. Automatic gate ownership follows [ADR 0027](../decisions/0027-single-ci-evidence.md).

For every change, first choose applicable checks, reusable evidence and the delivery-time
budget using [verification scope](openapi-verification.md#choose-verification-scope-and-control-delivery-time).
The standard distinguishes accepted scope-selection guidance from current automation gaps.

For backend changes, follow [OpenAPI verification](openapi-verification.md): native HTTP
behavior, authorization, effects and recovery are the independent acceptance boundary.
Backend-only changes preserving the public contract do not require frontend/browser tests.
The same standard requires complete API paths for supported customer business capabilities;
only pure presentation/browser interactions may be UI-only. Feature specifications map the
workflow to operation IDs, permissions and native acceptance evidence.

Public API resource modeling and HTTP methods follow [REST API design](rest-api-design.md).
For Global/Region credentials, refresh, revocation and migration, also follow the
[OpenAPI security design](../../specs/gh-84/openapi-security.md) and
[ADR 0034](../decisions/0034-openapi-security-authorities.md).
Current endpoints and target migrations are distinguished explicitly; native behavior remains
the acceptance boundary.

## How to interpret a standard

- **Verified upstream fact:** includes an official source and version/date. Recheck when
  upgrading or when the installed API disagrees with the document.
- **Accepted project rule:** follows a user decision or reviewed project decision. Apply it
  within its stated scope; it is not necessarily an upstream default.
- **Proposed / unverified:** an option to investigate, not an implemented feature or binding
  requirement. State the evidence needed to resolve it.
- **Implementation status:** records what the code actually does. An accepted design can
  still be awaiting implementation.

Explicit user instructions and higher-priority tool instructions take precedence. Resolve
conflicts in the affected canonical document and record meaningful tradeoffs in an ADR.
Tool-specific entry files should route here rather than maintain competing policy copies.

The repository check validates that required documents and instruction links exist. It does
not prove that a model read them or that the UI conforms to TiUI; code and browser review do.

For database availability and direct access, follow [the public resource boundary](../decisions/0058-public-resource-kinds.md).

For File System analytics or shell tooling, read [the capability discovery](../file-analysis-discovery.md)
and [GH-26 design baseline](../../specs/gh-26/spec.md). Read [ADR 0010](../decisions/0010-read-only-file-analysis.md) for the implemented snapshot-worker boundary. Verify deployed Exec availability separately
from the native DuckDB/Bashkit snapshot workers; preserve the Workspace credential and selected-file boundaries.

For File System Analyze, follow [ADR 0014](../decisions/0014-file-analysis-engine-options.md):
file format is distinct from available methods. Discover per-engine capabilities, allow
CSV SQL or raw-text Bash explicitly, and preserve ADR 0010's single-file authorization/isolation.
For Bash path identity, follow [ADR 0015](../decisions/0015-bash-workspace-paths.md): preserve
the selected Workspace path in its virtual snapshot and use discovered metadata for safely quoted samples.
Keep initial samples filled with absolute paths; expose the quoted current-file variable only
when supported, following [ADR 0016](../decisions/0016-bash-selected-file-variable.md).

For PostgreSQL through db9, read [ADR 0011](../decisions/0011-db9-postgres.md) and
[the runtime guide](../db9-postgres.md). Preserve the private anonymous/native credential boundary
and distinguish provider compatibility limits from gateway value preservation.

For database Import, read [ADR 0023](../decisions/0023-database-import-workspace.md),
the accepted [GH-103 specification](../../specs/gh-103/spec.md) and
[verification/API usage](../database-import-verification.md). Local uploads require only the
destination query grant; Workspace files additionally require source read/analyze grants.
Preserve the explicit review, destination-bound preparation and create-only write boundaries.

For DuckDB execution over a selected File System snapshot, see [the disposable worker boundary](../decisions/0021-native-rust-computation.md). The standalone database designs are indexed under [deprecated decisions](../decisions/README.md#deprecated-decisions).

For preview-first file UI and bounded tabular samples, follow
[ADR 0017](../decisions/0017-preview-first-file-workspace.md) and the
[TiUI file workspace rule](tiui-design-system.md#theme-responsive-behavior-and-interaction).
Fixed preview uses read permission; custom SQL/Bash retains explicit analyze permission.

For backend language, module boundaries or service composition, follow [ADR 0020](../decisions/0020-modular-rust-backend.md)
and [the Rust migration contract](../../specs/gh-88/spec.md). [ADR 0059](../decisions/0059-rust-backend-workflow.md) describes the current Rust runtime, OpenAPI generation and native acceptance. Fresh record metadata follows [ADR 0024](../decisions/0024-fresh-record-metadata.md).
