# Contributing

Start with [the project entry point](start-here.md) to understand the product, current state,
reading route, and code/document map. This guide owns setup and contribution commands.

All contributors and coding agents follow [AGENTS.md](AGENTS.md). Humans own the
correctness and review of their changes, regardless of which agent produced them.

## Reproducible setup

Install the exact Node version in `.node-version` using your preferred version manager.
`.nvmrc` is provided for nvm users. Use npm 11.6.2, declared in `package.json`:

```sh
nvm install
nvm use
npm install --global npm@11.6.2
npm ci
npm run check
npm run dev
```

A different version manager is fine if it selects the same versions. The runtime check
fails with setup instructions when the selected versions differ. Do not change the pins
just to match one machine. Dependencies use exact versions and the committed npm lockfile.
Update the version pins, lockfile, and CI expectations together in a focused PR.
`strict-peer-deps=true` makes incompatible peers fail installation locally and in CI.
React/React DOM and their types stay on 18 while TiUI SQL Editor 0.0.6 requires React 18.3.1;
upgrade the editor and runtime together after verifying every transitive peer.
TypeScript 6.0.3 is paired with the supported range of the pinned typescript-eslint parser;
upgrade the compiler and parser together rather than independently selecting `latest`.
Keep `@types/node` on the pinned Node runtime's major. Review the compatibility holds in
`.github/dependabot.yml` when upgrading Node or typescript-eslint; see
[dependency update triage](docs/ci-cd.md#dependency-update-triage).

## Agent entry points

| Tool           | Entry point                                                                      |
| -------------- | -------------------------------------------------------------------------------- |
| Codex          | Root `AGENTS.md`                                                                 |
| Claude Code    | `CLAUDE.md` imports `AGENTS.md`                                                  |
| Cursor         | Root `AGENTS.md`, with an always-applied loader in `.cursor/rules/workspace.mdc` |
| GitHub Copilot | `.github/copilot-instructions.md` directs the agent to the shared files          |
| Other tools    | Explicitly attach/read `AGENTS.md` and this file at the start of the task        |

Check that your client actually loaded the files; support varies by version and feature.
An agent's personal memory is not a substitute for repository policy. Keep local agent
settings untracked. The product's downloadable agent connection instructions are for
API consumers and are separate from these source-code collaboration instructions.

Read the applicable documents in the [shared standards index](docs/standards/README.md).
All frontend work follows the [TiUI standard](docs/standards/tiui-design-system.md), also
linked by `src/AGENTS.md`. Follow [knowledge maintenance](docs/standards/knowledge-maintenance.md)
to preserve reusable user corrections and verified conventions in the same PR. Keep one
canonical rule and link it from agent entry points instead of copying it into each tool.

Official references: [Codex instructions](https://developers.openai.com/codex/guides/agents-md/),
[Claude memory/imports](https://code.claude.com/docs/en/memory),
[Cursor rules](https://cursor.com/docs/rules), and
[Copilot instructions](https://docs.github.com/en/copilot/concepts/prompting-and-context/custom-instructions).

## Change workflow

Contributions can start with a user problem, detailed specification, acceptance case, code,
or a harness improvement. An intent/specification contribution does not require implementing
the feature. Read [intent driven contribution](docs/standards/intent-driven-development.md)
for API-first, agent-experience and local-agent execution principles, specification acceptance,
and the repository's quality gates. Use the [feature specification template](docs/templates/feature-spec.md)
for new capabilities or consequential changes; a small fix can use a reproduction and
regression test. Existing review and merge authority remains governed by the CI/CD policy.

Start on GitHub with an [intent](https://github.com/mem9-ai/tidb.ai/issues/new?template=01-intent.yml),
[bounded task](https://github.com/mem9-ai/tidb.ai/issues/new?template=02-task.yml), or
[acceptance case](https://github.com/mem9-ai/tidb.ai/issues/new?template=03-acceptance.yml).
Follow the [GitHub contribution workflow](docs/standards/github-contribution-workflow.md):
refine the intent, merge a specification PR, implement against that revision in a separate
PR, evaluate the candidate, and complete the agreed delivery endpoint. A design PR references
the parent Issue without closing it. `/agent design` and `/agent implement` are handoff
requests for the already running local agent. Direct that session to the relevant Issue;
commenting does not start a model. Ordinary contribution uses the existing local tools and CI
without a new model key or external agent dispatcher.

1. Read the task, `AGENTS.md`, relevant code/tests, and applicable standards/architecture notes.
2. Inspect the working tree. Use a focused branch or checkout and preserve unrelated edits.
3. State the intended result and scope. For multi-person work, agree on file ownership;
   use separate checkouts instead of letting agents rewrite the same files simultaneously.
4. Implement the smallest complete change. Record important architectural decisions in
   `docs/decisions/` and reusable practices in the applicable standard; do not invent future
   APIs or label simulated behavior as integrated.
5. Run targeted checks while working, then `npm run check` before handoff.
6. Review the diff for unrelated changes, secrets, generated-file drift, and compatibility.
7. Open a focused PR using the template, with validation evidence and relevant screenshots.

Routine authorized implementation does not require a separate planning approval. Changing
product scope or operating real external resources must remain within the user's authorization.

## Coding standards

Prettier owns spacing, quotes, semicolons, and line breaks. ESLint owns unused code,
TypeScript safety basics, and React Hooks correctness. Do not spend review time manually
recreating formatter output or introduce broad `eslint-disable` / `ts-ignore` escapes.

Keep new frontend features in focused modules rather than expanding `src/App.tsx` indefinitely.
The existing prototype is a starting point, not the target module structure. Use the current
TiUI standard for real components, semantic tokens, theme ownership, and shared readability
overrides. The console now uses TiUI; reuse its shared adapters instead of rebuilding controls.
Preserve existing behavior during scoped migrations and update their status with evidence.
Keep UI text, comments, and common engineering documentation in English.

A customer uses one Workspace Key for the public REST/SDK/MCP surface. Key permissions
combine allowed actions with allowed components/resources. Backend services own the upstream
TiDB Cloud credentials. Do not require customers to supply provider keys or bypass resource
restrictions in native-data integration work.

For the backend, validate untrusted input, apply authorization before reading or mutating a
resource, and make persistence failures observable. Contract changes include the generator,
implementation, tests, and affected client types in the same PR. New dependencies need a
concrete reason; use existing platform capabilities where sufficient.

## Shared commands

| Command                                       | Purpose                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `npm ci`                                      | Install exactly the lockfile contents; validates the selected runtime          |
| `npm run format`                              | Apply the shared formatting baseline                                           |
| `npm run format:check`                        | Check formatting without edits                                                 |
| `npm run lint`                                | Check code, with zero warnings allowed                                         |
| `npm run typecheck`                           | Check strict frontend TypeScript                                               |
| `npm run build:console`                       | Build only the static Console in `dist/console/`                               |
| `npm run build:api`                           | Build the native Rust API                                                      |
| `npm run dev:console` / `npm run dev:api`     | Run either development process independently                                   |
| `npm run start:console` / `npm run start:api` | Run built Console / native Rust API separately                                 |
| `npm run api:generate`                        | Regenerate OpenAPI and Console client types from the contract source           |
| `npm run api:check`                           | Fail if OpenAPI or generated client types have drifted; does not rewrite files |
| `npm test`                                    | Run API and repository-tool behavior tests with isolated temporary data        |
| `npm run check`                               | Run the same complete quality gate used by CI                                  |

Use `npm run lint:fix` for supported mechanical fixes and review its diff. Tests must be
repeatable on clean machines and must not need cloud secrets, paid resources, or the
contributor's `.data/` directory. Add regression tests for behavior changes. For UI changes,
inspect desktop and narrow layouts, keyboard behavior, loading/error/empty states, and provide
screenshots. If a check cannot run, report the specific gap instead of claiming success.

## Rust backend modules

Use the root Cargo workspace, pinned `rust-toolchain.toml` and root `Cargo.lock`.
`npm run backend:build` verifies/prepares the pinned official static DuckDB library and builds the Rust modules. For direct Cargo commands, run `npm run backend:prepare` first; see the Rust runtime guide for supported native targets. Explicit native development launchers require
`WORKSPACE_BACKEND_CONFIG` pointing to the private regional deployment; they never fall back
to another backend or seed another data file. `npm run backend:check` runs workspace format/Clippy/tests and real isolated S3/native API tests in addition to `npm run check`. Hosted and local APIs both use Rust; [ADR 0026](docs/decisions/0026-native-hosted-studio.md) retires Node serving and permits deliberate fresh hosted storage. Node sources are regression oracles/tooling only. Fresh installations follow [ADR 0024](docs/decisions/0024-fresh-record-metadata.md), replacing the retired document/import bridge. See [the Rust guide](docs/rust-backend.md) for module composition, private plans and explicit empty-Workspace bootstrap.

`backend:check` checks formatting before compiling. Its individual phases are available as
`backend:fmt`, `backend:build`, `backend:clippy`, `backend:test` and `backend:test:integration`;
the latter requires the built executables and installed RustFS. For a compilation report,
run `npm run backend:build -- --timings`. CI runs the same complete gate in separate steps;
see [Rust cache and timing evidence](docs/ci-cd.md#rust-build-cache-and-timing-evidence) for
cache boundaries and measurement.

## Commits and review

Use `type(scope): description`, for example `feat(keys): restrict keys to selected resources`.
Preserve the contributor's actual identity and existing author attribution. Do not rewrite
commit history to change attribution without authorization.

A reviewer checks product behavior, API compatibility, authorization, credential boundaries,
and the quality of the tests. During early prototyping, the project owner has authorized
agents to merge task-scoped PRs after reviewing the diff and confirming
all CI checks pass on the latest PR head. A completed draft can be marked ready and merged
without another confirmation or a separate human approval. Do not submit a self-approval,
bypass enforced GitHub protections, or merge failing/conflicting changes. Maintainers remain
responsible for the code; CI does not replace review. Before shared production deployment,
adopt the independent review policy in `docs/ci-cd.md`.

Do not bundle unrelated formatting with a feature; the initial repository-wide formatting
baseline was explicitly part of establishing the shared standard.

## Delivery

Keep frontend and backend independently buildable and runnable in one repository. Read
[independent delivery](docs/independent-delivery.md) for configuration and packaging and
[ADR 0005](docs/decisions/0005-independent-console-and-api.md) for the accepted boundary.

See [CI/CD policy](docs/ci-cd.md). The repository is hosted at `mem9-ai/tidb.ai` and GitHub
CI is running. Branch protections, required reviewers, deployment environments, and a real
hosting target are not configured by the workflow files themselves.
