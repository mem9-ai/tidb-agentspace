# CI/CD and review policy

## What is implemented

[ADR 0026](decisions/0026-native-hosted-studio.md) makes Rust the only serving runtime. `Quality` builds the Console and checks tooling/oracles/contracts; `Rust backend and S3 integration` builds/tests all native phases. Dev CD packages a native-only Linux amd64 image, the currently verified Linux static DuckDB target. Node is not present in that image. [Native deployment](native-studio-deployment.md) defines fresh S3 roots/keys and the one-time target bootstrap.

- `.github/workflows/ci.yml`: clean installation and `npm run check` on PRs, pushes to
  `main`, merge-queue candidates, and manual requests. A successful quality job uploads
  both build directories for review.
- `.github/workflows/release.yml`: a manual, main-branch-only internal artifact build. It
  runs the same quality gate and packages the runtime, frontend,
  API contract, source SHA, and checksums. It does not deploy to a cloud provider.
- `.github/workflows/dev-cd.yml`: credential-free PR verification, then digest-pinned API
  deployment to a configured EKS dev environment on every `main` push or manual request.
  Releases only update the existing Deployment image and restore the previous digest on
  failure. [ADR 0013](decisions/0013-dev-kubernetes-cd.md) defines the existing runtime
  contract, readiness and rollback. Each repository must configure its own
  environment; checking in this workflow does not provision credentials or a cluster.
- Exact npm dependency versions, a committed lockfile, fixed Node/npm versions, editor
  settings, Prettier, ESLint, strict TypeScript, and a generated-contract drift check.
- `scripts/check-repo.mjs` checks instruction entry points, required standards and their
  routing links, toolchain consistency, dependency pins, and baseline workflow properties.
  It supplements CI review; it is not a sandbox or a comprehensive workflow security scanner.
  Document presence does not prove an agent read the rule or that the UI conforms to TiUI;
  the [design standard](standards/tiui-design-system.md) requires code and browser evidence.

The private repository is [mem9-ai/tidb.ai](https://github.com/mem9-ai/tidb.ai).
GitHub CI is running; branch protection, deployment environments, and hosting are not
configured. At initial setup, GitHub reported that branch protection for this private
repository requires a plan upgrade. Do not change repository visibility to work around it.

## Current early-iteration merge policy

The project owner has authorized rapid iteration during the prototype phase. Agents may
mark completed draft PRs ready and merge task-scoped changes without another confirmation
or a separate human approval after all of the following are true:

- The diff has been reviewed for behavior, scope, compatibility, and credentials.
- `Quality` and any other CI checks pass on the latest PR head.
- The PR has no merge conflict, and any enforced GitHub requirements are satisfied.
- Contributor attribution is preserved.

Use the reviewed head SHA as the merge precondition. Never use an administrator bypass,
submit a self-approval, weaken a check, or merge a failing dependency update to save time.
This authorization covers merging the requested work; it does not authorize unrelated
features, real cloud operations, or deployment. After merging, verify the PR state and
sync the local checkout with `main`.

## Repository settings before shared production deployment

Before shared production deployment, a repository maintainer should configure:

1. Protect `main` with a ruleset: require PRs, an independent human approval, resolution of
   review conversations, and the `Quality` status check.
2. Dismiss stale approvals after new commits; require approval of the latest reviewable
   push. Block force pushes/deletion, and apply the policy to administrators where supported.
3. If a merge queue is enabled, keep the `merge_group` event so required checks run on the
   actual candidate.
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
the review, latest-head checks, or hosting requirements in this policy. No automatic
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

## Commit metadata

CI and release workflows validate code and build artifacts, not commit trailers or author
name/email matching. The repository does not require a DCO sign-off. Preserve contributor
attribution; optional existing trailers do not affect the quality checks.

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
write path, preserve attribution, and recheck the new head; do not bypass repository protections.

## Internal artifact delivery

The manual main-only `Internal artifact` workflow runs the quality gate and packages the reviewed native API plus static Console with source SHA and checksums. The Docker/CD path independently builds the native executable. Private native plans, keys, and state stay outside artifacts. Image delivery refuses a target without the native runtime marker and only updates already bootstrapped native targets. It never resets or migrates data. Follow [native deployment](native-studio-deployment.md).

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

The configured dev API workflow implements a development target only. Protected production
deployment remains a future integration, not a command hidden inside the artifact workflow.
Exercise rollback before enabling production delivery.

GitHub references: [deployment environments and concurrency](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)
and [secure use of Actions](https://docs.github.com/en/actions/reference/security/secure-use).

## Automatic Console publication

[Console publishing](console-publishing.md) describes the main-only artifact synchronization
workflow, one-time GitHub App setup, and Netlify verification. It is separate from API CD.

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

## Native image latency and dependency caching

Measured on 2026-10-30 for [GH-17](https://github.com/mem9-ai/tidb.ai/issues/17), source baseline `c7df521`:

| Run                                                                                              | Observed time                   | Main cost                                                                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [Ordinary main CI](https://github.com/mem9-ai/tidb.ai/actions/runs/40983415209)                  | 2m 41s total; native job 2m 38s | Warm Cargo build 19s, integration tests 50s, frontend quality 1m 48s in parallel                                      |
| [Earlier dependency-update CI](https://github.com/mem9-ai/tidb.ai/actions/runs/40980092035)      | 9m 51s total                    | Native build 3m 19s, Clippy 1m 20s and integration tests 3m 53s before the latest main dependency cache was available |
| [PR native delivery verification](https://github.com/mem9-ai/tidb.ai/actions/runs/40980091991)   | 19m 41s total                   | Image build 9m 37s, after serial quality/native checks; release Cargo compiled for 8m 56s inside Docker               |
| [Previous PR delivery verification](https://github.com/mem9-ai/tidb.ai/actions/runs/40976656268) | 27m 36s total                   | Image build 13m 22s, again after the full checks                                                                      |
| [Read-only inspection](https://github.com/mem9-ai/tidb.ai/actions/runs/40979807553)              | 17m 23s total                   | 14m 01s of verification before a 28s protected inspection job, with additional job scheduling delay                   |
| [Console publication](https://github.com/mem9-ai/tidb.ai/actions/runs/40979799331)               | 9m 16s total                    | Website PR creation 2m 58s and waiting for its independent checks 1m 56s; separate from API image compilation         |

The native PR image job now runs alongside the complete quality/native gate. It has no cloud identity, does not push an image, and smoke-tests the final runtime without network access or a writable root. Main releases still require the entire quality/native gate before entering the protected deployment job. Manual `inspect` retains `npm run check` but omits native compilation/tests because it neither packages nor deploys an API. Deploy operations retain all native/S3 checks, immutable digest verification, serialization and rollback.

The SSO fixture also showed long tail latency: its main case took 180.55s in the earlier dependency-update run and 0.86s in the first optimized quality-gate run. Cleanup hooks previously closed dependencies before their API client. Cleanup now stops that API with the existing bounded process helper, closes the fake provider's active connections, then closes metadata. A live regression holds a provider response open and verifies teardown does not wait for its client watchdog; removing connection reaping makes this case fail. All authentication assertions remain intact. This changes test fixtures only, not product session timeouts or production shutdown policy.

The Dockerfile uses pinned `cargo-chef` 0.1.77 to separate the release dependency graph from application source. The same pinned Rust version, working directory, Cargo configuration, locked dependencies and verified DuckDB inputs apply to cooking and the final build. Source-only edits rebuild application crates; manifest/lockfile/toolchain/native input changes invalidate affected layers. The final build and runtime-info smoke check always validate the real executable, not the dependency skeleton.

The pinned Docker build action imports/exports GitHub cache v2 with `mode=max` under `native-api-linux-amd64-v1`, including intermediate dependency layers. Ordinary cache mounts are not sufficient to persist those layers across fresh hosted runners. Cache transfer has a three-minute bound; failed export is non-fatal and a miss still builds fully. Base images are resolved with `pull:true`. No deployment files, credentials or product state enter the Docker context or cache.

GitHub cache access restrictions still separate PR merge-ref caches from default-branch caches. A repeated PR run can reuse its own cache; a successful protected main image build seeds the default-branch cache for later PRs. Do not claim cross-PR reuse before that main seed is observed. Existing Cargo dev/test caches are independent of these release image layers. Cold/warm Linux measurements and any remaining limitations belong in the linked task/PR; the table above is the pre-optimization baseline.

References: [Docker GHA cache](https://docs.docker.com/build/cache/backends/gha/), [cache mounts and cache API v2](https://docs.docker.com/build/ci/github-actions/cache/), [cargo-chef 0.1.77](https://github.com/LukeMathWalker/cargo-chef/tree/v0.1.77).
