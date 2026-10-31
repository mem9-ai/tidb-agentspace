# Backend OpenAPI verification

Status: accepted owner direction, [GH-55](https://github.com/mem9-ai/tidb.ai/issues/55)
(2026-10-31). Applies to backend changes and their acceptance evidence. The native Rust API
is the behavior under test; the Console is an independent consumer. This standard defines
acceptance, not a claim that finite tests prove every possible implementation equivalent.

## The acceptance boundary

For an internal backend change, preserve the accepted public HTTP behavior and verify it
directly through OpenAPI/native integration tests. Frontend/browser tests and manual Portal
retesting are not required when neither the Console nor its public contract changes. This
includes changes to Rust modules, process composition, metadata storage and provider adapters.
An unchanged schema alone is insufficient: a `200` response with wrong rows or an unauthorized
write is a regression even if its JSON validates.

The baseline consists of the reviewed specification/ADRs, generated OpenAPI and explicit
behavior assertions/fixtures at a recorded Git revision. Record the source base and evaluated
candidate in the PR. Expected answers come from the accepted behavior and fixed fixtures,
not a second business implementation. Do not remove assertions, normalize away a difference,
or update expected results merely to make an internal rewrite pass. An intentional behavior
change needs an explicitly reviewed contract/acceptance change. Update the generator,
generated client, callers and affected cases together when the public contract changes.

The current preproduction permission to replace development interfaces does not silently
change this boundary. Internal CLI/config names are distinct from the public HTTP contract.
There is no authority here to reset resources, rotate credentials or recreate provider state.

## Required behavior coverage

Each affected operation needs a deterministic successful case and its relevant failure and
boundary cases. Preserve these observable properties, including effects outside the response:

| Area                         | Acceptance assertions                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP and values              | Method/path/query/body validation; documented success and failure statuses; structured error code/details; required headers, content type, cookies and CORS; field omission versus `null`; exact string/boolean/number representation, column identity/order, limits and truncation indicators. Binary downloads compare bytes and download metadata.    |
| Authentication and isolation | Missing/invalid/expired/revoked credentials, action scopes, selected-resource grants and cross-Workspace/resource access. Denials happen before protected resource/provider I/O; authentication metadata reads remain necessary. Responses/logs do not reveal provider keys, native credentials, digests or private backing resources.                   |
| Resource lifecycle           | Provision/list/read/delete and capability availability; one creation intent across retries and restart; explicit unknown outcomes and reconciliation. Count provider calls and inspect records so an uncertain response cannot cause a second creation or an automatic SQL retry.                                                                        |
| Database operations          | Query/catalog values, dialect/type/precision handling, empty and error results, read-only restrictions, TLS validation and connection cleanup. Distinguish real driver/engine tests from fake-provider HTTP observations.                                                                                                                                |
| File operations              | Canonical path identity, listing, text/binary round trips, overwrite/create-only rules, source version/conflict handling, preview limits and read permission versus custom analyze permission. Inspect source/destination state after both success and denial.                                                                                           |
| Analysis and Execute         | Actual DuckDB/Bash execution on selected snapshots, bounded input/output/time/concurrency, cancellation and child cleanup, persistent database exclusion and read-only source isolation. User execution receives no provider/Meta credentials. Changing process layout must preserve public errors/results.                                              |
| Export and import            | Result/selected-source identity, CSV/JSON/Parquet values and binary downloads, review/prepare/confirm steps, create-only destinations, actor/destination-bound single-use tokens, source freshness and authorization rechecks, including permission changes after destination creation. No partial or repeated write is reported as an ordinary success. |
| Metadata and recovery        | Acknowledged records and private bindings survive restart using the same keys/root; concurrent conflicts and mutation resolution preserve durable outcomes. Test embedded/remote Meta composition where affected. Region continuity during Global failure is tested directly; do not depend on a browser session to establish it.                        |
| Hosting/session edges        | Host/Origin restrictions, trusted redirects, SSO callback/state/cookie behavior and regional session isolation through native HTTP fixtures. Transport-only changes still need HTTP assertions; a browser is needed only for a changed rendered journey or client contract.                                                                              |

For every changed branch, include relevant malformed input, missing object, conflict, permission
denial and upstream failure cases. Add a focused regression whenever the change exposes an
uncovered behavior. Fault injection must inspect the absence of unintended effects as well
as the returned error. Never retry a non-idempotent operation just to get a green test.

Use generated IDs, timestamps, elapsed durations and request identifiers only through declared
invariant assertions (for example format, linkage, ordering and expiry), rather than whole-body
snapshots with unstable values removed indiscriminately. Keep stable rows, paths, byte content,
permissions and error classes exact. Timing checks assert documented bounds with scheduling
tolerance, not a performance improvement without a measured baseline.

## Current executable evidence

| Evidence                                                                                                                       | What it currently establishes                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run api:check`                                                                                                            | Generator, checked-in OpenAPI and generated TypeScript client agree. It does not establish runtime behavior.                                                                                                                                                                                 |
| `server/contract.test.mjs`                                                                                                     | Starts the native API, validates declared JSON operation coverage and response schemas/statuses, including denials. Coverage is operation coverage, not every status/input combination.                                                                                                      |
| `server/rust-product.test.mjs`                                                                                                 | Native product HTTP scenarios with fixed expected values, provider call observations, binary files, actual DuckDB/Bash, import/export permission boundaries, retained bindings and lifecycle/restart recovery. Fake provider SQL responses do not prove live MySQL/PostgreSQL compatibility. |
| `server/rust-backend.test.mjs`                                                                                                 | Native authorization/expiry/revocation and Workspace isolation, embedded/remote Meta, persistence, authority separation and Global-failure behavior.                                                                                                                                         |
| `server/meta-service.test.mjs`, `server/identity-directory.test.mjs`, `server/guest-host.test.mjs`, `server/rust-sso.test.mjs` | Isolated real S3 durability/transactions plus native identity, Guest and SSO HTTP/session/restart cases. These do not establish unimplemented multi-region production HA.                                                                                                                    |
| Rust workspace tests and `backend/host/tests/execute.rs`                                                                       | Domain/parser/driver and Execute process behavior, including secret-free bounded tasks and error/cancellation handling. Add driver-specific cases when touching native protocol behavior.                                                                                                    |
| `scripts/package-runtime.test.mjs`, `server/local-runtime.test.mjs`                                                            | Clean-source/native artifact identity, execution without Node, and local orchestration. Packaging uses a committed source revision.                                                                                                                                                          |

`npm run backend:check` builds and runs all native phases, with `WORKSPACE_META_TEST=1` and
`WORKSPACE_BACKEND_TEST=1` for the integration phase. A normal `npm test` that skips those
opt-in cases does not satisfy backend acceptance. Reuse the installed RustFS binary and
isolate test roots, ports and credentials. CI uses a pinned, checksum-verified RustFS binary
and no cloud credentials. Node drives tests/tools only; do not restore a Node business oracle.

The normal `npm run check` remains shared formatting, lint, tooling/contract tests, type and
build hygiene. It does not run the browser suite. Backend-only acceptance adds
`npm run backend:check`; it does not add frontend interaction or screenshot work. Run focused
cases during development, then the final required gates on the stable candidate. Repeat
only after a relevant change, failure or unresolved concern.

## CI applicability and delivery

The trusted-base classifier in `scripts/ci-ui-scope.mjs` permits a narrow native-only path on
PR merge candidates and main pushes. At least one allowlisted native source must change;
all changed paths must be native implementation/build inputs, native fixtures or specified
backend guides. Public contracts (`backend/contracts`, the generator and generated schema),
Console/client code, npm dependencies, workflows/policy, unknown and mixed paths retain
Browser smoke. Main pushes compare the complete event `before..HEAD` range. Renames inspect
both old and new paths. Missing baselines or uncertain/manual/queue events run all checks.
This is a conservative automation rule; the PR still reviews whether public behavior changed.

For native-only changes, Browser smoke is visibly **skipped**, never reported as a passing
browser test. `Backend-only scope` succeeds only after the trusted scope result and the
same-candidate `Rust backend and S3 integration` success. It records applicability, not
another test execution. Quality and security/image checks retain their normal applicability.
The existing PR-only UI fast path remains separate; main always runs native validation.

Exact-commit delivery consumers accept the browser skip only with successful native and
`Backend-only scope` jobs from the same trusted main CI run/attempt. Missing, duplicate,
failed, neutral, cancelled or unrelated evidence still rejects. Console publication normally
needs only Quality and Browser smoke; when its latest-main source is native-only, it also
requires this native/scope evidence. See [ADR 0027](../decisions/0027-single-ci-evidence.md)
and [CI/CD](../ci-cd.md). This rule does not authorize a deployment.

## Review and handoff

State whether the change preserves or intentionally revises public behavior. List the affected
operations/invariants, their existing or new assertions, actual commands/results and candidate
SHA. Report opt-in skips and live-provider gaps explicitly. Backend-only PRs record browser
verification as **not applicable**, with the unchanged Console/contract scope as the reason.
Do not claim that API mocks tested the native backend or that a passing schema check proves
credentials, durability or external side effects are safe.

Revisit the allowlist when source ownership changes and this standard when a supported
customer contract, streaming API, new provider or deployment boundary is introduced. New
capabilities need acceptance cases before this independence rule can be relied on for them.
