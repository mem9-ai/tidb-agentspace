# ADR 0015: Public-client TiDB Account sign-in

- Status: Accepted; implemented and locally verified, provider integration pending.
- Date: 2026-10-29
- Scope: OAuth client authentication only; workspace authorization is unchanged.

## Context and decision

The service previously required an OAuth client secret despite already using S256 PKCE.
Configure it as an OIDC public client instead: the token endpoint request contains
`grant_type=authorization_code`, `code`, `client_id`, `redirect_uri`, and `code_verifier`.
It sends neither a client secret nor an HTTP Authorization header. There is no fallback
to confidential-client authentication or implicit login.

The API still owns the short-lived state, nonce and PKCE verifier, receives the callback,
verifies the ID token with JWKS, and issues its existing HttpOnly session cookie. The
Console, API routes, session lifetime, immutable `sub` identity and default-deny owner
allowlist are unchanged. Removing an application credential does not grant workspace access
or implement customer isolation.

## Provider requirements

Register an application that permits authorization code, S256 PKCE, token endpoint
authentication method `none`, and the exact configured callback URL. A provider that requires
client authentication will reject this flow; the application returns its generic sign-in
verification error and does not issue a session.

On 2026-10-29 the [TiDB Cloud discovery document](https://auth.tidbcloud.com/.well-known/openid-configuration)
advertised code, S256 and `none`. This is provider capability evidence, not confirmation that
a particular client ID permits those settings. [Auth0 documents public-client PKCE](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce).
A real login against the intended registration is still required before claiming integration.
Do not infer that a browser application's ID token flow establishes support for code exchange.

## Configuration migration

Use `.env.example` for the issuer, public client ID, callback and authorization settings.
The former `TIDB_SSO_CLIENT_SECRET` setting is no longer read or forwarded. Remove its runtime
entry and any dedicated secret reference when migrating an approved deployment. Do not delete
a shared Kubernetes Secret or secret-manager object: preserve unrelated keys and consumers.
The change does not rotate or remove other application or provider credentials.

This revision deliberately supports public-client registration only. Operators using a
confidential client must update the registration before migrating; an old secret value does
not make the new token request authenticate as a confidential client. No live secret deletion
or SSO activation is performed by this code change.

## Verification

Request tests require the exact token form and absence of client authentication. The fake
identity provider rejects client-secret fields and Authorization headers and verifies the
PKCE challenge. Tests cover configuration without a secret, missing required configuration,
provider rejection, flow expiry/replay, ID-token expiry, nonce, signature, issuer, audience,
redirect boundaries, HttpOnly cookies and retained owner authorization. Run `npm run check`.
These local tests use synthetic identities and do not exercise a real TiDB Cloud account.
