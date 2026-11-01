# ADR 0039: Explicit basic acceptance for manual dev releases

- Status: Accepted owner direction, 2026-11-01.
- Scope: Owner-selected manual publication to the existing single-service dev deployment.

## Context

The owner requested immediate cloud publication after basic Portal/OpenAPI acceptance,
with further product verification performed personally. Repeating full native/provider and
browser suites on PR, main and deployment makes unrelated validation the delivery critical
path. The owner also requires impact-based test selection and reusable evidence.

## Decision

Automatic API releases and the default manual mode keep the existing full CI gate. An
explicit `workflow_dispatch` deploy on `main` may select `verification:dev-smoke`. It requires
successful Quality evidence from the exact trusted main CI run/attempt. Any already failed
CI job or step rejects the release. Remaining suites continue independently; this mode does
not report them as passed or discard their results.

The protected `dev` environment, OIDC role, source SHA, native image build/runtime check,
checksummed tooling, immutable image identity, serialized single-writer update, readiness,
public health/authentication denial and existing recovery rules remain required. PR/fork
code cannot access deployment credentials, and no branch/review protection is bypassed.
The deployer reviews scope and relevant acceptance evidence before selecting this mode.

This is a development release policy, not production release authority or proof of complete
API behavior. Basic Portal and Key-to-Token-to-Region smoke verification follows publication;
the owner can perform the remaining product checks. Known failures require reconciliation.

## Consequences and migration

Existing automatic and manual callers retain full validation without changes. Only an
explicit manual deploy can choose the smaller gate; inspect/recover do not inherit it.
No resource, credential, runtime configuration or metadata migration is involved. Promote
broader evidence-reuse automation separately with input/provenance checks; do not extend
this mode to production implicitly.

## Verification

Gate tests retain exact source/main/repository/attempt trust and reject missing/failed Quality,
known failed jobs/steps and unrelated evidence. Workflow tests preserve the manual deploy
selector, full default, protected environment, immutable checkout and deployment serialization.
Existing deployment behavior tests remain the boundary for guarded mutation and health checks.
