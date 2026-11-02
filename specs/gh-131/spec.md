# GH-131: Classic and risk-specific test selection

- Status: proposed specification; no new profile is active until its implementation is merged.
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
