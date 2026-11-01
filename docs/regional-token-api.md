# Regional Token API and local continuity

Status: opt-in native Region integration with Global policy delivery, client-bound refresh
families, local issuance/rotation/revocation and direct data authorization. The supported
single-writer profile attaches to an explicit Workspace listener. Managed multi-Workspace
Guest/SSO listeners cannot currently enable this profile; default listeners remain unchanged.
Legacy direct-Key records are retained. Fenced legacy-Key migration and same-secret Key-version
renewal across the old Key expiry remain incomplete security-design release gates.

## Serving profile

Add `security` to the existing regional Workspace API configuration. It includes:

- `publicOrigin`: exact trusted HTTPS origin (actual loopback may explicitly use HTTP).
- `environment`, `globalIssuer`, `globalSignerId`, `globalPublicKeyFile`: fixed Global trust.
- `regionalSignerId`, `regionalSigningKeyFile`, `regionalPublicKeyFile`: independent regional
  Ed25519 DER signer and hexadecimal public verification key. Startup checks the pair and rejects
  sharing the Global verification key.
- `clockDirectory`, `initializeClock`: independently durable, private host checkpoint described
  in [Global setup](global-public-api.md). Deliberate first initialization only; disable before
  restarting. The directory also retains per-Key policy floors, protecting service admission
  against an older S3 policy snapshot. Retain it across process restart and operator recovery.
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

The native OIDC fixture creates resources and credentials before enabling Global grants, then
exercises actual Global/Region HTTP, mTLS apply, token issuance, refresh enrollment, family and
token revocation, schema validation and the generated/agent clients. It kills Global API and
Global Meta, waits past a local access token expiry, performs renewal and SQL/file read/write,
restarts Region and reconnects the cached SDK, then recovers Global from the same S3/key and
checks its original Key. Existing regional Key, resource IDs, provider creation counts and
captured upstream credentials are checked for parity. SQL/files upstreams are isolated fixture
servers; these cases do not establish real cloud provider compatibility.

Current renewal only continues within the last installed Key version and hard expiry.
Renewing/rotating a Global Key advances the regional floor and denies old-version families;
proof-bound same-secret family rebind is not integrated yet. Do not claim complete SEC-05 or
zero-loss Global legacy-Key cutover until those separate state transitions and failure cases
are implemented and tested. No live credential migration or cloud outage test is authorized
by this document.
