# ADR 0027: One automatic CI gate with exact-commit consumers

- Status: accepted owner direction, GH-37 (2026-10-30).
- Scope: validation and automatic delivery orchestration; product APIs and deployment targets
  are unchanged. This supersedes the duplicated CD validation described in ADR 0026's guides.

## Context and decision

Ordinary CI and the dev CD PR workflow repeated the same normal/native checks. Console
publication repeated the normal gate again. On the GH-35 candidate, ordinary CI took 166s,
CD repeated validation took 177s, and native image verification took 26s. Jobs overlap;
these times must not be added as an end-to-end measurement.

CI owns one Quality job, the complete Rust/S3 job, Browser smoke using the Quality artifact,
and parallel credential-free native image validation when PR image inputs change. Keep
all normal/native checks; broad path-based omission of Rust validation is not introduced.

Dev CD no longer has a PR trigger or repeats tests. Its unprivileged verification job checks
trusted main CI evidence for the exact source SHA before the existing protected image-update
job can run. Full mode requires Quality, Browser smoke and Rust/S3 plus a successful complete
run. Explicit read-only inspection uses the Console gate. Console publication requires its
same-commit Quality and Browser smoke results; unrelated native work may still be running,
preserving independent Console delivery. Its `/studio/` build is a distinct base-path variant,
not another normal quality gate. Independent website tests/protection remain required.

Evidence must come from this repository's `ci.yml`, a push/manual run on main, and its newest
run/attempt for the requested SHA. Failed, cancelled, skipped, neutral, missing, ambiguous,
wrong-source, fork and PR evidence cannot satisfy a required check. Caches are build inputs,
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
Browser tests assert user-visible behavior across the shared theme/viewport matrix. Record
actual latest-head CI timings in the implementation PR; no speedup target is claimed until
observed. See [CI/CD](../ci-cd.md) and [browser verification](../standards/browser-verification.md).
