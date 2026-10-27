# Feature specification template

Use this template for a new capability or consequential change under the
[intent driven contribution model](../standards/intent-driven-development.md). An initial
intent issue only needs the user, problem, example, and desired outcome. Maintainers can
help complete the rest before implementation. Small fixes can use a reproduction and
regression test instead.

Use the [GitHub contribution workflow](../standards/github-contribution-workflow.md) to connect
the parent intent, specification PR, task Issues, implementation PRs, and evaluation. For new
GitHub-backed features, use `GH-<parent-issue-number>` and `specs/gh-<parent-issue-number>/spec.md`.

Copy the relevant sections into `specs/<feature-id>/spec.md` when accepting a specification.
Replace guidance with concrete behavior and remove inapplicable sections with a short reason.
The metadata below is a proposed convention; no harness parser or validation command exists
yet. It must not contain credentials, personal machine paths, or executable shell instructions.

## Identity and status

| Field                                 | Value to supply                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Feature ID and title                  | Stable identifier and a concrete title                                                                 |
| Specification status and revision     | Draft, accepted, or superseded; immutable revision at execution time                                   |
| Intent and specification contributors | Attribution and links to the originating issue or proposal                                             |
| Parent intent and design PR           | GitHub Issue URL and the specification PR; preserve the parent until its delivery endpoint is complete |
| Accountable maintainer                | Assigned maintainer, or unassigned while refining                                                      |
| Source baseline and dependencies      | Git revision, required features, contracts, standards, and ADRs                                        |
| Proposed risk and reason              | Impact on users, data, permissions, billing, and operational systems                                   |
| Acceptance baseline                   | Reviewed cases, fixtures, test references, and revision                                                |

Risk classification and execution authority come from trusted policy and maintainer review.
Specification acceptance does not grant merge, cloud-operation, or deployment permission.

## User and intended outcome

Describe who needs the feature, what they are trying to accomplish, and the current obstacle.
Provide a concrete before/after example and a way to observe whether the outcome is useful.
Link relevant evidence without embedding private conversations or user data.

## Scope and non-goals

List included behaviors and explicit exclusions. Identify dependencies and which behavior
already exists. Separate product requirements from optional implementation suggestions.
Do not imply that a demo, fixture, or future provider is a live integration.

## Observable contract

For each operation, specify:

- Actor, required action/resource permissions, inputs, validation, and resource identity.
- Success response and state change, including durability and visibility to later reads.
- Failure response, stable error semantics, and whether any side effect may have occurred.
- Idempotency and retry behavior, concurrent updates, timeouts, cancellation, and recovery.
- Pagination, ordering, size/time limits, and async state transitions where relevant.
- Behavior for existing clients, persisted data, grants, and unsupported capabilities.

For HTTP changes, design the OpenAPI change and update `server/generate-openapi.mjs` during
implementation. Keep the generated contract, domain operation, adapters, and affected clients
aligned. Identify an ADR requirement for public contracts or other sensitive boundaries.

For UI changes, define relevant user states and accessibility behavior under the TiUI standard.
An API/agent path should be usable without driving the Console where the capability allows it.

## Invariants

State the rules that must remain true, including relevant authorization, cross-workspace and
cross-resource isolation, credential handling, billing, persistence, and operational limits.
Explain how to verify each one. An inapplicable concern needs a reason rather than a generic
claim that the change is safe.

## Acceptance cases

Assign stable IDs and concrete expected results. Include negative cases and plausible wrong
implementations that the cases must reject. Define observable thresholds with units and a
repeatable measurement method; avoid words such as fast or immediately without a boundary.

| ID         | Given                                  | When                                   | Expected observation                                        | Verification reference                      |
| ---------- | -------------------------------------- | -------------------------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| FEATURE-01 | Concrete initial state and actor       | An action                              | Exact response and resulting state                          | Test/assertion, fixture, or required review |
| FEATURE-02 | Missing permission or invalid input    | An attempted action                    | Defined denial and unchanged state/provider effects         | Negative test or review                     |
| FEATURE-03 | A retry, restart, or concurrent action | The relevant failure/recovery sequence | Defined durable result without unintended duplicate effects | Integration test or review                  |

Map every mandatory requirement to evidence. Identify test gaps before claiming completion.
For changed behavior, show that the new test fails against the old implementation where
practical. Consider fixture spies, failure injection, properties, and targeted mutations where
they expose meaningful defects. Do not add tests that only repeat implementation details.

## Execution boundary

Record allowed code areas, required tools, network destinations, test data, and environment.
Specify finite wall time, repair attempts, and any authorized spending/resource limits.
Identify sensitive files or behavior requiring review. Contributed metadata only requests
capabilities; trusted configuration resolves commands and grants effective permissions.

List possible external effects and how to reconcile uncertain outcomes. If none are needed,
use local fixtures. Include cancellation, cleanup, credential expiry, and orphan recovery for
any authorized live resources.

## Delivery and recovery

Define required checks, reviewers or review roles, artifact evidence, and the authorized
delivery endpoint: evaluated source, merged source, an internal artifact, or an actual release.
Use `npm run check` and applicable focused checks; include screenshots and checked viewports
for visible UI changes.

For deployment, identify the configured target, environment authority, staging acceptance,
health signals, rollback thresholds, and observation window. Distinguish code rollback from
data restoration or compensation. Keep irreversible steps explicit. If deployment is outside
scope, complete the authorized endpoint and record that scope in the result.

## Open decisions

| Decision                        | Why it matters                  | Responsible role                       | Blocks unattended execution |
| ------------------------------- | ------------------------------- | -------------------------------------- | --------------------------- |
| Unresolved behavior or boundary | User or operational consequence | Maintainer or relevant domain reviewer | Yes or no, with reason      |

Resolve material questions before unattended execution. Agents may choose local implementation
details within the accepted contract and existing standards.

## Completion evidence

Complete this section with references to independently observed results:

- Specification revision/digest, source base and candidate SHAs, acceptance/policy revisions,
  runtime, dependency lock digest, and fixtures.
- Requirement IDs mapped to check outcomes or completed reviews, including every required gap.
- Commands actually run, their results, and sanitized evidence references.
- Diff review, compatibility, documentation, contract/client alignment, and sign-offs.
- Artifact digest and delivery outcome where applicable; target health, cleanup, and recovery
  results for authorized external operations.

A report from an implementation agent is a completion claim. The delivery gate must verify
the evidence and its freshness against the actual candidate before advancing its state.
