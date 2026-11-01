# Global public API

Status: independent Global HTTP role implemented for Owner login, Key lifecycle, Global Token
issuance and authorized Region discovery, plus signed regional policy delivery and Region-bound
Token/enrollment issuance when the matching Region acknowledges application. See
[regional Token integration](regional-token-api.md) for the required Region configuration and
existing-credential boundary. The accepted
[security design](../specs/gh-84/openapi-security.md) remains the full delivery boundary.

The Global role runs in the same `workspace-backend` binary as Region and Meta roles. A single
cloud deployment can combine them; local acceptance can use separate processes. Data APIs are
absent from Global. [Global OpenAPI](../public/global-openapi.json) describes its distinct
contract; [regional OpenAPI](../public/openapi.json) continues to describe the existing data
service. `npm run api:generate` generates both contracts and TypeScript schemas.

## Configuration and startup

Add `{ "kind": "global", "configFile": "/srv/private/global-api.json" }` to a deployment
plan, or put only that role in a separate plan. Every private file uses absolute references
and owner-only permissions. Example configuration:

```json
{
  "bind": "127.0.0.1:4320",
  "metadata": { "transport": "inProcess", "authorityId": "global" },
  "publicOrigin": "http://127.0.0.1:4320",
  "environment": "test",
  "signerId": "global-access-1",
  "signingKeyFile": "/srv/private/global-access.der",
  "verificationKeyFile": "/srv/private/global-access.pub",
  "clockDirectory": "/srv/private/global-clock",
  "initializeClock": false,
  "regions": [
    {
      "regionId": "region:local",
      "apiOrigin": "http://127.0.0.1:4318",
      "apiPathPrefix": ""
    }
  ],
  "sso": null
}
```

The signer is an Ed25519 private key in DER form; its public file is a 32-byte hexadecimal
verification key. Startup verifies the pair. Provision these independently from Meta
credentials and retain protected backups; no development test key is a deployment key.
For a separate Global process use the existing `remote` Meta binding with its Global authority
and authenticated TLS configuration. Never bind Global to Region Meta.

Set `initializeClock` true only for deliberate creation of a new, absent clock directory,
then change it to false before restart. The private host checkpoint uses an exclusive file
lock and durable time floor independent of Meta/S3. Missing checkpoints and backward host time
fail closed; startup never silently recreates them. The host clock and independent checkpoint
storage are trusted deployment dependencies. This single-host checkpoint is not a claim of
multi-host consensus or protection against restoring both host storage and S3 to old snapshots.

`publicOrigin` is an exact HTTPS origin for hosted use; HTTP is accepted only on an actual
loopback listener. Trusted ingress must preserve the configured Host. Global verifies Host,
Origin and duplicate authentication headers, bounds request size/concurrency/time, disables
credential caching and serves its own contract at `/openapi.json`.

## Owner login and Key operations

Configure `sso` using the existing verified OIDC+PKCE profile, with an exact Global-origin
`/api/auth/tidbcloud/callback`. Shared-owner allowlists are rejected. Start login through
`GET /api/auth/tidbcloud/login?workspaceId=...`. A successful callback issues a durable,
Workspace-bound, host-only, HttpOnly eight-hour `aw_global_owner` cookie only after checking
ready membership in the Global Directory. Secure is required on HTTPS. Pending flows remain
process-local, single-use and ten-minute bounded. Existing verified Directory accounts are
supported; importing or adopting a legacy shared Workspace is not implemented by this role.
Logout durably revokes the session and clears its cookie.

Key creation/list/detail, version rotation, expiry renewal and revocation are Owner-only.
Mutations require the exact Global Origin and a UUID `Idempotency-Key`; changes also require
a quoted version `If-Match`. A one-time secret is never retrieved or returned on replay.
Unknown outcomes must be reconciled without blind secret-producing retries. Exact grants
are stored in encrypted Global metadata. Owner revocation/renewal changes Global state;
regional propagation reports applied or pending independently. An unavailable Region remains
pending; a subsequent authorized regional issuance resumes delivery without changing the Key.

Pending policy delivery has an explicit Owner recovery path. `POST /key-policy-deliveries`
with `keyId`, the current `keyVersion`, Origin and Idempotency-Key creates a bounded application
attempt, including for revoked Keys. Repeating the same attempt reconciles the same signed intent;
`GET /key-policy-deliveries/{id}` only observes durable evidence. Responses distinguish
`regionalStatus` (pending/applied) and `regionalContinuity` (pending/eligible/unavailable).
A renewed Key enables existing families to cross versions only when both authorities observed the
completed renewal before the previous expiry. A late applied policy permits fresh enrollment,
but cannot reinstate an expired family transition proof. GET never retries policy effects.

`POST /api/v1/workspaces/{workspaceId}/token-issuances` accepts a Workspace Key only in its
Authorization header, and supports `audience: global` or the Key's exact granted Region ID. Region issuance requires
an Ed25519 client public-key thumbprint and installed grant/ceiling snapshots; the response
includes the Region-bound access token, trusted descriptor and one-use enrollment ticket.
Requested scopes must be a subset of the Key grant. The JWT lasts at most 15 minutes and never past the Key expiry;
Key-version/state checks invalidate old Global Tokens after renewal, rotation or revocation.
Issuance metadata never returns credentials. Region discovery requires `resources:read` and
returns only the Key's permitted Region descriptor. No resource or native provider credential
is exported to Global by these operations.

The origin-bound [Global client](../src/api/global-client.ts) exposes the generated API,
Key exchange and Region discovery. It retains no credentials and rejects cross-origin requests
and redirects. Existing regional callers and direct-Key records are unchanged; they have not
been migrated or activated under the new authority.

## Native evidence

`globalApiCases` in the verified OIDC integration fixture starts an actual Global role in a
separate process against isolated S3 Meta. It covers public login, callback replay, logout,
Owner/Key/Workspace/Origin separation, one-time Key creation, versioned mutation, scope denial,
Global Token discovery, generated-client calls, response-schema validation and Global process
restart with the same Meta, keys and checkpoint. No Portal or cloud outage test is required.
The additional regional integration fixture stops both independent Global API and Global Meta,
then performs Region reads/writes, expiry-triggered local renewal and Region restart, including
cached SDK reconnect without Global. The case now includes a same-secret Key renewal applied
before the old expiry, cross-version local refresh after that expiry, and separate denial cases
for fixed expiry, undelivered/late renewal and missing proof. Existing Keys retain their current
regional authority; automatic fenced legacy-Key cutover is not enabled.

With a configured `regionControls` entry, Global signs and durably records exact policy/ceiling
intent before initiating TLS 1.3 mTLS to the Region control origin. Each entry contains
`regionId`, an HTTPS `origin`, and `tls` files (`caFile`, `certificateFile`, `privateKeyFile`).
The Region pins the exact Global client certificate. Global never proxies data requests.
The current prototype binds each Workspace grant to its Directory-assigned Region, has a 16 KiB signed
control-message limit and bounds per-Key automatic history reconciliation to 1,024 versions;
large grant/history reconciliation requires an explicit follow-up rather than an unbounded scan.
