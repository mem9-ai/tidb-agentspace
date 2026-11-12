# ADR 0016: Verified email grants for a shared workspace

> **Partially deprecated.** Shared-Workspace owner admission now applies only to the loopback SSO compatibility fixture. Managed hosting assigns a personal Workspace using verified issuer and subject under [ADR 0030](0030-personal-account-isolation.md).

- Status: Accepted owner direction; implemented with synthetic-provider tests.
- Date: 2026-10-29
- Scope: Opt-in SSO owner eligibility for an internal shared workspace.

## Decision

An operator can set `TIDB_SSO_OWNER_EMAIL_RULES=*@pingcap.com` to admit verified
accounts in that exact email domain. Exact email rules can be mixed in the same
comma-separated setting, for example `*@pingcap.com,alice@example.net,*@example.org`.
Accept ASCII dot-atom email addresses or `*@domain` with ASCII DNS labels. Both email
and domain matching are case-insensitive; surrounding rule spaces are trimmed and
canonical duplicates removed. Malformed rules, empty list items and control characters
fail startup. An unset/blank setting disables email grants. Arbitrary globs (including
`foo*@domain`), subdomain matching, quoted addresses and IDN conversion are unsupported.

After existing ID-token signature, issuer, audience, expiry and nonce verification,
require a nonempty scalar `sub`, then the existing optional organization filter.
Grant owner if the subject exactly matches `TIDB_SSO_OWNER_SUBJECTS` OR the token
contains a syntactically valid ASCII dot-atom email, boolean `email_verified: true`,
and either its exact email or exact domain matches a configured rule. Never trust callback
parameters, display claims or unverified tokens for this decision. Missing, malformed or unverified
email cannot use this new grant; the preexisting exact-subject grant stays compatible.

Identity remains issuer plus `sub`, including audit attribution. A domain rule explicitly
authorizes every verified account in that domain, including future/reassigned mailboxes;
it does not establish current employment, a unique person or ownership of private data.

## Shared access and credential boundary

Every admitted account has full owner access to the existing `ws_agentlab`: all its
resources, data and Workspace Key administration are shared. This does not introduce
customer, team or user isolation. Use it only when sharing that access is intended.

Browser requests use owner session cookies; external clients use scoped Workspace Keys.
Backend adapters use private resource-specific provider credentials. Keeping those keys
out of browser responses does not restrict a shared owner from using the resources
through the API. The deployed Node implementation stores Drive9 credentials in
`<WORKSPACE_DATA_FILE>.providers.json`; this is private plaintext file storage, not an
encrypted secret manager. See [ADR 0004](0004-drive9-anonymous-provider.md) and
[DuckDB private storage](0008-duckdb-private-storage.md).

## Operations and compatibility

The setting is off by default. Existing exact-subject grants, organization filters,
Workspace Key checks and OAuth code + S256 PKCE are unchanged. No HTTP API/schema change.
`TIDB_SSO_ALLOWED_ORGS` accepts token organization identifiers, not web origins or email
patterns. Do not add a domain to `TIDB_SSO_OWNER_SUBJECTS` expecting email matching.

Load configuration on API startup. To enable the internal shared-domain policy after
installing this version, set `TIDB_SSO_OWNER_EMAIL_RULES` in the runtime ConfigMap and
restart the API. Keep `TIDB_SSO_ALLOWED_ORGS` empty unless a real organization filter is
intended. The subject list may be empty when an email rule is the intended sole grant.
This change does not modify a live ConfigMap or automatically enable domain grants.

Eligibility is checked at login, not continuously. Existing sessions retain their normal
up-to-eight-hour lifetime unless logged out or the API restarts; provider account disablement
alone does not immediately revoke them. A fresh API process clears in-memory sessions.
Workspace Keys are independent persisted credentials: they remain valid until their expiry
or explicit revocation, including keys created by a formerly eligible owner. Offboarding
must account for both sessions and those keys. Removing the rule and restarting disables
new email-only logins; retained subject grants continue to apply.

## Verification

Configuration and pure authorization tests cover mixed exact/domain rules, case handling,
duplicates, malformed or missing claims, false/string email verification, deceptive domains, unchanged subject grants
and the organization filter. Local signed OIDC callback tests exercise both email- and domain-authorized
accounts as distinct audit actors with shared owner access, plus denial without a session for
bad signature/issuer/audience/expiry/nonce and ineligible email. Callback-supplied email cannot
grant access. A restart/revocation regression also proves that rule removal alone leaves
existing sessions usable, sessions expire at eight hours and disappear on restart, and
persisted Workspace Keys survive restart until explicitly revoked. These tests do not prove an actual provider registration emits verified email;
a real account login is still required for deployment acceptance.
