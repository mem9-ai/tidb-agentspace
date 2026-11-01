# ADR 0036: Global-only Workspace Keys and a complete API entry

- Status: accepted and implemented; verification is recorded in the implementation PR.
- Date: 2026-11-01.
- Supersedes the legacy customer-Key preservation/cutover requirement in ADR 0034 and section 9 of the GH-84 baseline. Resource and upstream credential preservation still applies.

The owner authorizes deleting the old regional Workspace Keys and using the new system from scratch. There is no direct-Key compatibility or legacy verifier migration requirement. Global owns customer Keys; a Key obtains a short-lived Global or Region access token. Region accepts access tokens and proof-bound local refresh credentials. Interactive Owner sessions remain a distinct Console authority.

Delete obsolete regional Key records and digest indexes in bounded, writer-fenced batches when a Workspace opens. Resume after interruption, fail closed on cleanup failure, and never delete resource records, files, provider bindings or internal credentials. Region rejects raw Keys regardless of whether an unopened Workspace still has obsolete records. Historical object-store versions follow operator retention; this decision does not authorize deleting a shared bucket.

A single deployment may mount the Global HTTP application under a distinct API gateway path on the same listener as Region. It retains independent Global and Region metadata, signing keys, ownership and OpenAPI contracts. The front door dispatches Global routes directly to the Global application; Region data/refresh handlers do not call Global. A separate Global listener remains supported. Trusted Console origins, fixed issuers, cookie paths and validated sign-in return URLs remain explicit.

A loopback-only local Owner session is permitted for explicitly configured local Workspaces. It uses a separate encrypted Global cookie session, actual loopback peer checks and trusted origins. Hosted mode requires verified OIDC and ready Global membership; access tokens cannot administer Keys.

The Console creates and manages only Global Keys. Its API page explains both authorities, authentication, expiry/renewal, permissions, errors and retry rules, with current generated references and runnable examples. A one-off Region access token need not enroll a refresh family; long-running agents use client-bound enrollment and local renewal. Provider credentials never appear in examples or customer responses.

Acceptance includes retired endpoint/raw-Key denial, bounded cleanup and restart, resource/credential preservation, real Global issuance and Region data requests, local Owner versus hosted/Token isolation, shared-listener and separate-process cases, schema/example validation, and the complete Console Key/documentation path. Existing backend and browser gates apply to their respective changes.

Each newly created Key has a distinct agent principal, deterministically derived from its
Owner/Workspace/creation intent. Two Keys owned by one account cannot share actor-bound
preparations or setup idempotency identities. A policy update drains already admitted
regional HTTP work; pending revocation is not cancellation of an admitted multi-stage import.
After application, new admissions with old credentials fail. Native acceptance covers both.
