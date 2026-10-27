# ADR 0004: Drive9 Anonymous File System behind the Workspace gateway

- Status: Accepted and implemented for loopback evaluation
- Date: 2026-10-27
- Scope: Live file storage, internal credentials, provisioning recovery, and file transfer API

## Decision and evidence

The owner requested a real Singapore anonymous trial with one customer-facing Workspace Key.
Use `https://api.drive9.ai` for new resources when the backend is started with
`WORKSPACE_FILES_PROVIDER=drive9-anonymous`. The endpoint is fixed inside the adapter; clients
cannot choose an upstream URL or send provider credentials. The live region manifest and
Drive9 source described in [ADR 0003](0003-filesystem-regions-and-modes.md) identify this
endpoint separately from account-bound TiDBCloud mode.

Verified upstream contract: `mem9-ai/drive9` `cmd/drive9/cli/db.go`,
`pkg/client/client.go`, and `pkg/server/server.go`, inspected 2026-10-27:

- Unauthenticated `POST /v1/provision` returns tenant ID, API key, and provisioning status.
- Bearer-authenticated `GET /v1/status` reports status, `max_upload_bytes`, and `inline_threshold`.
- `/v1/fs/{path}` supports directory listing (`?list=1`), `HEAD` metadata, raw `GET`/`PUT`,
  `POST ?mkdir=1`, and non-recursive `DELETE`. `X-Dat9-Expected-Revision: 0` prevents overwrite.
- The status response does **not** establish a total storage allowance or file-count quota.
  Do not present TiDB Cloud's 2 GiB / 2,000-file allowance as an Anonymous tenant's measured quota.

The provider is a dedicated backend module. Every public call still passes Workspace Key
scope, resource, expiration, and revocation checks before any provider I/O. Browser owners
use the existing loopback-only HttpOnly session. Neither API consumers nor browsers receive
the provider token, tenant ID, raw upstream errors, or provider download URLs.

## Credentials and persistence

Resource metadata remains in `.data/workspace.json`. Internal bindings are stored separately
in `.data/workspace.json.providers.json`, created with owner-only permissions (0600) inside
an owner-only directory (0700). Both are ignored by Git. This is local prototype secret
storage, **not** an encrypted production secret manager. Do not copy the credential file into
build artifacts, screenshots, CI, or frontend assets. Production hosting still requires
identity, encrypted secret storage, rotation, and multi-process coordination.

Provisioning persists a resource reservation and an internal request intent before calling
Drive9. The returned credential is saved before checking readiness. Retrying the same
Idempotency-Key or restarting reuses the binding. A network interruption or process failure
that leaves the creation outcome unknown must never automatically create a replacement.
The resource exposes a generic recovery message. Operators must reconcile the tenant with
Drive9 and restore its private binding; deleting the intent and retrying blindly is unsafe.
A pending tenant's state can be refreshed in the Console. No automatic cloud provisioning
runs at startup, during tests, or when opening an existing local resource.

Existing resources without a provider field remain local, including their IDs, regions,
files, and key grants. They are not silently moved or relabeled. A live Singapore trial can
coexist with a local Singapore demo. The prototype permits one new trial per provider/region;
that is a product guard, not a claim about the upstream account's allowance.

## Public API and transfer limits

- `GET /files?resourceId=...&path=/directory` lists a single directory. Drive9 returns metadata
  only; omission of path means root. Legacy local listings still include text content and
  omit path to list all items.
- Existing JSON `PUT /files` supports directories and UTF-8 edits up to 256 KiB, further
  bounded by the provider's upload limit. `DELETE /files` deletes files or empty directories.
- `PUT /files/content?resourceId=...&path=...` accepts `application/octet-stream` for live
  resources. `If-None-Match: *` performs a conditional create. The Console uses it on upload.
- `GET /files/content?...` streams an attachment through the gateway with backpressure and
  byte-count validation. No token is put in a URL. Customer Bearer keys work for agents;
  browser downloads use the owner cookie.
- Add `preview=1` for JSON containing bounded UTF-8 `content`, or `unavailableReason` with
  `size`. Metadata is checked before downloading; preview reads never exceed 128 KiB even
  if the file grows. Binary content has a download-only panel. Parsing/line/complexity budgets
  in the existing renderer remain in force. Source editing is disabled when text was not loaded.

The gateway upload maximum is the minimum of **1 MiB**, the provider's upload maximum, and
its inline threshold. Missing limits disable writes rather than guess. This iteration uses
simple inline file I/O; multipart uploads, object-store redirects, extent layouts, resumable
transfers, image/PDF rendering, and native mounts are not implemented. Adapter requests reject
redirects, preventing credentials from being forwarded to another destination. Revisit the
adapter and threat model before adding those transports. Writes are never retried implicitly.

Listing/preview requests are cancelable and discard stale responses when users change files
or File Systems. Preview failures preserve Download and navigation. Cloud usage and billing
are explicitly unmeasured; a current folder's file count and bytes are not total tenant usage.
Revocation denies new requests immediately; an already authorized transfer may finish within
its bounded request lifetime. Long-lived sessions need stronger revocation propagation.

## Verification and revisit conditions

`server/drive9.test.mjs` uses an injected fake transport with temporary state and no cloud
credentials. It covers provisioning/restart/idempotency, ambiguous outcomes, private storage,
secret-free responses/errors, path handling, original binary bytes, bounded previews,
conditional creates, non-empty directory protection, scope/resource/workspace denial,
expiration, and revocation. Existing local-provider tests continue to run.

Run `node scripts/verify-drive9.mjs <origin> <resource-id>` only against an explicitly authorized
trial. It writes generated examples, verifies checksums through a scoped Workspace Key, and
revokes its test keys. It never provisions another tenant. Live verification and UI screenshots
are recorded in [Drive9 verification](../drive9-verification.md); they are separate from CI.
Revalidate on upstream changes, new transfer formats, production hosting, billing integration,
or changes to the public key model.
