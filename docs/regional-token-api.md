# Regional Token API and local continuity

Status: opt-in native Region integration with Global policy delivery, client-bound refresh
families, local issuance/rotation/revocation and direct data authorization. The supported
single-writer profile supports either one explicit Workspace or the existing bounded managed
Workspace registry. Existing account/Guest listeners may opt in; a separate Token-only Region
can use `managedWorkspaceLimit` without regional Owner SSO or a Global dependency.
Legacy direct-Key records and their authority are retained; enabling this profile does not import,
rotate or replace them. Same-secret Key renewal is integrated across the previous version's
expiry. Automatic legacy-Key authority cutover remains a separate migration gate.

## Serving profile

Add `security` to the existing regional Workspace API configuration. For a standalone managed
Token listener, also set top-level `managedWorkspaceLimit` (1–4,096, for example 128). A hosted
account listener can retain its current managed composition and SSO configuration. The pool opens
only already owned regional Workspaces; it never initializes a tenant from a request URL.
`security` includes:

- `publicOrigin`: exact trusted HTTPS origin (actual loopback may explicitly use HTTP).
- `environment`, `globalIssuer`, `globalSignerId`, `globalPublicKeyFile`: fixed Global trust.
- `regionalSignerId`, `regionalSigningKeyFile`, `regionalPublicKeyFile`: independent regional
  Ed25519 DER signer and hexadecimal public verification key. Startup checks the pair and rejects
  sharing the Global verification key.
- `clockDirectory`, `initializeClock`: independently durable, private host checkpoint described
  in [Global setup](global-public-api.md). Deliberate first initialization only; disable before
  restarting. The directory also retains per-Key policy floors, protecting service admission
  against an older S3 policy snapshot. Use a writable persistent private volume, not a container
  scratch directory or read-only Secret projection; retain it across restart and recovery.
- `accessTokenTtl`: 1–900 seconds, default 900. Every token is additionally bounded by actual
  installed Key, grant and family expiry.
- `control`: a separate private TLS listener with `bind`, `certificateFile`, `privateKeyFile`,
  `clientCaFile`, and `globalClientCertificates` (exact Global service leaf certificate pins).

The public origin must be in the Workspace's trusted `publicOrigins`. This profile authenticates
bearer data credentials locally without requiring regional Owner SSO. Hosted loopback-owner
session creation remains unavailable. The same binary may combine Global and Region roles or
run them in separate processes; cloud may retain one deployment. There is no Region Global
HTTP client, token introspection, key-discovery callback or Global refresh requirement.

## Policy and data admission

Global persists exact policy intent and initiates signed mTLS delivery. Region validates the
signature, environment, audience, Workspace and concrete public resource grants. Immutable
content-addressed grants and narrowed token ceilings are committed with the Key version floor.
The current implementation serializes activation against local request authorization leases;
`applied` is returned only after old leases drain, Meta durability succeeds and the independent
host policy checkpoint is persisted. The historical internal `stored` acknowledgement remains
separate and does not satisfy public token issuance.

A data request verifies the exact local JWT issuer/audience and current Key, immutable grant,
family epoch, token denial and host policy/time checkpoints. Scoped credentials remain
non-Owner throughout existing domain/provider operations and are rechecked at their effect
boundaries. Policies, family changes and denial drain local request leases before acknowledgement.
Request leases use 64 bounded Workspace-hash lanes: applying one Workspace's policy drains its
lane, with possible bounded hash collisions; unrelated lanes continue. Managed tokens are checked
before a Workspace pool lease is selected and against the local ownership/denial policy before
data or renewal. The proof-bound credential routes do not require an Owner browser session.
This is a single-writer host guarantee, not multi-node serving consensus. Current Workspace
view and control-body limits remain; no million-resource throughput is claimed.

## Public operations

All paths are relative to `/api/v1/workspaces/{workspaceId}` on Region and are generated in
[regional OpenAPI](../public/openapi.json).

| Operation                         | Credential                                                    | Result                                                                          |
| --------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| POST `/refresh-families`          | Global-signed ticket JSON and Ed25519 `DPoP` header           | One durable family and one-time refresh credential, nonce and hard expiry       |
| POST `/token-issuances`           | `Authorization: Refresh <credential>`, proof and `keyId` JSON | Atomic local rotation, Region access token and new refresh credential/nonce     |
| GET `/refresh-families/{id}`      | Current access token belonging to the family                  | Non-secret generation/expiry/epoch status                                       |
| DELETE `/refresh-families/{id}`   | Current access token belonging to the family                  | Durable family revocation; its data tokens fail independently of other families |
| GET `/token-issuances/{id}`       | Current regional family access                                | Non-secret issuance status until its expiry                                     |
| DELETE `/access-tokens/{tokenId}` | The current access token itself                               | Scoped local denial until the token's original expiry                           |

Locations contain observation IDs, never credentials. Issuance status cannot retrieve a secret.
Global Tokens and ordinary Workspace Keys cannot administer refresh families or act as Owner
sessions. Initial Global-issued Region tokens remain separate from locally family-bound tokens.
Data tokens use the documented short-lived bearer profile; refresh is sender-constrained.
This is not a claim of a complete OAuth/DPoP implementation for access-token HTTP requests.

The refresh proof includes Ed25519 public-key binding, exact method/URI, nonce, bounded time and
replay identity. Rotation consumes proof and generation atomically. A lost reply is uncertain;
no plaintext is recovered or second generation silently minted. The declared ten-second retry
window returns an unknown outcome for authenticated prior-generation retries. Authenticated
prior-secret reuse outside it revokes that family. Invalid guesses do not revoke a family.

## Agent client

[connectAgentWorkspace](../src/api/agent-client.ts) performs initial Global exchange, validates
the Region origin, enrolls the client proof key and returns the existing typed data client.
It accepts an Ed25519 `CryptoKeyPair` and an application-provided secret-store adapter. The
adapter must use OS/application secret storage with atomic save; it must not use browser web
storage. Coordinate access to the same stored family across processes. The client serializes
refresh within one connection and never retries data writes after a failed response.

The client saves a pending one-use enrollment intent before sending it. Reconnect reuses that
exact ticket rather than creating a second family after a lost reply. Completed refresh
credentials and known routes permit reconnect without the Workspace Key or Global discovery;
access tokens remain in memory. A refresh or secret-save failure stops further automatic
attempts until explicit recovery. Cached identity/origin mismatches are rejected. Global
credentials are never sent to Region.

## Evidence and current limits

The native OIDC fixture creates resources through scoped public API authorization and captures
existing resource/provider bindings before managed-client use. It then exercises actual Global/Region HTTP, mTLS apply, token issuance, refresh enrollment, family and
token revocation, schema validation and the generated/agent clients. It kills Global API and
Global Meta, waits past a local access token expiry, performs renewal and SQL/file read/write,
restarts Region and reconnects the cached SDK, then recovers Global from the same S3/key and
checks its original Key. The same listener also serves a second real Workspace with independent
Key/family state, rejects cross-Workspace tokens, and locally refreshes both after Global loss
and Region restart. Retired regional Key denial, resource IDs, provider creation counts and
captured upstream credentials are checked for parity. SQL/files upstreams are isolated fixture
servers; these cases do not establish real cloud provider compatibility.

Same-secret expiry renewal advances the Key floor and immediately denies old access tokens.
An existing proof-bound family can cross versions only through a complete signed renewal chain.
Global records its observation after the renewal is durable; Region records its independent
installation witness after the policy commit is durable. Both observations must precede the old
expiry. Region retains these witnesses beside the independently protected policy/time checkpoints.
A new expiry alone, a missing version, late application, rotation or revocation cannot authorize
rebind. Rebind atomically consumes the old generation/proof, increments the family security epoch,
retains its original grant ceiling and returns a new refresh credential for the current version.
Lost replies keep the same unknown-outcome protocol as ordinary refresh.

The native outage case extends an enrolled Key, stops Global API and Global Meta, waits beyond
both the previous Key expiry and the local access-token expiry, then exercises local cross-version
renewal and SQL/file writes/readback. It restarts Region and resumes the same saved client without
Global or the Workspace Key. Separate cases reject actual fixed-Key expiry, a renewal not delivered
to Region, delivery after the old expiry, and missing client proof. This supplies the SEC-05
flow with a real advancing clock; it does not establish multi-node availability or live provider
compatibility. Existing Key authentication and provider credential/resource parity remain checked.

No automatic Global authority cutover or replacement of existing Keys occurs. The fenced legacy
migration and versioned keyed-index mechanics in the accepted design are not enabled by this
profile, and are not claimed by this evidence. No live credential migration or cloud outage test
is performed.

[ADR 0036](decisions/0036-global-keys-only.md) retires direct regional customer Keys.
New Keys are Global-owned; local data/refresh operations accept Region Tokens only.
See [the API guide](api-guide.md) for the short-lived curl flow and client-bound renewal.
