# Shared engineering standards

For first-session project context and a guided reading route, start with
[the project entry point](../../start-here.md).

These versioned documents are the project's shared memory for humans and coding agents.
Read the applicable standard before implementation. They apply to Codex, Claude Code,
Cursor, Copilot, and other tools through the root [AGENTS.md](../../AGENTS.md); no personal
plugin, skill, or conversation history is required.

| Task                                                                                       | Required reference                                                                                                            |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Any UI, component, typography, theme, layout, icon, or frontend dependency change          | [TiUI design system](tiui-design-system.md) and [frontend instructions](../../src/AGENTS.md)                                  |
| Capturing user feedback, reusable conventions, integration findings, or recurring mistakes | [Knowledge maintenance](knowledge-maintenance.md)                                                                             |
| Intent/specification contributions, API/agent experience, or delivery harness design       | [Intent driven contribution](intent-driven-development.md) and [feature specification template](../templates/feature-spec.md) |
| GitHub intent intake, design PRs, agent handoffs, task state, or Issue closure             | [GitHub contribution workflow](github-contribution-workflow.md)                                                               |
| Product boundaries, resources, or provider integration                                     | [Architecture](../architecture.md) and relevant [ADRs](../decisions/README.md)                                                |
| Regional defaults, provider modes, or free-tier assumptions                                | [File System regions and modes](../decisions/0003-filesystem-regions-and-modes.md)                                            |
| Public authorization or credentials                                                        | [Workspace Key decision](../decisions/0001-unified-workspace-key.md)                                                          |
| Independent Console/API builds, runtime configuration, or packaging                        | [Independent delivery](../independent-delivery.md) and [ADR 0005](../decisions/0005-independent-console-and-api.md)           |
| Build, review, merge, release, or environment behavior                                     | [Contribution guide](../../CONTRIBUTING.md) and [CI/CD policy](../ci-cd.md)                                                   |

For live file integrations, also read [the Drive9 provider boundary](../decisions/0004-drive9-anonymous-provider.md): authenticate before provider I/O, persist credentials privately, bound preview reads, and never retry uncertain tenant creation.

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

For database integration, read [the Zero SQL boundary](../decisions/0006-zero-sql-gateway.md): anonymous provisioning, private database-scoped credentials, expiry and recovery, verified TLS, bounded sessions, and no automatic SQL retries.
