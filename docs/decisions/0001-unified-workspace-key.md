# ADR 0001: One customer-facing Workspace Key

> **Current implementation.** The single customer Key and action/resource boundary remain current. [Global-only Keys](0036-global-keys-only.md) defines exchange for regional Tokens, and [ADR 0060](0060-workspace-key-resource-types.md) adds dynamic resource-family grants.

- Status: Accepted
- Date: 2026-10-27
- Scope: Public authorization boundary and upstream credential ownership

## Context

This is an independent product. A developer or agent should be able to operate permitted
MySQL, PostgreSQL, and File System resources with one product credential. Asking the customer
for separate TiDB Cloud keys or native service tokens exposes internal integration details.
The earlier proposal's customer-managed native credential flow is superseded by this decision.

## Decision

Expose a Workspace Key on the public REST API and future SDK/MCP interfaces. A key combines
allowed actions with allowed resource IDs. Every resource operation checks both; discovery,
usage, and activity lists are filtered to authorized resources. Deny missing resource grants.
Explicit `resourceIds: ["*"]` includes current and future resources. A list of exact IDs only
includes those resources. Creating a resource requires both `resources:write` and the explicit
workspace-wide grant, so resource creation cannot silently widen a restricted key's access.

The service owns upstream management credentials, database users, and filesystem data tokens.
Store production secrets in an internal secret manager; adapters access them through secret
references. Do not return them to customers or let them bypass the product's access policy.
One key may authorize several components. A customer may create additional keys per agent or
workflow for independent permissions, expiration, attribution, and revocation.

Public data operations pass through an authenticated product gateway and internal provider
adapters. Regional gateways can stream file content and pool database connections. Native
MySQL/PG client support or filesystem mounts may require protocol-specific product gateways
or bounded delegated sessions; a REST Bearer key does not automatically authenticate those
protocols. Those integrations must preserve the same policy and revocation behavior without
requiring the customer to manage upstream credentials.

## Consequences and migration

- The prototype implements one-key database query/file API access and explicit resource grants.
- Key creation now requires `resourceIds`; clients must send exact IDs or `["*"]`.
- Existing prototype keys without this field retain no resource access. Reissue them with an
  explicit grant; never silently upgrade legacy keys to wildcard access.
- In the current regional authority, Workspace Key revocation blocks new public requests to all
  granted components. Across independently serving Regions, Global revocation becomes effective
  per Region when that Region durably applies it; disconnected targets remain pending under
  [ADR 0034](0034-openapi-security-authorities.md). Streams and admitted operations need
  explicitly tested cancellation/completion semantics.
- Internal credential rotation is independent of the public key. Production broker/secret
  storage remains proposed work. [ADR 0004](0004-drive9-anonymous-provider.md) implements a real File System adapter with separate local private credential storage.
- Exact resource selection plus common action scopes is implemented. Per-resource action
  differences and path-level rules can extend the policy later without changing key identity.

## Verification

The [proposed regional API/auth profile](../../specs/gh-74/regional-api-auth.md) extends the
same permission model with optional regional access tokens and explicit continuity grants.
It does not implement new routes or change existing expiring Keys. Legacy/imported `expiresAt`
remains a hard limit; a durable grant requires explicit owner-authorized regional renewal
authority, which may be granted with Key creation. ADR 0034 distinguishes locally effective revocation from pending delivery to a
disconnected Region; the current single-process immediate-revocation tests remain valid.

API tests exercise a single key that can query PG and read/write Files, receives a denial for
MySQL, sees filtered discovery/usage/activity, and loses access to both services on revocation.
Additional tests cover action-only denial, invalid resource grants, and the difference between
exact-resource and explicit future-resource access. UI verification covers resource selection,
disabled creation permission for restricted keys, and the unified connection instructions.
