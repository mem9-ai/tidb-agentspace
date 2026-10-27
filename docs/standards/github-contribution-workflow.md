# GitHub contribution workflow

- Design baseline: 2026-10-28.
- Scope: Intent, specification, implementation, evaluation, and delivery coordination on GitHub.
- Accepted direction: GitHub Issues and PRs are the shared contribution interface, following
  the project owner's decision on this date. Humans and different agents can take successive roles.
- Available foundation: Repository documents, native Issue forms, a PR template, and a label
  definition file support the manual workflow. Automation described below remains proposed.
- Authority: Existing [CI/CD policy](../ci-cd.md) governs review, merging, and deployment.
- Revisit: After the first specification-to-implementation pilot and before enabling an event
  dispatcher, public contributor execution, or production delivery.

Use GitHub to make the whole development conversation traceable: a contributor opens an
Issue describing intent, a design contributor proposes a specification PR, and an implementer
opens a separate PR against the accepted specification. Checks and review supply the evidence
needed for delivery. The [intent driven development system](intent-driven-development.md)
defines the underlying principles and harness boundaries.

## Authoritative records

| Record                          | Purpose and authority                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| Parent intent Issue             | User problem, examples, discussion, scope decisions, and aggregate progress                 |
| Merged specification            | Accepted behavior, requirement IDs, invariants, and acceptance baseline at a Git revision   |
| Task Issue                      | One bounded implementation or evaluation assignment, dependencies, and delivery endpoint    |
| PR                              | Proposed source change, requirement-to-evidence mapping, review, and exact candidate SHA    |
| Check run and retained evidence | Independently observed results tied to candidate, spec, acceptance, and policy revisions    |
| Release or deployment record    | Actual artifact, environment, health, and recovery outcome when such delivery is configured |

Issue text is editable. New comments or edits can propose a requirement change; they do not
silently amend a merged specification. Use a specification amendment PR and invalidate affected
evidence when accepted behavior changes. A label, checked box, or completion comment is a
progress signal, not execution authority or proof that a feature works.

GitHub Projects can display the same records later. The workflow does not require Projects,
a separate planning database, a particular coding vendor, or private chat history. A future
harness still needs transactional run/lease state and isolated execution; GitHub provides the
collaboration interface and links to that evidence.

## Roles and handoffs

| Role                              | Produces                                                                       | Cannot decide alone                                            |
| --------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Intent contributor                | A concrete problem and desired result                                          | Product priority, deployment permission, or its own acceptance |
| Design contributor or agent       | Specification PR, acceptance cases, relevant ADRs, and proposed task split     | New authority or sensitive policy exceptions                   |
| Implementer or agent              | Scoped implementation PR, tests, and completion claims                         | Changes to accepted requirements or evaluator policy           |
| Evaluator and reviewer            | Requirement results, counterexamples, diff review, and compatibility findings  | Product scope changes or unauthorized release                  |
| Maintainer and trusted controller | Product decisions, assignments, accepted baselines, and authorized transitions | Bypassing hosting protections or expanding task authority      |

These are responsibilities, not a requirement to run five agents. One agent can help refine
and implement sequentially, while authoritative evaluation and release permissions remain
separate. Do not initiate parallel agents without task authorization. Independent roles also
do not imply that two bots under one GitHub account constitute independent human approval.

Each handoff references the same parent Issue and a frozen input package:

- Task Issue URL and parent intent URL; intended delivery endpoint and accountable maintainer.
- Specification permalink with its full Git SHA, requirement IDs, and acceptance baseline.
- Source base SHA, dependencies, applicable standards/ADRs, and allowed change scope.
- Trusted execution profile: tools, resource scope, risk, wall-time/attempt/cost limits.
- Active run/attempt identity and evidence references once execution begins.

An Issue cannot grant tools or credentials by filling out those fields. For manual work, the
assigned contributor records the package in the Issue or PR. A future controller validates and
persists it before dispatch. Keep secrets and unrestricted raw logs out of all GitHub records.

## Workflow from intent to delivery

### Submit and refine intent

Use the **Intent or feature proposal** form. Required input is deliberately small: user,
problem, a concrete scenario, and desired outcome. Detailed design and code are optional.
Maintainers can accept a specification-only contribution and preserve its author's credit.

Triage the Issue for product fit, existing work, priority, and missing information. Link a
duplicate to its canonical Issue. Close declined work with a reason. Neither opening an Issue
nor mentioning an agent automatically starts paid computation or grants repository writes.

### Propose the specification

A design contributor reads the parent Issue, existing architecture, applicable standards,
contracts, and tests. Open a specification PR based on the [feature template](../templates/feature-spec.md).
Use `GH-<parent-issue-number>` as the feature ID and `specs/gh-<parent-issue-number>/spec.md`
as its normal location. Existing feature IDs can be retained with an explicit parent link.

Define API semantics and the agent journey, non-goals, failure behavior, invariants, compatibility,
and numbered acceptance cases. Include an ADR where repository policy requires one. Distinguish
requirements from implementation suggestions and resolve material open questions before
unattended implementation. Case descriptions can be accepted before their test harness exists;
record that gap rather than inserting intentionally failing tests into the default quality gate.

The design PR says `Refs #<parent>`. It must not close the parent intent Issue. Reviewers assess
the intended behavior and acceptance strength. Once the PR is accepted and merged, record its
specification permalink and revision in the parent Issue. Acceptance credits the design
contribution; it does not claim that the feature has shipped.

### Prepare bounded implementation tasks

For a feature needing one implementation PR, the parent Issue can serve as its task. Split
larger work into task Issues only where each task has a clear boundary and dependency list.
Use the **Implementation or evaluation task** form to capture the frozen handoff package.
Include acceptance infrastructure as a prerequisite when needed for unattended delivery.

Tasks may cover API/domain behavior, an adapter, Console behavior, or evaluation. Avoid splitting
one invariant across independent PRs that would temporarily bypass authorization or break the
default branch. Each merged step must remain coherent; use a reviewed inactive path when
an incremental rollout requires one. Code PRs must still meet API-first and shared-domain rules.

An assignee identifies the accountable owner. It is not a concurrency lock. In the current
manual workflow, agree on ownership before starting and announce the active PR. A future
controller must serialize official runs using a lease and reject stale workers; do not assume
that simultaneous assignment/comment updates provide atomic claims.

### Implement and publish a candidate

Read the frozen specification from Git, not the latest unreviewed Issue wording. Implement in
a focused branch or checkout with isolated test data. Open a draft PR early when it helps show
ownership. Reference the task, parent intent, accepted specification, and requirement IDs.

Add meaningful regression tests and a requirement-to-evidence table. Run the shared quality
gate and applicable focused checks. Record limitations and unresolved requirements. The
implementer may propose a spec amendment separately, but cannot weaken a failed baseline to
make its PR pass. Ordinary small fixes can use an Issue/reproduction and regression test
without the full design-PR ceremony.

### Evaluate and review the actual candidate

An evaluator checks behavior against the reviewed specification and acceptance baseline,
including relevant negative cases, persistence, compatibility, and provider side effects.
Reviewers assess the diff, sensitive changes, test quality, and scope. An agent can provide
findings but must not submit a self-approval or count its comments as a required human review.

CI reports on the exact candidate. Evidence must identify the source, spec, test/fixture, and
policy revisions. Changes to relevant inputs invalidate affected results. Synchronize with
the current base or use a configured merge queue before final evaluation. Existing CI is a
quality gate; it does not yet implement independent spec evaluation or authenticated run evidence.

Within-scope defects return to implementation. Ambiguous product behavior returns to spec
refinement. Exhausted run limits or uncertain external effects require a bounded decision or
reconciliation. Preserve partial work and failure evidence rather than silently restarting.

### Merge and complete the promised endpoint

Use the current review, sign-off, latest-head, and hosting requirements in CI/CD policy. The
prototype's existing task-scoped merge authorization remains unchanged. Neither a ready
label nor successful tests extends that authority to a new environment or cloud operation.

Use `Closes #<task>` only when merging that PR completes the task's full promised endpoint.
Otherwise use `Refs #<task>`. Leaf PRs normally reference their parent intent without closing
it. GitHub's [closing-keyword behavior](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)
can close an Issue when a PR merges into the default branch; account for that behavior in both
PR descriptions and commit messages. `Refs` is an ordinary cross-reference, not a closing keyword.

The coordinator closes a parent intent only after checking all required tasks, integration
evidence, and the agreed delivery endpoint. A single PR may close a simple intent when it
fully implements it. A spec-only PR can close a separate task explicitly requesting only that
specification, while the parent feature intent remains open. An Issue closed by its author is
not evidence that delivery passed.

State the endpoint precisely: merged source, a reviewed internal artifact, or a verified release.
Deployment is separate from merging and requires configured environment authority and recovery
checks. Regression or incomplete delivery reopens work with links to the failed requirements.

## Status and label conventions

The repository label definitions are in [contribution-labels.json](../../.github/contribution-labels.json).
Apply one `kind:*` label and one active `stage:*` label to an open tracked Issue. `blocked` is
an overlay that preserves the stage and records the blocking dependency or decision.

| Stage label          | Meaning                                           | Condition for advancing                                               |
| -------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| `stage:triage`       | Intent, task, or counterexample awaits assessment | Product fit and next work are identified                              |
| `stage:design`       | Behavior or acceptance is being refined           | Accepted specification or a sufficient small-fix reproduction exists  |
| `stage:ready`        | Bounded work can be claimed                       | Current spec/baseline, dependencies, owner, and authority are checked |
| `stage:implementing` | An owner is preparing the candidate               | A reviewable PR and evidence are available                            |
| `stage:review`       | Evaluation, review, or integration is in progress | Applicable gates and the promised delivery endpoint are satisfied     |
| `stage:done`         | The promised endpoint is verified                 | Record evidence and close completed work                              |

Kinds are `kind:intent`, `kind:task`, and `kind:acceptance`. A parent intent's stage summarizes
its aggregate progress; child Issues retain their own stages. Declined/duplicate work closes
with a reason and has its stage label removed rather than being marked delivered. Apply the
same convention to a cancelled task whose endpoint was not completed.

Until a controller exists, maintainers update these labels manually and review unusual or
contradictory states. Form labels provide intake defaults; they do not validate completeness
or enforce legal transitions. The accepted Git revision and delivery evidence take precedence
over labels, title prefixes, or a manually edited project board.

## Proposed event and command protocol

No command below is installed by these templates. They define the next controller interface.

| Proposed request   | Required inputs and authority                                                     | Result                                                     |
| ------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `/agent design`    | Intent Issue; authorized dispatcher and finite run profile                        | Design run and a specification PR referencing the intent   |
| `/agent implement` | Task, accepted spec SHA, source base, acceptance baseline, satisfied dependencies | One bounded run and candidate PR                           |
| `/agent evaluate`  | PR and expected head SHA; trusted baseline and evaluator profile                  | Requirement results and check/evidence references          |
| `/agent cancel`    | Run ID; authorized maintainer or permitted run owner                              | Stop new work, reconcile in-flight effects, record cleanup |

Use a GitHub App webhook/controller or a small reviewed event-ingress workflow to authenticate
and normalize requests. Resolve current repository permissions from GitHub; a name, mention,
`author_association`, label, or a statement inside a comment is insufficient. Dispatch only
commands explicitly permitted for that actor and task. Agent-generated requests require a
separately authorized service identity and bounded routing policy; bots cannot authorize one
another simply by exchanging comments. This also prevents endless agent-to-agent loops.

An `issue_comment` workflow observes the default-branch context, not the commented PR's head.
The [event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#issue_comment)
also requires the workflow to exist on the default branch. Resolve and verify candidate refs
explicitly. Keep ingress separate from candidate-code execution, use structured arguments,
and never interpolate comment bodies into shell scripts. Follow GitHub's [secure workflow guidance](https://docs.github.com/en/actions/reference/security/secure-use)
and the repository prohibition on privileged execution of untrusted PR code.

The trusted dispatcher must:

- Deduplicate webhook delivery IDs and semantic requests by repository, task, command, spec
  revision, and candidate revision. A retry resumes or returns the existing run.
- Accept explicit command creation, not automatic re-execution on a comment edit. Recheck
  current authority and relevant source state before dispatch and privileged transitions.
- Acquire a transactional lease with an expiry and fencing token for each active task/run.
  Only the current token can publish authoritative results or advance delivery. Recover or
  reconcile an apparently expired worker before granting a conflicting run.
- Fetch accepted specs/policy from trusted revisions. Keep Issue/PR text and candidate source
  as untrusted data. Never execute candidate tests or dependency installation in the privileged
  dispatcher, or share production secrets and privileged caches with a worker.
- Enforce finite time, attempts, cost, and output limits; cancel superseded candidate runs and
  record state after a crash. Reject stale evidence and expected-head mismatches.
- Keep writes narrow: a publishing service posts the candidate branch/PR, an evaluator reports
  verified results, and a merge/deployment integration has its own authority. A worker receives
  neither a broad repository token nor deployment credentials.

Post concise progress at state transitions, a material failure, or a needed decision. Each
status identifies the task, run, input revisions, PR, next action, and evidence. Avoid dumping
internal conversations or repeated unchanged status. Sanitize public outputs and respect the
repository's visibility. Artifacts need explicit retention; after evidence expires, required
verification must be restored before relying on it for a later delivery decision.

## Adoption and verification

| Stage                  | Deliverable and exit evidence                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Manual foundation      | Intent/task/acceptance forms, labels, PR links, and this procedure; demonstrate one Issue-to-PR change                               |
| Specification pilot    | One intent produces an accepted design PR and a separate implementation PR; parent closes only after full acceptance                 |
| Trusted dispatcher     | Authenticated commands, deduplication, leases, budgets, and disposable workers; verify restart/cancellation and containment          |
| Independent evaluation | Frozen acceptance suite, candidate-bound evidence, freshness rules, and review routing; reject plausible wrong implementations       |
| Delivery automation    | Latest-candidate checks and authorized merge; add protected deployment only after its target, identity, and recovery are implemented |

Controller regression scenarios must include unauthorized comments, edited/replayed commands,
duplicate deliveries, an Issue edited after spec acceptance, two competing claims, expired
leases, stale PR heads, cancelled workers, a worker trying to alter its baseline, and a
design-only PR that would prematurely close the parent. Also test that expired/missing
evidence blocks completion and that closing an Issue does not bypass evaluation.

The native [Issue forms](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms)
are editable intake documents. YAML parsing, required fields, and label definitions can be
checked locally, but GitHub rendering and repository permissions must be checked on GitHub.
These templates do not install a bot, execute an agent, enforce a lease, or configure branch
protection. Implement those capabilities as focused subsequent changes with the relevant
tests and authorization.
