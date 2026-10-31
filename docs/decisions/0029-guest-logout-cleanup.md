# ADR 0029: Guest logout and provider cleanup

- Status: owner direction, implementation under verification; supersedes the non-deleting
  processor in [ADR 0028](0028-guest-expiry-retention.md). It does not change account isolation.
- Scope: Guest logout, Region policy and asynchronous provider cleanup.

## Decision

A Guest explicitly confirms sign-out. The Console sends a same-origin POST; a GET cannot initiate
provider deletion. The Region authenticates the existing Guest cookie, durably records the
Workspace-scoped cleanup request, then denies the Guest owner policy before clearing the cookie.
The denial invalidates the Guest browser credential and Workspace Keys for that Workspace. It is
terminal: the Guest policy cannot be re-enabled while provider effects may remain in flight.
Another Guest's Workspace and TiDB Account sessions are not selected by a supplied Workspace ID.

The Region starts a bounded immediate cleanup attempt and also scans a durable sharded logout
index for recovery; the original 24-hour expiry scheduler uses the same processor. Cleanup waits
for in-flight Workspace/stream leases to drain. A durable claim and a scoped per-resource intent
precede provider I/O, and the provider adapter revalidates the Workspace, resource, private binding
and target digest. A busy Workspace can be retried only before any provider effect is journaled.
Unknown provider outcomes are not blindly retried. Inventory is paged; credentials stay server-side.

The current processor attempts DB9 PostgreSQL deletion and Drive9 tenant deletion, including the
private File System backing DuckDB, when the provider accepts the operation. TiDB Cloud Zero does
not expose a supported immediate deletion endpoint in the current integration; it is left pending
until its own expiration or future provider support. Drive9 can also reject deletion for a specific
provider/tenant. The current Drive9 implementation explicitly rejects TiDB Zero tenants and
unsupported provider types ([source, pinned](https://github.com/mem9-ai/drive9/blob/42a316a20a71d3d7b789053ed020b45ba633aedc/pkg/server/tenant_delete.go)).
DB9 documents its [database deletion API](https://db9.ai/docs/api/), while [TiDB Cloud Zero](https://zero.tidbcloud.com/) documents expiration. A provider accepting a delete request does not establish that deletion completed: preserve the job, bindings and credentials for reconciliation; unsupported or uncertain outcomes stay deferred. Empty/no-cloud-resource jobs can complete.

## Contract and recovery

`POST /api/auth/guest/logout` returns `cleanup: scheduled` after durable request and denial; it
never asserts provider deletion completed. The legacy TiDB Account logout route rejects a
Guest-only session so a prefetchable GET cannot silently bypass cleanup. The UI does not report
cloud retention. Existing Guest cookies and Workspaces require no migration. Cleanups already in
claimed or deferred state are not automatically replayed: uncertain provider effects require
operator reconciliation. No controller for provider confirmation or deferred-job repair is
included yet. The regional scheduler is bounded but the fixed shard scan and unbounded per-job
provider attempts are not yet a design for million-resource Workspaces.

## Verification and rollout

Verify isolation, guest-only authentication, origin checks, cancel/confirmation, policy and Key
revocation, queue persistence, duplicate claims, in-flight lease fencing, provider-specific
binding/target checks, failed/ambiguous effects and recovery against isolated S3 and mock
providers. Do not issue live deletion requests during verification. Deploy only after the native
and Console versions are compatible and the full backend checks pass; a stale Console trying the
legacy Guest logout receives an error and must reload. Real provider deletion availability and
end-to-end deletion confirmation require separate production verification.
