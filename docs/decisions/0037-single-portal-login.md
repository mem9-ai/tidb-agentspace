# ADR 0037: One Portal sign-in for bundled Global and Region

- Status: accepted owner direction; implementation and native acceptance accompany this change.
- Date: 2026-11-01.
- Refines ADR 0036 for the single-service cloud profile.

TiDB Account signs the user into Portal. Enabling Global Key management must not require
another identity-provider application/callback or another login immediately afterward.
The existing verified, browser-bound, single-use OIDC+PKCE callback remains registered at
`/studio/api/auth/tidbcloud/callback`.

For the bundled deployment, the Portal auth composition completes Global onboarding and
issues two distinct sessions from that verified identity: a Global management session after
ready Directory membership checks, and a Region browser continuity grant. It never upgrades
an arbitrary regional cookie to Global ownership. Global's eight-hour host-only HttpOnly,
Secure, SameSite=Strict cookie uses the Portal path so logout can revoke and clear both.
The existing trusted-origin, tenant, token audience and permission checks remain in force.
Global cookie scope is independent of authorization: Region never accepts it for data.

This shared application port exists only in the co-located Portal sign-in/sign-out flow.
Established Region data/refresh paths have no Global callback or availability dependency.
Independent Global deployments may retain their separately configured verified OIDC flow;
this change does not infer cross-domain trust or introduce a session-exchange endpoint.
Revisit the Portal auth routing when deploying its public login separately.

For an explicitly enabled Guest profile on a shared Global/Region listener, including hosted HTTPS,
Global can authenticate the existing Region Guest browser session in-process and only for its
exact Workspace. It rechecks the durable Region Guest policy for Global token use and Key exchange.
Guest Keys default to at most 24 hours and never outlive the Guest Workspace. Logout durably denies
the Region Guest policy before success, denying subsequent Key exchange and regional Token
reads, writes and refresh. Operations admitted before logout follow the existing drain policy.
Independent Global deployments cannot use this in-process session bridge;
they need an independently authenticated handoff. Region never calls Global for these checks, and
existing regional access does not require Global availability.

Native acceptance verifies one callback, replay denial, two-authority/cross-Workspace denial,
Key creation and policy delivery, Region Token issuance, and durable logout of both sessions.
Real cloud Portal/provider verification is separate evidence and is never inferred from fixtures.
