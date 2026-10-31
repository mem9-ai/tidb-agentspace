# ADR 0030: Personal TiDB Account isolation and legacy retirement

- Status: Owner direction implemented in this candidate; hosted rollout and legacy retirement
  require separate deployment evidence.
- Scope: hosted TiDB Account onboarding, Region-local sessions, and the old shared Workspace.
- Supersedes the shared-owner admission and eight-hour hosted session portions of
  [GH-13](../../specs/gh-13/spec.md) for the managed hosted profile. The explicitly local,
  loopback-only SSO fixture retains the old behavior as an isolated compatibility test.

## Identity and isolation

A successful cryptographically verified TiDB Account `(iss, sub)` identifies one User. The
Global directory reserves one personal tenant and Workspace with stable opaque UUIDs. The
existing directory represents this personal tenant as `organizationId`; it is a private
one-to-one ownership boundary, not an assertion that the user belongs to a TiDB Cloud
organization. Future shared organizations and membership require a separate model and explicit
migration; do not infer them from email or an unverified organization claim.

Global initializes Region policy and a fresh, empty Workspace, then marks its reservation ready.
Same-identity retries reuse the reservation and operation; different issuer/subject pairs obtain
independent IDs. Only the verified callback invokes onboarding. The Region never calls Global.
Resource and Key access authenticates the Region owner policy and uses the selected managed
Workspace. A Workspace URL by itself grants nothing. Old shared Workspace cookies and Keys are
not accepted by a managed host. Guest remains independently scoped and may be disabled without
disabling personal account onboarding.

## Region-local browser access

After verified login, Region writes a revocable owner continuity grant. Its opaque secret is
placed in a host-only, HttpOnly, Secure, SameSite=Strict browser-session cookie, never in a URL,
JSON response or plaintext metadata. Requests verify the durable regional grant and current local
policy; provider operations retain existing action/resource checks. An in-process revocation
fence rejects already-running work in this single-instance profile. Logging out revokes the grant.
The browser-session grant has no absolute server expiry: while held by the browser it can continue
without Global, including beyond an eight-hour access-token interval. This is an explicit
availability/security tradeoff: a stolen cookie remains usable until logout or a local policy
revocation. Cross-Region revocation propagation, distributed in-flight fencing, administrative
session management and an independent Global-to-Region mTLS transport are future work. Existing
regional access survives host restart; first login requires Global. If Global is unavailable at
startup, existing regional sessions work, and a restart is currently needed to reconnect onboarding.

## Shared Workspace retirement

The owner authorized deletion of `ws_agentlab` instead of migration or assigning its resources to
an account. Managed hosts use a separate internal health sentinel, never exposed as a customer
Workspace. A protected one-time operator operation, scoped exactly to `ws_agentlab`, deletes its
live regional records and stored credentials using the exclusive Workspace writer and versioned
batches; it never enumerates another Workspace. It is resumable until the final atomic core/writer
removal. A managed host can run this during startup only with the explicit
`WORKSPACE_RETIRE_LEGACY=ws_agentlab` flag; the protected manual workflow requires same-commit full
CI, exact deployed image digest, one Recreate replica, a successful retirement marker and health
checks before removing the flag. An offline CLI is also available only while the host is stopped.

These are **logical metadata deletions**. SlateDB WAL/SST history, object-store versions and
backups can retain earlier encrypted records until the storage retention/compaction lifecycle
removes them. The operation does not delete cloud provider instances; the owner previously
specified that real cloud deletion need not block this work. Do not describe this as verified
physical erasure or provider deletion. If deletion outcome or writer ownership is uncertain,
stop and reconcile rather than reset a shared Meta root or roll back to a binary expecting the
retired Workspace.

## Evidence and limitations

Use isolated RustFS with a signed fake OIDC provider and mock resource providers. Verify two
accounts and a Guest, same-account relogin, Workspace/Key/resource separation, denial of the
legacy Workspace, Regional continuity through restart with Global unavailable, revoked cookie
replay, disabled Guest signup, and bounded paginated legacy deletion with an unrelated Workspace
untouched. Run the full backend and repository gates. Real TiDB Account login, hosted rollout and
live legacy retirement are separately verified and reported; synthetic tests do not establish them.
The pool and Workspace views remain bounded prototypes and have not been validated at millions
of tenants or a million resources per Workspace.
