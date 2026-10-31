# 0028: Guest expiry with deferred provider cleanup

Status: Accepted direction; opt-in co-located host implementation under validation. Hosted rollout
and independent per-account Workspace onboarding are not complete.

A Guest receives an independent User, Organization and Workspace with an absolute 24-hour
expiry. The regional browser credential is host-only, Secure and HttpOnly. The Region checks its
own policy and durable grant for each Guest request, so existing Guests can continue when Global is
unavailable. Global initiates regional onboarding within the co-located trust boundary; separately
deployed services still need an authenticated Global-to-Region control channel.

On expiry, regional policy rejects new requests. A bounded Region scheduler marks the Guest job
`providerCleanupDeferred` without contacting cloud providers. Resource inventory, private provider
bindings and credentials are retained; this state is not evidence of deletion or of in-flight work
having drained. Unsupported deletion does not prevent resource creation. A future cleanup executor
must fence running effects, reconcile provider results and only then report deletion or remove the
records. The current scheduler scans 64 shards and preserves claimed or deferred work for explicit
reconciliation after an uncertain outcome; it is not a scalable long-term retention solution.

The host requires explicit `guest` configuration or `WORKSPACE_GUEST_ENABLED=true`, separate Global
and Region metadata authorities,
a trusted HTTPS public origin and SSO configuration. When Global is absent at host startup,
existing regional Guest sessions work but new signup is unavailable until the host reconnects;
the current implementation requires a restart to reconnect. A Guest Workspace Key can address its Workspace directly without a browser cookie; listing
Workspaces from a Key without specifying its Workspace is not yet supported. Normal TiDB Account login still uses the existing shared
Workspace. A crashed Workspace writer may require operator reconciliation; graceful shutdown drains
leases. These limitations must be resolved or explicitly scoped before a hosted cutover.

Verification uses the native host with isolated RustFS/S3: separate Guest Workspaces, cookie resume,
expired Guest authorization, scheduled retention, graceful restart, Global outage, and no provider
deletion. This does not verify real provider lifecycle or crash recovery.
