# GH-131: Classic and risk-specific test selection

- Status: accepted specification. Classic and risk-specific profiles are implemented for a
  narrow set of PR changes; full-gate parallelization below is not active until its implementation
  is merged.
- Parent intent: [GH-131](https://github.com/mem9-ai/tidb.ai/issues/131).
- Accountable maintainer: project owner. Source baseline: `f33efbb03f4dbc7503a569c26c132560a2a44597`.
- Dependencies: [test selection](../../docs/standards/testing.md), [CI/CD](../../docs/ci-cd.md), and [ADR 0027](../../docs/decisions/0027-single-ci-evidence.md). The merged specification revision pins the acceptance baseline.
- Risk: changing test selection can hide security, tenant-isolation, durability or delivery regressions. It does not change customer APIs or product permissions.

## User and outcome

A contributor should get reliable feedback on ordinary changes without waiting for unrelated full regression. For example, a focused File System change runs one classic Workspace journey and File System risk cases, not both metadata modes and unrelated provider, authentication-expiry or scale scenarios. Results must show exactly what ran and what was excluded.

## Scope and boundaries

Implement the categories and journey defined by [test selection](../../docs/standards/testing.md): static/contract checks, the classic core, additive risk suites, and a full profile. Inventory actual existing cases before freezing profiles. Run each selected case once. Preserve a separately selectable full regression and the current exact-main-commit release gate. This specification does not change release authority, allow PR evidence to authorize deployment, create a new agent execution service, change customer API contracts, or introduce live cloud credentials into CI.

## Required behavior

- **TEST-1:** A recognized product change selects the classic core. It proves Workspace entry and scoped access/denial, database sample/query, File System content and bounded SQL/Bash analysis, both tutorial outcomes and resume, and one durable restart. A representative desktop browser runs when the Console journey applies; actual browser/provider fixtures are described honestly.
- **TEST-2:** Map recognized changed boundaries to authorization, metadata/recovery, database, File System, tutorial, UI, and delivery suites. Add the applicable suites and deduplicate shared cases. Explicit full requests always take precedence.
- **TEST-3:** A selector uses trusted-base policy and checks the complete change set, including both sides of renames. Unknown, mixed or cross-cutting changes, added/deleted/renamed or modified test harnesses, selectors, workflows, shared security/contract code, and missing inputs fail closed to the full relevant gate until specifically reviewed. No PR can choose its own reduced policy.
- **TEST-4:** Required cases have stable identities; an unexecuted, skipped, missing, renamed or failed case fails the selected profile. Evidence identifies source, policy, profile, case membership, outcome and runner. Compare actual wall time on comparable runners with cache state stated; do not promise an unmeasured speedup.
- **TEST-5:** Existing main, merge-queue, manual and deployment evidence requirements remain in effect. Any cross-commit reuse or release-gate change requires a separate accepted design and delivery-policy/ADR review.

## Acceptance cases

| ID     | Given and action                                                                                  | Required observation                                                                            |
| ------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| TEST-1 | Run the classic profile on an eligible product change                                             | All journey cases listed above actually pass on isolated fixtures; no required case is skipped. |
| TEST-2 | Select an eligible database or File System change, including overlapping suites                   | Core plus the relevant risk cases run once each; unrelated suites are not reported as passed.   |
| TEST-3 | Classify unknown, mixed, renamed, deleted, shared-boundary, selector, workflow or fixture changes | The full relevant gate is selected; a PR-edited selector or manifest cannot authorize a skip.   |
| TEST-4 | Remove, rename, skip or fail a required case; provide incomplete or malformed results             | The selected profile fails closed. A normal full run remains available and visibly distinct.    |
| TEST-5 | Run on main, a merge queue, a manual request or a deployment consumer                             | Existing exact-commit full-gate and trusted-evidence requirements remain unchanged.             |

Selector and runner negative tests must exercise these cases. A representative selected native profile must run against disposable real RustFS and the native API; browser journey checks use isolated fixtures and verify cross-browser progress without duplicate sample writes. Record the current candidate, actual results and timings. Existing authorization, durability, crash-recovery and no-replay assertions may not be weakened.

## Execution, delivery and evidence

Implementation is limited to test selection, checked-in tests, CI wiring and related documentation. Use local fixtures and ephemeral storage; no customer data or production writes are needed. Run `npm run check`, focused selector/runner negatives, and affected integration/browser cases; retain the existing CI requirements on the latest PR head. Review the diff, merge only after applicable CI passes, and record measured results. No deployment is implied by this specification.

The design PR must not close the parent intent. The implementation PR pins this accepted specification's full Git revision, maps TEST-1 through TEST-5 to actual evidence, and identifies any gaps. Product UI screenshots are not applicable to this test-selection-only change.

## Full-gate parallelization amendment

The owner also wants the full gate to finish sooner without reducing its coverage. In the
[main run for `650a196`](https://github.com/mem9-ai/tidb.ai/actions/runs/41425499855), the
native integration step took 15 minutes 16 seconds. The product API integration file accounted
for approximately 9 minutes 45 seconds of that sequential run; these measurements describe one
GitHub runner and do not establish a future speedup.

Allow the complete integration suite to run in two isolated jobs: the product API test file in
one and every other file from the existing full integration command in the other. Each job uses
its own disposable services, credentials and storage, and still runs its files serially. This is
parallel execution of the same full suite, not a reduced profile or permission to reuse evidence
from another candidate. Keep the local full command available and unchanged in coverage.

- **PAR-1 — complete partition:** derive the partition from a reviewed, trusted-base manifest.
  Every file in the existing full command appears exactly once across the two jobs. An unknown,
  missing, renamed, duplicate or changed membership, an unavailable trusted manifest, or an
  unsupported event uses the existing unsharded full command. Tests prove the partition and
  fallback, including additions and deletions. The initial rollout must also use this fallback
  when the trusted base predates the manifest.
- **PAR-2 — exact evidence:** release consumers accept the partitioned full gate only when both
  required jobs pass in the same trusted run, attempt and exact source SHA. A missing, failed,
  cancelled, ambiguous or unexpectedly skipped shard cannot authorize delivery. The unsharded
  fallback is accepted only when its explicit full-suite step succeeded in that same run. Preserve
  existing Quality, Browser applicability, complete-run and source checks.
- **PAR-3 — unchanged applicability:** existing PR-only classic and history profiles, UI and
  documentation scopes, and their trusted-base rules remain unchanged. Main, merge-queue and
  manual full runs continue to execute every applicable integration test. Shards never use cloud
  credentials or a privileged deployment job.
- **PAR-4 — measured delivery:** verify all tests and release-evidence negatives, then record
  comparable GitHub wall times and cache conditions. A local result or a successful shard is not
  evidence that the full gate or deployment passed. Preserve the full fallback and rollback path.

An implementation must pin the merged amendment revision and update the CI evidence checks and
workflow tests together. A design-only PR references GH-131 and does not close it.
