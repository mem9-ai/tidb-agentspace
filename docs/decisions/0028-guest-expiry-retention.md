# 0028: Guest expiry with deferred provider cleanup

Trial duration was unified to 48 hours by [ADR 0055](0055-unified-trial-duration.md); existing shorter deadlines remain unchanged.

Status: Partially superseded by [ADR 0029](0029-guest-logout-cleanup.md), which adds an
explicit logout cleanup request and provider deletion attempts. [ADR 0030](0030-personal-account-isolation.md)
defines independent personal TiDB Account onboarding.

A Guest receives an independent User, Organization and Workspace with an absolute 48-hour
expiry. The regional browser credential is host-only, Secure and HttpOnly. The Region checks its
own policy and durable grant for each Guest request, so existing Guests can continue when Global is
unavailable. Global initiates regional onboarding within the co-located trust boundary; separately
deployed services still need an authenticated Global-to-Region control channel.

On expiry, regional policy rejects new requests. ADR 0029 defines the current scheduler,
provider attempts and deferred reconciliation. Unsupported deletion does not prevent resource
creation; the current scheduler is not a scalable long-term retention solution.

The host requires explicit `guest` configuration or `WORKSPACE_GUEST_ENABLED=true`, separate Global
and Region metadata authorities,
a trusted HTTPS public origin and SSO configuration. When Global is absent at host startup,
existing regional Guest sessions work but new signup is unavailable until the host reconnects;
the current implementation requires a restart to reconnect. A Guest Workspace Key can address its Workspace directly without a browser cookie; listing
Workspaces from a Key without specifying its Workspace is not yet supported. TiDB Account login uses an independent personal Workspace in the managed host. A crashed Workspace writer may require operator reconciliation; graceful shutdown drains
leases. These limitations must be resolved or explicitly scoped before a hosted cutover.

Verification uses the native host with isolated RustFS/S3 and mock providers. Separate Guest
Workspaces, cookie resume, expiry and logout are tested without deleting real provider resources.
This does not verify real provider lifecycle or crash recovery.
