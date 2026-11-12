# ADR 0005: Independently delivered Console and Workspace API

> **Current implementation.** Independent delivery remains current. The Node backend, npm API packaging and Node contract tests below document the original implementation. Use the [Rust workflow](0059-rust-backend-workflow.md) and [current delivery guide](../independent-delivery.md).

- Status: Accepted; implemented in this change.
- Decision date: 2026-10-28.
- Evidence: The product owner requested one repository, independently built/run/deployed
  frontend and backend, and OpenAPI-first contracts with tests and documentation.
- Revisit: Production identity/hosting, a justified backend language migration, or incompatible
  API evolution. None is implied by splitting delivery artifacts.

## Context

The development servers were separate, but the API also served the built Console. Browser
requests and agent examples assumed the page origin, and one archive contained both layers.
This made replacing or releasing one client depend on the other layer's runtime packaging.

## Decision

Keep `src/` (Console), `server/` (API), and shared build/tooling in one repository. Each has
an independent build/start command and artifact. The API never serves Console assets and
runs on the pinned Node runtime without frontend dependencies. [ADR 0006](../deprecated/decisions/0006-zero-sql-gateway.md)
extends the API artifact with pinned mysql2 dependencies for real SQL, without requiring an
install when the artifact starts. The Console is static output
that selects the API origin using `/config.json` before rendering. All API examples, schema
links, file downloads, and JSON/binary operations use that origin.

Continue the existing Node ESM `.mjs` backend. API-first design does not require Go; rewriting
business rules and providers in another language is outside this deployment refactor. Backend
language is an implementation choice behind the HTTP contract. Keep backend modules separated
by responsibility rather than introducing microservices for this change.

`backend/openapi/src` remains the canonical contract source; `public/openapi.json` and
`src/api/schema.d.ts` are generated and checked for drift. Define HTTP behavior before its
Console interaction. The Console uses `openapi-fetch` with generated request/response types.
Document the existing local session, health, and Console aggregation endpoints as well as the
Workspace Key operations. Operational/session paths use their explicit API-root server override;
resource paths resolve against `/api/v1` on the API origin. Supported resource regions remain
capability-driven and backend-validated; supported region types are generated from the same contract.

The generator is isolated in `tools/api-contract`, an npm workspace with TypeScript 5.9.3:
`openapi-typescript@7.13.0` declares a `^5.x` TypeScript peer. The Console retains TypeScript
6.0.3 and strict peer resolution. This is build-time tooling only, with no generator or compiler
in either runtime archive. Revisit the tooling pin when upstream supports the Console compiler.

## Identity and compatibility

Retain the loopback-only guest prototype. Allow credentialed CORS for an exact, configurable
allowlist of HTTP loopback Console origins. Validate preflight methods/headers; never reflect
an untrusted origin or enable wildcard credentialed CORS. Session cookies remain HttpOnly and
SameSite=Strict; use the same hostname for Console and API so browser requests are same-site.
All backend scope/resource, expiry, revocation, owner, and workspace checks still apply.

The change does not implement public identity, public demo hosting, a database migration,
new cloud providers, or a deployment target. The API still binds to `127.0.0.1`. Independently
promotable artifacts are implemented; staging/production hosting remains subject to the existing
[delivery policy](../ci-cd.md) and a future identity boundary.

Existing `/api/v1` resource routes and persisted state remain compatible. Built Console serving
on port 4318 is removed: start the Console separately on port 4173. `preview` starts only the
Console. Legacy `start` continues to start the API. The former combined runtime archive is
replaced by `workspace-api.tar.gz` and `workspace-console.tar.gz`, each with source identity
and a checksum. Deploy only compatible client/server contracts; independently deployable does
not mean arbitrary breaking versions are compatible.

## Verification

- `npm run api:check` compares both generated contract and generated client to their sources.
- Type checking verifies the Console's request bodies, paths, and responses against the contract.
- `server/contract.test.mjs` validates actual successful JSON operations and selected denials
  with the contract's JSON Schemas; the file provider fixture suite covers live transfer variants.
- `server/deployment.test.mjs` covers credentialed CORS, preflights, origin rejection, and
  retained authorization across origins.
- `src/api/transport.test.mjs` checks origin selection, structured errors, credentials, and
  byte-preserving binary uploads. Binary payloads explicitly bypass JSON serialization.
- `scripts/package-runtime.test.mjs` builds the API without Console output, boots both extracted
  artifacts independently, and checks that frontend dependencies, secrets, and opposite-layer code
  are excluded.
- Browser evidence and operating commands are in [independent delivery](../independent-delivery.md).
