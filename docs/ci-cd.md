# CI/CD and review policy

## What is implemented

[ADR 0026](decisions/0026-native-hosted-studio.md) makes Rust the only serving runtime. For application changes, `Quality` builds the Console and checks Console/tooling/contracts; `Rust backend and S3 integration` builds/tests all native phases, and applicable `Browser smoke` builds the same candidate and asserts Console journeys in parallel. Documentation-only PRs use the scoped checks described below. Internal backend changes use [OpenAPI behavior verification](standards/openapi-verification.md) without frontend retesting. Dev CD packages a native-only Linux amd64 image, the currently verified Linux static DuckDB target. Node is not present in that image. [Native deployment](native-studio-deployment.md) defines fresh S3 roots/keys and the one-time target bootstrap.

- `.github/workflows/ci.yml`: clean installation and `npm run check` on non-documentation PRs, pushes to
  `main`, merge-queue candidates, and manual requests. Documentation-only PRs and verified main push ranges run scoped Quality
  checks and do not upload a Console artifact. Browser smoke builds the same SHA independently
  to avoid waiting for Quality. Native image
  verification runs in parallel for PR image-input changes.
- `.github/workflows/release.yml`: a manual, main-branch-only internal artifact build. It
  runs the same quality gate and packages the runtime, frontend,
  API contract, source SHA, and checksums. It does not deploy to a cloud provider.
- `.github/workflows/dev-cd.yml`: verifies exact-commit main CI evidence, then digest-pinned API
  deployment to a configured EKS dev environment on `main` pushes changing API/runtime or
  image build inputs, or a manual main request. Documentation/Console/tool-only commits
  retain ordinary CI and independent Console publication without releasing an API image.
  Images carry the source SHA in `org.opencontainers.image.revision`. CD validates the
  existing one-replica/Recreate target, applies an image-only resourceVersion-guarded update,
  waits for readiness and verifies public API health and unauthenticated denial. A protected,
  explicit compatibility policy can authorize recovery of the exact previous image after a
  confirmed failed rollout; `recover` also supports guarded operator-initiated recovery.
  See [ADR 0032](decisions/0032-writer-safe-dev-release.md) for fail-closed conditions and
  the remaining single-writer availability limit. Runtime configuration remains operator-owned.
- `.github/workflows/global-configure.yml`: explicit main-only, same-commit full-CI consumer
  in the protected dev environment, serialized with image deployment. It inspects only referenced
  configuration or performs an explicitly authorized fresh Global/Region configuration cutover.
  See [native deployment](native-studio-deployment.md). Ordinary image CD does not reset storage.
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

## Verification scope and waiting time

Accepted owner direction, updated 2026-11-02: default to skipping checks unrelated to the change
or already covered by applicable evidence. Run each check only for a material risk or explicit
requirement, choosing the smallest necessary set. Record required/inapplicable checks, reusable
passing evidence and the PR/main/deploy critical path following
[verification scope](standards/openapi-verification.md#choose-verification-scope-and-control-delivery-time).
CI/CD time is part of delivery cost. Optimize redundant builds/runs, cache safe unchanged
inputs and parallelize isolated work while preserving all required behavior assertions and
trusted provenance. Current automatic scope rules and exact-commit consumers below remain
implemented requirements; finer automatic operator scope and cross-commit evidence reuse
require a reviewed automation change and must not be claimed as already available.

## Current early-iteration merge policy

The project owner has authorized rapid iteration during the prototype phase. Agents may
mark completed draft PRs ready and merge task-scoped changes without another confirmation
or a separate human approval after all of the following are true:

- The diff has been reviewed for behavior, scope, compatibility, and credentials.
- `Quality` and all applicable CI checks pass on the latest PR head. A skipped Rust/S3 job
  requires the narrowly classified UI-only or documentation-only PR path. A skipped Browser
  smoke requires successful native and `Backend-only scope` jobs, or successful
  `Documentation-only scope` evidence, as described below.
- The PR has no merge conflict, and any enforced GitHub requirements are satisfied.
- Contributor attribution is preserved.

Use the reviewed head SHA as the merge precondition. Never use an administrator bypass,
submit a self-approval, weaken a check, or merge a failing dependency update to save time.
This authorization covers merging the requested work; it does not authorize unrelated
features, real cloud operations, or deployment. After merging, verify the PR state and
sync the local checkout with `main`.

## Single automatic gate and delivery consumers

[ADR 0027](decisions/0027-single-ci-evidence.md) assigns automatic checks to CI once per
candidate. For PR merge candidates and verified main push ranges, an allowlist of UI `.ts`/`.tsx`/`.css` files outside
`src/api`, their colocated unit tests, screenshot evidence, specified browser tests and reviewed
Markdown documentation may skip the Rust/S3 job. The CI/CD guide, Console publishing guide,
ADR 0027 and other standards outside the existing experience/browser exceptions remain outside
this companion allowlist. At least one UI file
must change; a backend, contract, dependency, workflow, other test or unrecognized file requires
the full job. The classifier runs the policy from the tested base, compares both sides of renames,
and falls back to full checks when the merge or policy cannot be verified. Quality and security
checks remain applicable. Main pushes use the complete `before..HEAD` range and fall back to
full checks if that baseline or policy is missing or ambiguous. Merge queues and manual runs
always execute Rust/S3. A UI-only main run is valid Console evidence but cannot satisfy a full
native release gate; an explicit full CI run on the same revision is required for that operation.
Main CI runs use independent SHA groups so later pushes do not cancel evidence awaited by
delivery. Only superseded PR/merge-queue candidates cancel.

Console publication retains its same-commit checks before building, while the build job can reuse
the lockfile-keyed npm download cache. A cache hit does not replace `npm ci` or any CI evidence.

For documentation-only PR merge candidates, a separate policy from the tested base permits
Markdown in `docs/` or `specs/`, root `README.md`, and raster evidence in `docs/screenshots/`.
If every changed path is allowlisted, `Quality` checks runtime, repository policy and formatting;
application builds and tests, native and browser jobs are inapplicable. `Documentation-only
scope` records that decision only after the applicable Quality checks succeed.
The comparison includes both sides of renames; unknown paths, source, contracts, dependencies,
workflow files, missing policy and ambiguous merge candidates fall back to both jobs. Deployment
evidence continues to require the existing same-commit checks.

The same narrow documentation allowlist applies to a main push only when its entire
`before..HEAD` range is available and the baseline is an ancestor. Renames include both paths;
missing or uncertain history falls back to full checks. Documentation-only evidence does not
authorize an API or Console release: use a full same-revision CI run when one is needed.

For native-only PR/main changes, the trusted-base policy may skip Browser smoke. At least
one allowlisted native source must change, and every path must belong to native implementation,
build inputs, native test fixtures or specified backend guides. Console/client code, public
contracts (including `backend/contracts`), npm dependencies, workflow/policy and unknown/mixed
paths retain Browser smoke. PRs use the first merge parent; main pushes use the entire event
`before..HEAD` range and the policy at `before`. Both sides of renames are checked. Missing or
non-ancestor baselines, manual and queue events default to both gates. This policy PR cannot
self-select a skip through candidate policy edits.

The `Backend-only scope` job records browser inapplicability only after trusted scope selection
and native API/S3 success. Browser smoke remains visibly skipped. This is applicability
evidence, not an additional test gate or a passing browser result. The [OpenAPI standard](standards/openapi-verification.md)
defines the required response, authorization, side-effect, failure and recovery assertions.

For PRs that only modify existing regional history modules and their Rust unit tests, the
trusted base may select the focused history integration suite. It retains real RustFS restart,
Workspace isolation, Owner and scoped-Key authorization, SSO and revocation, audit intent and
uncertain effects, HTTP redaction, contract conformance and concurrent resource idempotency.
All Rust unit tests, formatting, Clippy and native build still run. The trusted-base runner
requires each named integration test to actually pass; missing, renamed, skipped or failing
tests fail the job. Added, deleted, renamed, unknown or mixed paths, including any changes to
the test harness, contracts or workflow, run the complete integration suite. Native-change pushes,
merge queues, manual runs and release evidence always retain the full suite. The scoped PR result
cannot authorize a release.

In one local native/RustFS run, the twelve selected cases completed in about 63 seconds.
The earlier [full CI integration run](https://github.com/mem9-ai/tidb.ai/actions/runs/41382963375)
ran 134 cases in about 15 minutes and exposed SSO and index-readiness failures that were fixed.
These are different machines and workloads; the local measurement is not a CI timing guarantee.

For PRs restricted to existing, reviewed Tutorial, database or File System implementation
files, the trusted merge base can select a classic native journey plus the corresponding
risk suite. The classic cases cover scoped access, cross-Workspace isolation, restart,
database and File System sample data, SQL and Bash analysis, and tutorial progress. Database
and File System changes additionally run the relevant behavioral, permission, failure and
recovery cases in both metadata modes; Tutorial changes run progress in both modes. The
specific files and cases are pinned in `scripts/ci-classic-scope.mjs` and
`backend/build-tools/src/bin/workspace-verify.rs`. Tests, fixtures, unknown or mixed boundaries, added,
deleted or renamed files, contracts, security, workflows and selector changes run the full
integration suite. Native-change main runs, merge queues, manual runs and release evidence remain full.
The selected runner rejects missing, skipped, failing or renamed required cases, including
missing nested cases. All Rust unit tests, formatting, Clippy and native build still run.
These profiles are a conservative initial allowlist; other changes retain their existing gates.
No comparable CI timing has yet been established for the selected profiles.
After building the native backend and providing the isolated RustFS prerequisites,
`cargo acceptance classic` runs just the classic native journey locally. Use `cargo acceptance tutorial`, `cargo acceptance database` or `cargo acceptance files` for a risk-specific run.

For full PR and main-push integration runs, the trusted base can partition the unchanged full
test command into the product suites and the remaining native targets. Both groups run serially within
their own isolated runner and must pass in the same CI attempt. Unknown commands, unsupported
events and an unavailable base manifest use the original unsharded full command. The exact-SHA
release verifier requires both groups or explicit success of that full fallback; a skipped or
missing required group cannot authorize deployment. The two jobs restore the native cache
independently, but only the primary job saves it. The baseline unsharded integration step took
15m16s in [main CI at `650a196`](https://github.com/mem9-ai/tidb.ai/actions/runs/41425499855);
measure partitioned CI on comparable runners before claiming a speedup.

Dev CD no longer triggers on PRs or repeats quality/native commands. Its read-only verify
job runs `scripts/require-ci.mjs full "$SOURCE_SHA"`. In parallel, an unprivileged main-only
job warms an image cache named for that exact SHA, without publishing or deployment credentials.
The protected dev job still builds, pushes and updates only after CI succeeds; it can fall
back to the usual build if cache warming fails. Cache export failure is surfaced to the workflow
but is non-fatal: a failed prewarm selects the normal main cache. A successful prewarm selects
only its exact-SHA cache instead of importing overlapping manifests; this tests a suspected
BuildKit cache-selection issue observed when both scopes were imported. Cache contents never
count as CI evidence.
Console publishing consumes `console` evidence (Quality
and Browser smoke) before its independent `/studio/` build; unrelated Rust work can still
be running. Source freshness, website checks, protected branches and exact-tree merge checks
remain in place. The manual internal-artifact workflow retains isolated verification.
If the exact source SHA has a skipped Browser smoke job, both `console` and `full` modes
instead require successful native and `Backend-only scope` jobs in that same CI run/attempt.
This handles a later backend-only main revision selected by independent Console publication.

Console publication fetches the website without `site/releases/` blobs while preserving the
complete Git index and release subtree. All website validation and protected merge gates
remain required; the [publication guide](console-publishing.md#website-checkout-and-release-files)
owns the sparse-checkout guard, regression and timing comparison procedure.

Evidence is bound to this repository's `ci.yml`, trusted main push/manual event, exact SHA,
and newest run/attempt. Required jobs must succeed; only the explicit native-backed browser
skip above is accepted. Other skipped, missing, cancelled, ambiguous, wrong-source or untrusted
results fail closed. Caches are never evidence. Missing results
require running CI for the selected main SHA before retrying delivery. All automatic
consumers read Actions metadata with a read-only token, without deployment credentials.

[Browser verification](standards/browser-verification.md) owns DOM/URL/payload/download
assertions, isolated fixtures, focused visual review and failure traces. CI installs only
Chromium, builds the same candidate independently and uploads failed diagnostics
for seven days. One diagnostic retry is permitted, but flaky tests still fail the gate.

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

The manual main-only `Internal artifact` workflow runs the quality gate and packages the reviewed native API plus static Console with source SHA and checksums. The Docker/CD path independently builds the native executable. Private native plans, keys, and state stay outside artifacts. Image delivery updates the configured existing Deployment/container without requiring a runtime marker, waits for health and follows ADR 0032 for explicitly compatible recovery. It never resets or migrates data. Follow [native deployment](native-studio-deployment.md) for the separate operator-owned runtime configuration and checks.

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
Multi-service product fixtures hold their selected Workspace and control ports until each
host starts, so a metadata or control service cannot claim a released port and answer the
wrong readiness probe. Keep the reservations distinct from the active metadata listener,
including when that listener is subsequently restarted in-process.

Clean-restart acceptance waits for a successful process exit while the fixture continues
to serve in-flight requests. Only a deliberate crash uses the previous writer's identity
for recovery. A readiness failure should identify the Workspace, the startup or restart
phase, and the last observed health status or sanitized role-startup error.
Shutdown may interrupt background policy delivery. The next worker resumes from the
durable pending record and removes it only after confirming the Regional receipt.

The test Meta service flushes its SlateDB write-ahead log every 10 ms when its object
store uses validated loopback HTTP. This reduces the wait between sequential writes to
isolated RustFS. Every commit still waits for remote durability. Local development and
hosted storage retain SlateDB's default batching interval.

The Analytics producer test checks queue capacity and verifies that startup and enqueue
make no connection to the collector. Its one-second Linux budget measures producer
thread CPU time when scheduler accounting is available, with a wall-clock fallback.
Use workflow wall time, including waits and retries, to report delivery latency.

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
attempt. Failed runs retain their reports; superseded, cancelled runs do not delay the next
candidate by uploading obsolete reports. To evaluate a cache change, compare an initial miss with a rerun of the Rust job
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

The native PR image job now runs alongside the complete quality/native gate. It has no cloud identity, does not push an image, and smoke-tests the final runtime without network access or a writable root. Main releases still require the entire quality/native gate before entering the protected deployment job. Manual `inspect` consumes same-commit Console CI evidence and omits native compilation/tests because it neither packages nor deploys an API. Deploy operations retain all native/S3 checks, immutable digest verification and serialized image updates. Runtime configuration remains operator-owned; readiness and bounded recovery follow ADR 0032.

Automatic API release paths cover backend/metadata sources, root Cargo/toolchain/configuration inputs, verified DuckDB preparation, the generated API contract and Docker inputs. Deployment workflow, helper and test-only changes are verified in CI but do not themselves build or roll out an unchanged API image. Manual main runs default to `deploy`, which builds, pushes and updates the Deployment image after all quality/native checks pass. Read-only `inspect` and guarded `recover` must be selected explicitly. There is no build/cache-only manual operation in CD; manual deployment, inspection and recovery remain available regardless of changed paths. Runtime configuration and initialization remain [operator-owned](native-studio-deployment.md#one-time-kubernetes-cutover-and-recurring-cd), separate from CD image updates.

The SSO fixture also showed long tail latency: its main case took 180.55s in the earlier dependency-update run and 0.86s in the first optimized quality-gate run. Cleanup hooks previously closed dependencies before their API client. Cleanup now stops that API with the existing bounded process helper, closes the fake provider's active connections, then closes metadata. A live regression holds a provider response open and verifies teardown does not wait for its client watchdog; removing connection reaping makes this case fail. All authentication assertions remain intact. This changes test fixtures only, not product session timeouts or production shutdown policy.

The Dockerfile uses pinned `cargo-chef` 0.1.77 to separate the release dependency graph from application source. The same pinned Rust version, working directory, Cargo configuration, locked dependencies and verified DuckDB inputs apply to cooking and the final build. Pass the explicit `/source/meta-service/target` directory to both commands: the initial Linux probe compiled into the configured directory but cargo-chef tried to clean its default `/source/target/release` and failed. Real lower-level crates, the product layer and the API layer are built separately before the final binary, allowing unchanged lower layers to be reused on later source edits. Each stage selects the same final package to avoid rebuilding dependencies under different feature sets; earlier stages can use cargo-chef's placeholder sources for later layers. Source files are touched before their layer is compiled so Cargo cannot mistake a dependency skeleton or an old timestamp for current source; any newly added backend crate is likewise touched for the final build. Manifest/lockfile/toolchain/native input changes invalidate affected layers. The final image smoke check validates the real executable's exact version, static linkage, Linux target and pinned DuckDB checksum, rejecting an empty dependency skeleton.

For an explicit incremental-build experiment, include `[benchmark-native-cache]` in the PR
description. The unprivileged image job then makes a second local build after modifying only a
synthetic sales fixture, verifies that the lower-level build layer was reused and that the final
executable contains the changed fixture, and restores the fixture. It reports elapsed build time.
This opt-in probe runs no deployment and has no cloud credentials; ordinary PRs do not run it.
The probe establishes same-runner reuse and freshness, not a cross-run cache hit. An initial
build fully restored from remote cache may not materialize every intermediate layer locally;
the local-only probe can therefore experience a cold dependency rebuild. To verify cross-run
cache transfer without repeating this probe, include `[benchmark-cache-transfer]` in the PR
description. An unprivileged fresh-runner job then imports only the preceding image job's PR
cache and requires the final source layer to be a cache hit. It never pushes an image.

The pinned Docker build action imports/exports GitHub cache v2 with `mode=max`, including intermediate dependency layers. Main deployment continues to use `native-api-linux-amd64-v1`. PR image checks import a PR-specific scope first and the main scope as a fallback, and export only to the PR scope. This is intended to make subsequent builds of the same PR reuse its dependency layers without publishing an untrusted PR cache to main. Ordinary cache mounts are not sufficient to persist those layers across fresh hosted runners. Cache transfer has a three-minute bound; failed export is non-fatal and a miss still builds fully. Base images are resolved with `pull:true`. No deployment files, credentials or product state enter the Docker context or cache.

During PR #124, two revisions with byte-identical Cargo Chef recipes both rebuilt the dependency
layer; the second build imported a shared cache while the PR-specific cache from the prior run
existed. The second dependency cook took approximately 9.5 minutes. Separate PR and main scopes
are intended to avoid that overlap; verify the actual cache hit on a repeated PR run before
claiming a measured improvement.

GitHub cache access restrictions still separate PR merge-ref caches from default-branch caches. A repeated PR run can reuse its own cache; a successful main image release seeds the default-branch cache for later PRs. PR CI uses its own cancellable concurrency group; deploy-capable runs retain their constant non-cancellable target group. Do not claim cross-PR reuse before that main seed is observed. Existing Cargo dev/test caches are independent of these release image layers. Cold/warm Linux measurements and any remaining limitations belong in the linked task/PR; the table above is the pre-optimization baseline.

References: [Docker GHA cache](https://docs.docker.com/build/cache/backends/gha/), [cache mounts and cache API v2](https://docs.docker.com/build/ci/github-actions/cache/), [cargo-chef 0.1.77](https://github.com/LukeMathWalker/cargo-chef/tree/v0.1.77).

### Linux validation

The first successful optimized [cold image run](https://github.com/mem9-ai/tidb.ai/actions/runs/40986247771) at `5c08ebb` took 18m 41s for the image job: installing cargo-chef 1m 43s, cooking release dependencies 12m 04s, building real application crates 1m 23s and preparing/uploading the cache 2m 28s. The final image passed its network-disabled/read-only runtime check with exact pinned Linux DuckDB metadata. This is the initial cache-creation cost. Its complete quality/native gate finished in parallel in 4m 35s.

The [ordinary CI run](https://github.com/mem9-ai/tidb.ai/actions/runs/40986247801) passed on the same candidate: native job 2m 40s, all 22 native/S3 cases passed without skips, integration phase 50.38s and the main SSO case 1.01s. The held-provider-connection regression passed in 0.82s. A subsequent candidate adds only an explanatory comment to native `runtime-info` so that a fresh runner must rebuild application source while reusing the unchanged dependency recipe. [PR #18](https://github.com/mem9-ai/tidb.ai/pull/18) records that warm-source measurement and the separate main cache seed; those results must be observed before claiming them.

The [warm-source run](https://github.com/mem9-ai/tidb.ai/actions/runs/40988488887) at `5056642` confirmed dependency reuse on a fresh runner after that Rust source edit: cargo-chef installation and dependency cooking were `CACHED`, application compilation took 48.13s, cache prepare/upload 15.4s, the image build step 2m 33s and the complete image job 2m 58s. Runtime metadata validation passed. The complete quality/native gate ran alongside it in 4m 26s, replacing the earlier 19–28 minute serial verification path. Its separate [ordinary CI](https://github.com/mem9-ai/tidb.ai/actions/runs/40988488872) also passed (native job 2m 34s, Quality 2m 30s). Main cache seeding is recorded separately in the task/PR; a PR-local hit alone does not prove default-branch availability.

## Explicit manual dev smoke release

[ADR 0039](decisions/0039-dev-smoke-release.md) implements the owner's basic dev acceptance
mode. `Deploy API to dev` defaults to `verification:full`. Only a manual `deploy` on main
can select `dev-smoke`: exact-commit trusted Quality must pass and no known CI failure may
exist. The remaining native/browser jobs continue in the background. Native image build and
runtime verification, protected dev credentials, source/digest checks, serialized guarded
Deployment update, readiness and public health/auth-denial verification remain unchanged.
This is neither production release authority nor a claim that pending tests passed.

Use this mode only after reviewing the change and its relevant native/Portal/API evidence
and explicitly choosing basic dev acceptance. Ordinary automatic releases and manual
inspect/recover retain their current gates. Follow publication with the agreed basic smoke
flow and report its limits; do not add unrelated suites to the release critical path.
