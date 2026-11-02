# ADR 0027: One automatic CI gate with exact-commit consumers

- Status: accepted owner direction, GH-37 (2026-10-30); UI/native scope rules updated by
  GH-55 (2026-10-31).
- Scope: validation and automatic delivery orchestration; product APIs and deployment targets
  are unchanged. This supersedes the duplicated CD validation described in ADR 0026's guides.

## Context and decision

Ordinary CI and the dev CD PR workflow repeated the same normal/native checks. Console
publication repeated the normal gate again. On the GH-35 candidate, ordinary CI took 166s,
CD repeated validation took 177s, and native image verification took 26s. Jobs overlap;
these times must not be added as an end-to-end measurement.

CI owns one Quality job, Rust/S3 validation, applicable Browser smoke building the same SHA in parallel,
and parallel credential-free native image validation when PR image inputs change. The owner
accepts a narrow PR-only UI fast path: the merge candidate's files must be exclusively
allowlisted UI files and their specified tests/guidance, with at least one UI file. The trusted
base policy classifies the candidate and defaults to full Rust/S3 checks on uncertainty. Main,
merge-queue and manual CI still run the complete native gate. See [CI/CD](../ci-cd.md).

The owner also makes native OpenAPI behavior the independent backend acceptance boundary.
Internal backend changes preserving the public contract do not need frontend testing. A
conservative trusted-base allowlist can skip Browser smoke for native-only PR/main changes;
unknown, mixed, Console, contract, policy, manual and queue changes retain it. Main pushes use
the full event `before..HEAD` range and renames include both paths. `Backend-only scope`
attests applicability only after same-candidate native success; it does not simulate a browser
pass or run duplicate tests. See [OpenAPI verification](../standards/openapi-verification.md).

Dev CD no longer has a PR trigger or repeats tests. Its unprivileged verification job checks
trusted main CI evidence for the exact source SHA before the existing protected image-update
job can run. Full mode requires Quality, applicable Browser smoke and Rust/S3 plus a successful complete
run. Explicit read-only inspection uses the Console gate. Console publication requires its
same-commit Quality and Browser smoke results; unrelated native work may still be running,
preserving independent Console delivery. Its `/studio/` build is a distinct base-path variant,
not another normal quality gate. Independent website tests/protection remain required.
For a native-only source SHA, both consumer modes accept a completed/skipped Browser smoke
only with successful `Backend-only scope` and native jobs from that exact run/attempt. This
also handles Console publication selecting a later native-only main SHA.

Evidence must come from this repository's `ci.yml`, a push/manual run on main, and its newest
run/attempt for the requested SHA. Other skipped checks, failed, cancelled, neutral, missing,
ambiguous, wrong-source, fork and PR evidence cannot satisfy a required check. Caches are build inputs,
never approval evidence. Manual recovery runs CI on the selected main revision before retrying
the consumer; it does not bypass a missing gate. The manual internal-artifact workflow keeps
its explicit isolated verification and is outside the automatic duplicate path.

## Consequences and verification

Source/build/image jobs keep read-only permissions and no deployment credentials. Consumers
gain only Actions read permission to inspect evidence. The existing protected dev environment,
serialized image-only update, immutable digest checks and operator-owned runtime recovery
remain. No `workflow_run` privileged handoff or PR deployment is introduced. Main CI runs are
independent per SHA so one release cannot cancel the evidence awaited by another consumer;
superseded PR/merge-queue candidates may cancel.

Gate tests reject untrusted/incomplete evidence and obsolete successful runs. Workflow tests
enforce gate ownership, dependency edges, PR credential exclusion and image smoke validation.
Scope/evidence tests cover native-only skips, failed/missing attestations, both rename paths
and multi-commit push ranges. Applicable browser tests assert user-visible behavior across
the shared theme/viewport matrix. Record
actual latest-head CI timings in the implementation PR; no speedup target is claimed until
observed. See [CI/CD](../ci-cd.md) and [browser verification](../standards/browser-verification.md).

## Full integration partition amendment

The accepted [GH-131 amendment](../../specs/gh-131/spec.md#full-gate-parallelization-amendment)
executes the existing full integration suite in isolated, parallel file groups when the trusted
base manifest recognizes its unchanged command. Full release evidence must prove either every
required shard succeeded or the explicitly identified complete
unsharded fallback succeeded, in the same trusted exact-SHA run and attempt. Missing or skipped
required work fails closed; caches never substitute for test evidence. Existing PR profiles,
scope rules, Quality, Browser applicability and protected deployment authority remain in force.
