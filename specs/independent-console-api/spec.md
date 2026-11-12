# Independent Console and API

> **Implementation update.** Independent delivery remains current. The Node backend, file-based storage and test paths below record the original baseline. Use the [current delivery guide](../../docs/independent-delivery.md) and [native verification](../../docs/native-backend-retirement.md).

- Feature ID: `independent-console-api`.
- Status: Accepted, revision 1, 2026-10-28.
- Intent contributor/accountable maintainer: Siddon Tang.
- Source baseline: `5aea9ed`.
- Scope: One repository, independent frontend/backend builds and processes, separate artifacts,
  runtime API configuration, generated OpenAPI client types, tests, and operating documentation.
- Risk: Deployment/authentication transport changes; existing guest and resource authorization
  must remain enforced. No production/cloud deployment or language migration is authorized by
  this specification.
- Decision: [ADR 0005](../../docs/decisions/0005-independent-console-and-api.md).

## Intended outcome and observable contract

A developer can build and run the API without Console output or frontend dependencies. A
static Console can run on a separate origin and select its compatible API without rebuilding.
An agent can use the same product API while the Console is stopped. Existing persistence,
Workspace Key grants, expiration/revocation, provider opt-in, and demo labeling remain intact.

The canonical contract precedes client code. Health, local session creation, and owner
aggregation become documented operations. Existing resource HTTP paths stay compatible.
The API root returns a structured 404 instead of serving a Console. Console request types
come from the generated contract. A bad configuration produces a retryable startup error.

Browser origins must be exact HTTP loopback origins. Credentialed CORS validates origins,
methods, and headers. Console and API use the same hostname to retain SameSite=Strict cookies.
Trusted operator configuration does not grant resource/action access. Resource regions are
capability-discovered and still validated by the backend. No provider secrets enter a client.

## Acceptance baseline

| ID       | Case and expected observation                                                                                                         | Verification                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| SPLIT-01 | Build API with no Console directory or frontend dependencies; extracted API responds to health/schema and denies unauthenticated data | `scripts/package-runtime.test.mjs`                   |
| SPLIT-02 | Extract Console alone; HTML/config work while API/schema paths return 404; runtime API origin changes without a JS rebuild            | packaging test and browser review                    |
| SPLIT-03 | Allowed separate origin completes preflight/session and owner reads; unknown/null origins cannot create sessions                      | `server/deployment.test.mjs` and browser review      |
| SPLIT-04 | Workspace Key keeps resource filtering, action restrictions, owner denial, wrong-workspace denial, expiry, and revocation             | deployment test and existing `server/api.test.mjs`   |
| SPLIT-05 | Contract/client drift fails checks; all declared non-binary JSON success operations and selected denials match schemas                | `npm run api:check`, `server/contract.test.mjs`      |
| SPLIT-06 | Client sends credentials to configured API, preserves binary upload bytes, and exposes structured/proxy errors                        | `src/api/transport.test.mjs`, provider fixture tests |
| SPLIT-07 | Artifacts have matching source SHA/checksums, with no local data, secrets, tests, opposite component, or frontend dependencies        | packaging test                                       |
| SPLIT-08 | Built Console boots across origins; SQL, file write, key management, explorer/schema links, themes and desktop/narrow layouts work    | browser verification record in PR                    |

## Delivery and recovery

Only repository changes and internal delivery artifacts are in scope. CI must be credential-free;
provider tests use fixtures. Run `npm run check`, inspect browser behavior, review the diff and
attribution, and follow the existing PR/merge policy. No public hosting target is configured.
Operate and roll back compatible component artifacts as described in
[independent delivery](../../docs/independent-delivery.md); preserve data outside artifacts.
Breaking contract changes require separate version/migration design.

## Native SQL extension

ADR 0006 extends SPLIT-01/SPLIT-07: the API now bundles mysql2 and its pinned runtime
dependency closure. It still builds independently, needs no runtime install, and excludes
Console/tooling dependencies. Packaging tests verify the actual driver loads after extraction.
This scoped change follows the owner’s real SQL request and preserves independent delivery.

## Completion evidence

The PR records the candidate SHA, checks, screenshots, and delivery outcome. Tests cover the
acceptance cases above; behavioral authorization tests complement structural schema checks.
This specification is not an automated deployment grant or a claim of production readiness.
