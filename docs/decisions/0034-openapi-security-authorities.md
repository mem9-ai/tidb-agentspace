# ADR 0034: Global Key authority and independently serving Regions

- Status: Owner-confirmed direction; detailed protocol and operational defaults proposed, not implemented.
- Date: 2026-10-31.
- Scope: Public API credentials, regional autonomy, distributed policy/revocation and non-destructive migration.
- Detailed design and acceptance: [OpenAPI security](../../specs/gh-84/openapi-security.md); implementation remains [GH-84](https://github.com/mem9-ai/tidb.ai/issues/84).

## Decision

Global owns customer-facing Workspace Keys and their versioned grants. A customer uses one Key
to obtain scoped Global or Region access tokens. Global and every Region expose distinct public
API authorities; data calls go directly to Region. Region validates its tokens and effective
policy locally, and an explicitly enrolled regional client can refresh locally while Global is
unavailable. Global initiates all cross-plane policy delivery and observation through the
authenticated encrypted control channel; Region does not call back to Global.

Key rotation, revocation, actual expiry and grant changes bound every descendant token and
refresh family. A Region applies locally received denial/version floors immediately. Global
tracks per-Region application separately from Global intent. An unreachable Region remains
pending; regional availability during a partition is incompatible with an unconditional claim
of immediate global revocation. Policy synchronization age never implicitly expires access.

Existing Key secret, ID, exact grants, expiry and resource/provider bindings are preserved.
Migration adds versioned records and controlled authority fencing with parity verification;
it does not recreate resources, recover plaintext or rotate customer credentials by default.

## Status and verification

The running prototype has regional Key authorization and limited region-local account sessions.
The multi-origin discovery/token issuance/renewal, policy distribution and migration described
here remain implementation work. `SEC-01` through `SEC-09` in the detailed design are required
native API evidence; separate implementation changes must update OpenAPI and client contracts.
No deployment or live credential operation follows from this decision.
