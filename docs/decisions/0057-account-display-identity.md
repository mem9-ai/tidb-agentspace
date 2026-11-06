# ADR 0057: Display the verified browser account identity

Accepted owner direction, 2026-11-06. Applies to the managed TiDB Cloud browser login
in [ADR 0030](0030-personal-account-isolation.md).

The editable Workspace display profile is not a login identity. The sidebar and account
settings display the name from the cryptographically verified OIDC login, falling back
to its verified email and then a neutral TiDB Cloud account label. Do not render the
initial Workspace placeholder “Developer” as the signed-in account.

After existing signature, issuer, audience, nonce and PKCE verification, retain only a
bounded display name (`name`, then `preferred_username`) and syntactically valid email
when `email_verified` is boolean true. These fields cannot grant permissions, identify
a tenant, or replace `(iss, sub)`. Do not retain raw tokens or other provider claims.

Store this display-only snapshot in regional session metadata under the browser grant
digest. A separate record preserves compatibility with older grant readers and keeps
user data out of the editable/shared Workspace profile. Read it only after authenticating
the exact Workspace-bound OIDC browser grant. Guests, access Tokens, signed-out browsers,
other Workspaces and revoked grants cannot retrieve it. Profile metadata follows existing
encrypted session retention; logout denies access and does not promise physical erasure.

`GET /api/auth/config` gains an optional `account` object with optional `name` and `email`.
The response remains `no-store`. It is a browser-session presentation field, not a public
Key capability or a user directory. No new permission or provider login scope is added.
Old active sessions have no snapshot: preserve access, show an honest account fallback,
and explain in settings that another sign-in loads account details. Existing local/legacy
and standalone distributed Portal flows retain their prior behavior and fallback labels.

Deploy the additive API before expecting real account details. New Console works against
old API through the fallback, and old API ignores the separate profile records on rollback.
Verify filtering, two-account isolation, missing profile, cross-Workspace and access-Token
rejection, restart with Global unavailable, logout denial and responsive name/email display.
A fake OIDC provider verifies the contract; real provider claim availability is separate
live acceptance and requires a fresh user login.

Connection dialogs preserve [ADR 0034](0034-openapi-security-authorities.md): customers
manage one Workspace Key. Agent instructions and the existing JavaScript client perform
endpoint discovery and short-lived token exchange. Do not ask people for a second region
credential or relabel a raw regional token as a Workspace Key. Direct HTTP protocol details
remain in API documentation. Connection examples reuse the selected resource and only read.
