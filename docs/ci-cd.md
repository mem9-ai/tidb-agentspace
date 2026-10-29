# CI/CD and review policy

## What is implemented

- `.github/workflows/ci.yml`: clean installation and `npm run check` on PRs, pushes to
  `main`, merge-queue candidates, and manual requests. Introduced commits are also checked
  for a DCO sign-off. A successful quality job uploads the Console build directory for review.
- `.github/workflows/release.yml`: a manual, main-branch-only internal artifact build. It
  runs the same quality gate, checks commit sign-off, and packages the runtime, frontend,
  API contract, source SHA, and checksums. It does not deploy to a cloud provider.
- Exact npm dependency versions, a committed lockfile, fixed Node/npm versions, editor
  settings, Prettier, ESLint, strict TypeScript, and a generated-contract drift check.
- `scripts/check-repo.mjs` checks instruction entry points, required standards and their
  routing links, toolchain consistency, dependency pins, and baseline workflow properties.
  It supplements CI review; it is not a sandbox or a comprehensive workflow security scanner.
  Document presence does not prove an agent read the rule or that the UI conforms to TiUI;
  the [design standard](standards/tiui-design-system.md) requires code and browser evidence.

The private repository is [siddontang/tidb.ai](https://github.com/siddontang/tidb.ai).
GitHub CI is running; branch protection, deployment environments, and hosting are not
configured. At initial setup, GitHub reported that branch protection for this private
repository requires a plan upgrade. Do not change repository visibility to work around it.

## Current early-iteration merge policy

The project owner has authorized rapid iteration during the prototype phase. Agents may
mark completed draft PRs ready and merge task-scoped changes without another confirmation
or a separate human approval after all of the following are true:

- The diff has been reviewed for behavior, scope, compatibility, and credentials.
- `Quality`, `Commit sign-off`, and any other CI checks pass on the latest PR head.
- The PR has no merge conflict, and any enforced GitHub requirements are satisfied.
- Contributor attribution is preserved, with the required sign-off on created commits.

Use the reviewed head SHA as the merge precondition. Never use an administrator bypass,
submit a self-approval, weaken a check, or merge a failing dependency update to save time.
This authorization covers merging the requested work; it does not authorize unrelated
features, real cloud operations, or deployment. After merging, verify the PR state and
sync the local checkout with `main`.

## Repository settings before shared production deployment

Before shared production deployment, a repository maintainer should configure:

1. Protect `main` with a ruleset: require PRs, an independent human approval, resolution of
   review conversations, and the `Quality` and `Commit sign-off` status checks.
2. Dismiss stale approvals after new commits; require approval of the latest reviewable
   push. Block force pushes/deletion, and apply the policy to administrators where supported.
3. If a merge queue is enabled, keep the `merge_group` event so required checks run on the
   actual candidate. Require sign-off on the final squash commit if squash merging is used.
4. Limit Actions to approved sources and read-only default token permissions. Use hosted
   disposable runners for untrusted PRs. Review changes to workflows, agent rules,
   authorization, contracts, and billing as sensitive engineering changes.
5. Once actual maintainer identities are known, add `CODEOWNERS` for those areas and require
   their reviews. Do not insert invented handles or assign responsibility without agreement.
6. Set fork-workflow approval policies appropriate to the repository. Keep cloud integration
   credentials in environment secrets or workload identity, never in PR workflows.

Only repository-side protection can prevent a contributor from merging a failed PR. Agent
instructions and workflow YAML do not enable these settings. Availability depends on the
hosting plan and repository configuration.

## CI contract

The [intent driven development system](standards/intent-driven-development.md) proposes
specification acceptance, independent evaluation, persistent run evidence, and a staged
delivery harness. These extend the development model; the permissions and implemented
checks in this policy remain authoritative. Specification metadata and an agent's success
report do not grant merge or deployment rights.

Use the [GitHub contribution workflow](standards/github-contribution-workflow.md) for Issue
intake, specification/implementation PR links, and requirement evidence. A specification PR
does not close its parent feature intent. Local-agent handoff comments and labels do not replace
the review, latest-head checks, sign-offs, or hosting requirements in this policy. No automatic
agent dispatcher is installed by the Issue templates. The current local agent can perform
authorized delivery under the existing policy. Independent acceptance uses a frozen baseline
and verifiable results; it does not require a second model or model credentials in CI.

Local and remote validation both use `npm run check`. It checks runtime versions, repository
configuration, formatting, lint, API and client generation, tests, strict types, and independent
Console/API builds.
Checks run without cloud credentials. The test suite uses temporary directories and ephemeral
ports; it never reads a contributor's persisted workspace data.

The API artifact is a native Rust executable. The packaging integration test checks source identity, exclusion of private state and execution without Node. Console and native API builds remain independent; the required backend job owns Rust and real S3 checks.

The default job runs on Linux with the exact Node/npm versions. When adding OS-sensitive
behavior, add a focused macOS/Windows matrix rather than claiming all-platform coverage from
the Linux result. Contributors can use different editors and coding agents on the same
versioned codebase. Prettier/ESLint/TypeScript determine the mechanically enforced style.

Workflow actions are pinned to reviewed full commit SHAs. Dependency updates use reviewed
PRs and run the same checks. No `pull_request_target` workflow executes PR code, no PR job
receives deployment credentials, and checkout credentials are not persisted. Avoid injecting
PR titles, branch names, or other untrusted event text into shell code; pass needed values
through environment variables and validate them.

## Rust build cache and timing evidence

The Rust CI job checks formatting before compiling, then runs separately named build,
Clippy, Rust unit-test and native/S3 integration-test steps. Together these run the same
checks as local `npm run backend:check`; warnings remain errors and integration tests still
use isolated real RustFS. Two Cargo jobs and disabled debug symbols bound runner memory.

The pinned [rust-cache action](https://github.com/Swatinem/rust-cache/tree/d1527c8f67ef9af357290475d4af4b0fab8f12e0)
caches Cargo registry/git dependencies and dependency build artifacts in the actual target
directory, `meta-service/target`. It prunes workspace artifacts and incremental compilation
state; caching Cargo-installed binaries is disabled. Do not add product `.data/`, deployment
configuration, credentials or runtime state to cache paths. The action disables incremental
compilation in CI; local Cargo incremental behavior is unchanged.

The cache namespace includes the root Cargo manifest, Cargo configuration, pinned toolchain
file and `scripts/duckdb-runtime.json`. Native-library or build-configuration changes therefore
invalidate even fallback restores. The action also keys on runner OS/architecture, Rust
versions, compiler/profile environment variables, dependency manifests and lockfiles. A
lockfile update can restore compatible older dependencies; Cargo determines what to rebuild.
Keep the CI and artifact workflow's cache inputs and profile environment aligned when
upgrading them. A release-profile build would need its own cache identity and measurement.

Successful `main` runs populate the shared dependency cache. PR runs may save caches in
their own merge-ref scope for repeated validation. Under [GitHub's cache access rules](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache),
PRs can restore base/default-branch caches, but their caches cannot be restored by `main` or
other PRs. The internal artifact workflow restores compatible `main` caches without saving.
Cache availability is an optimization: an empty or evicted cache still runs the full build
and all checks. Keep the workflows' token permissions read-only.

CI builds with `--timings` and retains the HTML report from
`meta-service/target/cargo-timings/` for seven days, with a distinct artifact name per run
attempt. To evaluate a cache change, compare an initial miss with a rerun of the Rust job
on the same commit and a fresh hosted runner. Record the action's exact/fallback cache hit,
cache size, restore/save overhead, build/Clippy/test steps and total job duration. A PR-local
rerun proves same-PR reuse; verify the subsequent `main` seed separately before claiming
cross-PR reuse. Compare actual Linux CI results rather than extrapolating from a warm local
machine. Revisit the cache policy if storage/transfer cost outweighs saved compilation time.

## Commit sign-off

DCO validation checks the actual Git trailer block for an author or committer sign-off on
each introduced non-merge commit. Parse raw commit messages with `git interpret-trailers
--parse --no-divider`: Dependabot's `---` metadata separator is message content, not a patch
boundary. Only the final trailer block counts. Names and emails must match, with one explicit identity
alias: `dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>` may sign with
`Signed-off-by: dependabot[bot] <support@github.com>`. This pair was verified in the repository's
Dependabot commits on 2026-10-27 and is documented in the
[upstream report](https://github.com/dependabot/dependabot-core/issues/3480).

This recognizes an existing attestation; it does not exempt bots or generate a sign-off for
them. Unsigned messages, mismatched names, unknown aliases, unrelated bots, and sign-off text
outside the trailer block must fail. Regression tests cover both acceptance and rejection.
Preserve original author attribution. Revisit the alias only with evidence of an upstream
identity change, not to allow an arbitrary failed PR. DCO is an attestation convention, not
cryptographic signature or identity verification.

## Dependency update triage

Read the actual diff, failing step, release notes, runtime/peer requirements, and latest-head
checks before choosing to fix, close, or merge a dependency PR. A green build alone does not
establish that a new runtime API belongs in this project. Do not use `--force`,
`--legacy-peer-deps`, an unsigned bot exemption, or a blanket major-update ban as a shortcut.

The following compatibility holds are encoded in `.github/dependabot.yml`:

- Keep `@types/node` on Node 24 while `.node-version` pins Node 24; the repository check
  rejects a different major. Update the hold together with a deliberate runtime upgrade.
- Keep TypeScript below 6.1 while `typescript-eslint@8.72.1` requires `>=4.8.4 <6.1.0`.
  PR #4's clean install failed with `ERESOLVE` for TypeScript 7.0.2. Revisit this hold when
  upgrading the parser/compiler together, with a clean install and the full quality gate.

TiUI SQL Editor 0.0.6 requires React 18.3.1; keep React, React DOM, and their type definitions
on major 18 and group their updates. Revisit this hold with an editor upgrade and verification
of all transitive peers. `.npmrc` enforces strict peer resolution; never relax it to force an
upgrade. The [TiUI standard](standards/tiui-design-system.md) records this integration.

Other dependency updates remain enabled. For Actions upgrades, verify full-SHA pins and
release changes against the workflow's actual inputs/events. After fixing shared CI logic,
update affected PR branches and validate the new head before merging; rerunning an old
head does not pick up a changed script. Record closure reasons and revisit conditions.

When several PRs change the same workflow files, merge them sequentially and bring each
remaining branch up to the latest `main` before its final CI run. This validates the actual
combination and keeps the complete workflow contents visible on the PR branch. GitHub's
[OAuth scope rules](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
allow a merge without the `workflow` scope when the same workflow path and contents already
exist on another repository branch. Sync branches only through an existing authorized Git
write path, preserve sign-offs, and recheck the new head; do not bypass repository protections.

## Internal artifact delivery

Use the manual `Internal artifact` workflow on reviewed `main`. It runs the shared quality gate, builds the pinned native Rust backend and produces separate native API and static Console archives. Each includes its source SHA and component instructions; checksums cover both. Private configuration, data, provider credentials and Node business modules are excluded.

The workflow packages artifacts only. The native API runs `workspace-backend serve --config /absolute/private/deployment.json`; Console hosting and its API origin remain independent. Native builds use bounded parallelism/debug symbols and the pinned Rust toolchain. See [independent delivery](independent-delivery.md) for commands and [ADR 0024](decisions/0024-fresh-record-metadata.md) for the explicit fresh-storage boundary.

## Actual deployment policy for the next phase

A real deployment integration must define the target and identity boundary before it is
turned on. Follow this sequence:

1. Merge reviewed source after required CI passes. Build an immutable artifact associated
   with that exact source SHA; promote the same artifact across environments.
2. Deploy to an isolated staging environment with its own data, credentials, free-tier
   allocation, and integration checks. Run end-to-end authorization and cross-resource tests.
3. Promote through a protected `production` environment with required reviewers, allowed
   source branches, short-lived deployment identity, and a per-environment concurrency group.
4. Verify readiness, resource/provider connectivity, an authorized read, and denial of an
   unauthorized component request. Declare success only after the checks pass.
5. Record the deployed version, artifact checksum, environment, operator, and verification
   outcome. Roll back to the previous known-good artifact on failed health checks. Keep
   schema migrations backward compatible; destructive migrations need a separate rollout.

Automatic staging and protected production deployment are policies for the future integration,
not commands hidden inside the current artifact workflow. Add a target-specific runbook and
exercise rollback before enabling production delivery.

GitHub references: [deployment environments and concurrency](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)
and [secure use of Actions](https://docs.github.com/en/actions/reference/security/secure-use).
