# Contributing

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
TypeScript 6.0.3 is paired with the supported range of the pinned typescript-eslint parser;
upgrade the compiler and parser together rather than independently selecting `latest`.

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

Official references: [Codex instructions](https://developers.openai.com/codex/guides/agents-md/),
[Claude memory/imports](https://code.claude.com/docs/en/memory),
[Cursor rules](https://cursor.com/docs/rules), and
[Copilot instructions](https://docs.github.com/en/copilot/concepts/prompting-and-context/custom-instructions).

## Change workflow

1. Read the task, `AGENTS.md`, relevant code/tests, and applicable architecture notes.
2. Inspect the working tree. Use a focused branch or checkout and preserve unrelated edits.
3. State the intended result and scope. For multi-person work, agree on file ownership;
   use separate checkouts instead of letting agents rewrite the same files simultaneously.
4. Implement the smallest complete change. Record important architectural decisions in
   `docs/decisions/`; do not invent future APIs or label simulated behavior as integrated.
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
shared primitives and semantic design tokens; integrate official TiUI components as they
become available. Keep UI text, comments, and common engineering documentation in English.

A customer uses one Workspace Key for the public REST/SDK/MCP surface. Key permissions
combine allowed actions with allowed components/resources. Backend services own the upstream
TiDB Cloud credentials. Do not require customers to supply provider keys or bypass resource
restrictions in native-data integration work.

For the backend, validate untrusted input, apply authorization before reading or mutating a
resource, and make persistence failures observable. Contract changes include the generator,
implementation, tests, and affected client types in the same PR. New dependencies need a
concrete reason; use existing platform capabilities where sufficient.

## Shared commands

| Command                              | Purpose                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `npm ci`                             | Install exactly the lockfile contents; validates the selected runtime   |
| `npm run format`                     | Apply the shared formatting baseline                                    |
| `npm run format:check`               | Check formatting without edits                                          |
| `npm run lint`                       | Check code, with zero warnings allowed                                  |
| `npm run typecheck`                  | Check strict frontend TypeScript                                        |
| `npm run api:generate`               | Regenerate `public/openapi.json` from its source                        |
| `npm run api:check`                  | Fail if the generated API contract has drifted; does not rewrite files  |
| `npm test`                           | Run API and repository-tool behavior tests with isolated temporary data |
| `npm run check`                      | Run the same complete quality gate used by CI                           |
| `npm run check:signoff -- BASE HEAD` | Check commit sign-offs for a Git revision range                         |

Use `npm run lint:fix` for supported mechanical fixes and review its diff. Tests must be
repeatable on clean machines and must not need cloud secrets, paid resources, or the
contributor's `.data/` directory. Add regression tests for behavior changes. For UI changes,
inspect desktop and narrow layouts, keyboard behavior, loading/error/empty states, and provide
screenshots. If a check cannot run, report the specific gap instead of claiming success.

## Commits and review

Use `type(scope): description`, for example `feat(keys): restrict keys to selected resources`.
Use `git commit --signoff` with your own identity. When an agent acts for Siddon, use
`siddontang@gmail.com` for the sign-off while preserving the configured name and existing
attribution. Do not configure a shared identity for other contributors.

CI checks sign-offs on introduced non-merge commits. There is no bot identity bypass:
dependency-update commits also need a valid author sign-off before merge. GitHub-generated
merge commits are excluded; a squash commit is an ordinary commit and needs its own sign-off.

A reviewer checks product behavior, API compatibility, authorization, credential boundaries,
and the quality of the tests. During early prototyping, the project owner has authorized
agents to merge task-scoped PRs after reviewing the diff, verifying sign-offs, and confirming
all CI checks pass on the latest PR head. A completed draft can be marked ready and merged
without another confirmation or a separate human approval. Do not submit a self-approval,
bypass enforced GitHub protections, or merge failing/conflicting changes. Maintainers remain
responsible for the code; CI does not replace review. Before shared production deployment,
adopt the independent review policy in `docs/ci-cd.md`.

Do not bundle unrelated formatting with a feature; the initial repository-wide formatting
baseline was explicitly part of establishing the shared standard.

## Delivery

See [CI/CD policy](docs/ci-cd.md). The repository is hosted at `siddontang/tidb.ai` and GitHub
CI is running. Branch protections, required reviewers, deployment environments, and a real
hosting target are not configured by the workflow files themselves.
