# ADR 0047: Default File System for new Workspaces

- Status: owner direction, implemented locally; live-provider verification is separate.
- Date: 2026-11-03.
- Scope: Console entry, first File System reservation, and the US sales sample.

On an authenticated account or temporary-session entry to an empty Workspace, the Console requests a default File System using the configured
provider and location. The Overview describes preparation and failure, retains the sales guide,
and does not run a sample or query automatically. This supersedes ADR 0004's prohibition on
automatic provisioning for this new-Workspace Console entry only. Direct API access, existing
resources, and unrelated provisioning retain their prior behavior.

`POST /resources` accepts owner-only `onlyIfNew: true` for a File System with an idempotency key.
The repository atomically checks the resource index's monotonic history and reserves the resource,
name, quota, creation event and idempotency slot. Any prior resource history prevents a new default;
replaying the same key observes the original resource, including its deletion. The existing provider
intent and binding rules prevent a second upstream tenant after an uncertain provisioning outcome.
The `isDefault` resource property identifies the initial File System. Preparation failure must not
be presented as success. A user-requested retry uses the same idempotency key and cannot blindly
repeat an uncertain provider creation. Existing Workspace data is not migrated or replaced.

`POST /sales-sample-attempts` optionally accepts a File System `resourceId`; this path requires
read and write grants on that resource, and uses conditional create for the sample file. It neither
creates another resource nor overwrites an existing file. The idempotency slot binds the caller and
requested resource; legacy requests without `resourceId` retain their creation and permission rules.
The attempt remains durable and uncertain writes are observed rather than blindly retried.

Guest expiry and sign-out continue through the existing scoped cleanup processor. Provider acceptance
does not by itself prove physical deletion. No change here adds a provider reconciliation controller,
prewarming, metering, or a performance guarantee. Verify concurrent entry and replay, owner-only
initial creation, prior-history and deleted-resource behavior, target grants, file conflicts, first
use and returning journeys, and real-provider provisioning plus deletion separately from mocks.

[ADR 0051](0051-guest-workspace-entry.md) specifies concurrent first-use setup and receipt handling.
