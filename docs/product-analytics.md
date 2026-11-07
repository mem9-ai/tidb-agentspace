# Product analytics and Admin

Initial implementation: [GH-184](https://github.com/mem9-ai/tidb.ai/issues/184).
Independent service amendment: [GH-190](https://github.com/mem9-ai/tidb.ai/issues/190), under
[ADR 0050](decisions/0050-isolated-analytics-service.md), against
[GH-182](../specs/gh-182/spec.md) accepted at
`a80611104ce322a00034021210604d6ad96fcd2e`. Live enablement is separate from source
verification. HTTP latency, infrastructure monitoring and request-history changes
are explicitly outside this task per the owner's 2026-11-04 clarification.

## What is measured

Optional browser events cover public page categories, approved campaigns, broad
referral categories, trial/sign-in intent, agent/self-service selection and helpful
votes. A random session ID expires after 30 minutes of inactivity. No persistent
person ID, fingerprint, raw URL/referrer, SQL, file name/content or credential enters
these events. GPC and the persistent analytics preference suppress optional capture.

Console capture starts from the product's successfully loaded authentication configuration.
It reuses that configuration to locate Global; optional measurement must not issue a
competing authentication/discovery request, consume a bootstrap failure, delay sign-in
or change its retry behavior. Standalone public pages discover collection independently.

Native completion hooks count meaningful product outcomes for Console and API use:
query, file analysis/preview, import/export and explicit report saving. Listing and
polling do not activate a Workspace. Key-authenticated activity is API usage, not
proof of an autonomous agent. Generic file writes cannot claim `report_saved`.

The existing `PUT /workspaces/{workspaceId}/files` accepts optional `purpose: "report"`
for an explicit report save. It requires a nonblank file, `If-None-Match: *`,
`files:write` and the selected resource grant. Generic writes do not claim a report.
Use existing file metadata/content operations to inspect a save. A lost response is
reconciled through file metadata, never replayed as an overwrite. Success proves
persistence, not quality or agent authorship. The self-service sales path uses this
same create-only File API; older deployments retain their normal file behavior.

## Storage and retention

The separate SlateDB engine uses a private Foyer cache capped at 8 MiB of weighted entries by
default. Its private configuration accepts `blockCacheMib` (0 disables, maximum 1024); count
this budget alongside any co-located Global/Region Meta engines. See
[cache sizing and memory limits](meta-service.md#memory-cache-budget) before changing it.

Run a dedicated single-writer analytics process per producing authority, using its own
SlateDB 0.17 storage root, encryption key, pseudonym key and producer token. Hosted
enablement uses dedicated persistent volumes; an explicit private S3 adapter remains available. API producers
have only a remote analytics client. The analytics crate has no Meta service/client
dependency and exposes no Meta protocol, writer owner, security clock or takeover path.
The role loader rejects a mixed analytics/business/Meta process. Do not grant the
analytics process access to primary Meta or customer storage.

Raw events, deduplication, 30-day identity-bearing projections, approved attribution
and identity-free daily totals use separate analytics prefixes. Sixteen subject
shards per UTC day bound contention. An atomic native transaction couples each
shard's accepted events, dedup receipts and materialized projections/totals. Admin
reads projections, never customer Workspaces/files or raw-event scans.

The launch limit remains 1,024 events/shard/day (16,384/authority/day, with possible
earlier saturation for a hot subject). Business hooks enqueue at most 1,000 jobs,
including staged/in-flight batches, without network/storage waits. A background
sender posts up to 64 jobs or after one second, with two-second requests and at most
two retries using identical IDs. Overflow/unresolved delivery is unconfirmed coverage;
there is no disk spool or replay-complete broker in the business process.

The separate service commits to SlateDB memory atomically and asynchronously flushes
its WAL to its private storage root, normally at a one-second interval. It does not await
per-write durability. Public collection returns
`202 {"accepted":true,"durability":"queued"}` after service acceptance; this is **not**
a durable storage receipt. A process crash can lose producer queues and recent analytics
writes; displayed totals can recede. The flush interval is not a production RPO.
Retained IDs deduplicate retries; no dedup promise survives loss of an unflushed
receipt. Browser batches commit individual events; a failed batch can be partially
accepted, so retry identical IDs rather than invent replacements.

Use one active analytics process/root, with a single-replica stop/recreate rollout.
There is no standby or automatic failover. Native SlateDB writer fencing still
applies. Restart recovers available analytics WAL/SST data directly, without Meta
owner recovery. An absent service never blocks product startup or completion hooks;
missing optional producer credentials disable the producer while business serving
continues. Admin remains authenticated and reports 503 or explicit missing Regions,
not zeros. Pending/drop counts are process-local; crash-related loss is unknown and
an accepted in-memory event may still be unflushed.

Keep 30 UTC daily partitions including today, with identity-free totals for 90 UTC
partitions. Default view is seven complete days; the 30-day view includes today and
is labeled partial. A bounded cleaner visits expiry and daily indexes every minute,
advancing a cursor through inactive partitions and cleanup backlog. A restart begins
a fresh bounded scan. Expired partitions are excluded
from reads regardless of cleanup progress. Record deletion is logical; SlateDB
compaction and S3 version/backup lifecycle govern physical reclamation. Verify backup
expiry and expired-data exclusion on restore before public enablement. Do not claim
immediate secure erasure or regulatory compliance from the retention setting.

Use a dedicated random pseudonym key per authority, distinct from encryption and
access-signing keys. HMAC-SHA256 binds pseudonyms to purpose and authority. Rotating
this key breaks measurement continuity; do not rotate customer keys or reset Meta.

## Attribution and authority

Global stores only approved acquisition dimensions behind a random, HttpOnly,
ten-minute browser handoff. Only verified onboarding consumes it. Global records
the attributed entry and sends approved source/campaign dimensions to the selected
Region over its existing authenticated TLS 1.3/mTLS control connection. Browser
Workspace IDs, claimed successes and arbitrary properties are rejected.

The private protocol has distinct `Attribution`/`Attributed` and
`Analytics`/`AnalyticsResult` frames, UUID correlation, a registered Region certificate,
32 KiB frame bound, date bounds and a four-second response deadline. It grants no
customer/Meta read operation. Global queries aggregate summaries on demand instead
of retaining a second copy of regional events. Missing Regions are explicitly partial.
The transport is not a public API and carries no provider credentials or SQL.

The first approved touch is retained; unlinked/expired/API-only activity is
unattributed. Only Workspace counts, never people counts, may be combined across
authorities. Cohorts require observed new-Workspace readiness; logging in again does
not create another new-Workspace event. Retention is among eligible activated
Workspaces, split into Guest/account cohorts; incomplete days remain pending.
Time-to-value percentiles are labeled histogram upper bounds, not exact timings.

## Admin access

The UI is `/admin` relative to the Console mount (`/studio/admin` on the current
website). The owner revised the original exact-account proposal on 2026-11-04:
require TiDB Cloud login **and a verified email in exactly `pingcap.com`**.
Subdomains, suffix lookalikes, unverified/string-valued verification and other domains
do not qualify. No normal Workspace Owner or Workspace Key grants Admin access.

Reuse the existing registered OIDC callback and PKCE/state/nonce checks. Operator
mode issues only a distinct host-only Secure/HttpOnly/SameSite=Strict cookie, with a
one-hour server-side session bound to the verified issuer/subject. It does not create
a personal Workspace or add Workspace ownership. Policy is read on every operator
request; removing a domain/identity takes effect for existing sessions immediately.
Process restart invalidates Admin sessions and requires another login.

Admin's **Open workspace** action uses the existing normal Workspace account SSO
entry when configured. It must not silently reopen an existing Guest workspace.
The authentication configuration is reused while refreshing insights. Admin access
does not grant customer Workspace ownership or convert Guest data; the ordinary
account callback establishes the appropriate Workspace session. Local installations
without SSO retain their Console entry.

Bounded structured `operator_security` diagnostics record allowed/denied sign-in,
denied requests and authorized aggregate reads separately from product usage.
Only fixed event labels and timestamps are emitted, without identities, claims,
cookies, URLs or customer content. Allowed and denied streams have separate
120-record/minute process budgets and one overflow marker, so denial spam cannot
consume the allowed-read budget. Existing platform log capture/retention applies;
this is best-effort security evidence, not a new monitoring pipeline or durable audit ledger.

The backend reads a private ordinary file (owner-only permissions, no symlink):

```json
{ "subjects": [], "verifiedEmailDomains": ["pingcap.com"] }
```

An empty policy denies all. Explicit subjects can restrict a private installation,
but cannot bypass the verified PingCAP-domain requirement. The browser never reads
this policy file. Admin exposes aggregate insights only; there is no customer data,
credential, impersonation or raw-event browsing API.

## Private runtime configuration

Capture is disabled by default. Each authority needs an independently deployed analytics
process. Its private configuration has no Meta binding:

```json
{
  "authorityId": "global",
  "installationId": "analytics-global",
  "bind": "0.0.0.0:4329",
  "s3": {
    "endpoint": "https://s3.ap-southeast-1.amazonaws.com",
    "region": "ap-southeast-1",
    "bucket": "private-analytics-example",
    "prefix": "analytics/global"
  },
  "tokenFile": "/run/analytics/producer-token",
  "encryptionKeyFile": "/run/analytics/encryption-key",
  "pseudonymKeyFile": "/run/analytics/pseudonym-key",
  "campaigns": ["launch"],
  "tls": {
    "certificateFile": "/run/analytics/server.crt",
    "privateKeyFile": "/run/analytics/server.key",
    "clientCaFile": "/run/analytics/clients-ca.crt"
  }
}
```

For hosted volume storage, replace the entire `s3` object with:

```json
{ "local": { "directory": "/var/lib/analytics", "prefix": "analytics/global" } }
```

The directory must exist on its dedicated persistent mount. Configure exactly one
storage adapter. There is no automatic creation of directories, buckets or cloud
identities by the analytics process.

For an explicitly selected private S3 installation, use a dedicated identity scoped
to this bucket/root; explicit S3 credentials are
optional when workload identity is configured. Encryption keys are 32 random bytes
encoded as hex; pseudonym keys are at least 32 random raw bytes; producer tokens are
32–128 ASCII token characters (64 hex characters works). Keep key/token/config files
ordinary, owner-only and outside Git/artifacts. Different authorities use different
roots, keys and tokens. Production uses mTLS/TLS 1.3. Plaintext is available only in
explicit loopback development; HTTPS service tests may separately allow a loopback
RustFS endpoint with `s3.allowLoopbackHttp: true`.

A separate native deployment plan contains exactly one analytics role:

```json
{
  "format": 1,
  "services": [{ "kind": "analytics", "configFile": "/run/analytics/config.json" }]
}
```

Run `workspace-backend initialize --config /run/analytics/plan.json` once against an
empty dedicated root, then `workspace-backend serve --config /run/analytics/plan.json`.
Resume uses the same configuration without a recovery owner or a data reset. Never
reuse a Meta root. A nonempty or mismatched installation is rejected.

The Global API's optional analytics section references only its producer client:

```json
{
  "analytics": {
    "service": {
      "endpoint": "https://analytics-global.internal:4329",
      "tokenFile": "/run/workspace/analytics-producer-token",
      "tls": {
        "caFile": "/run/workspace/analytics-ca.crt",
        "certificateFile": "/run/workspace/analytics-client.crt",
        "privateKeyFile": "/run/workspace/analytics-client.key"
      }
    },
    "operatorsFile": "/run/workspace/admin-policy.json",
    "returnUrl": "https://drive9.ai/studio/admin",
    "browserEnabled": true,
    "campaigns": ["launch"]
  }
}
```

A regional API opts in with `{ "analytics": { "enabled": true, "service": { ... } } }`,
using that Region's dedicated endpoint/token/certificates. Its analytics process's
`authorityId` must equal the producing API authority. Allowed campaign labels must
match the Global collector/service configuration. Trusted Console origins and the
registered callback remain required. Missing Admin policy disables Admin without
preventing normal Global serving; policy changes still revoke current sessions. Producer token/TLS configuration is
loaded at startup; restore missing credentials and restart the affected producer to
re-enable it.

The former API-side `pseudonymKeyFile` config is replaced, not aliased. New analytics
never reads or migrates the former Meta namespace. No live capture was enabled by
the implementation PR. If an operator enabled the old profile, arrange its retention
or reviewed analytics-only purge before retiring its old cleaner; never reset Meta
or customer resources for this transition. A consent-required deployment keeps
browser capture disabled until its reviewed policy is implemented. HTTP diagnostics
settings do not enable product analytics.

The generated [Admin/collection contract](../public/operator-openapi.json) is separate
from customer Key contracts; `/operator/openapi.json` under the Global mount serves
it. All reads require the Admin cookie/current policy. Public capture establishes no
customer or operator authority. Date inputs and unsupported filters are validated;
there is no raw-event export. Use the summary and coverage operations for the same
business data the Admin UI reads.

## Hosted enablement and live acceptance

The protected `Configure Global on dev` workflow has separate `inspect-analytics`,
`enable-analytics`, `verify-analytics` and `restart-analytics` operator actions. These consume the existing
same-commit full CI evidence and serialize against the configured API deployment.
They reuse its digest-pinned native image, public SSO callback and existing business
configuration. There is no customer/Meta initialization or data reset.

Enablement creates one private 5 GiB `ReadWriteOnce` PVC per authority through the
cluster's existing StorageClass. SlateDB uses the pinned local filesystem
object-store adapter with fsync enabled. Its directory is mounted only into that
authority's initializer and service, with separate keys and tokens. No new S3 bucket,
IAM identity, OIDC provider, cloud credential or AWS management API is required by
analytics. The existing protected deployment mechanism still supplies cluster access.
Use the unique default class or, without a default, the unique class already bound
in this namespace. Ambiguous or unavailable storage stops preparation; no ephemeral-disk or
Meta fallback is used. Volume creation/attachment and restart recovery must be
observed on the actual target before claiming live availability.

An immutable operator-only preparation Secret retains the exact candidate for
reconciliation after a transport failure. It is never mounted into serving Pods.
Each analytics process receives only its own server/storage configuration; the API
receives only producer credentials and the verified `pingcap.com` Admin policy.
Certificate CA signing keys are discarded after private preparation. Prepared Jobs
initialize each new analytics root once, close it, then single-replica `Recreate`
Deployments start independently. Only after both are ready does a resourceVersion-
guarded API configuration switch enable collection and Admin. A changed target,
failed/uncertain initializer, unexpected ownership or changed persistent volume
stops activation. Existing configuration and prepared resources remain available
for explicit inspection; never blindly reset or repeat a failed initializer.

```sh
gh workflow run global-configure.yml --ref main -f operation=inspect-analytics
gh workflow run global-configure.yml --ref main -f operation=enable-analytics
gh workflow run global-configure.yml --ref main -f operation=verify-analytics
```

The operator action verifies service readiness, ordinary API health, unauthenticated
Admin denial and enabled capture. It deliberately reports real-account login as
unverified. Live acceptance additionally requires a clean browser to show Admin
without Guest initialization, the owner's real TiDB Cloud/PingCAP sign-in, and
observed public visits plus an authorized meaningful business outcome in the
authenticated summary/UI. Credentials and MFA remain user-entered. Keep the live
delivery task open until that complete path is observed; source tests, a merged PR
or a successful configuration job alone do not establish an operational Admin.

The fixed `operator-check` campaign distinguishes live acceptance visits from launch
traffic. `restart-analytics` gracefully restarts only the two retained analytics
Deployments, preserving their roots/credentials and the business Deployment. Compare
authenticated totals before and after that action; graceful recovery does not promise
that every queued event survives an abrupt crash.

## Search discovery and publication

The independent Console build renders installed TiUI 2.9.1 components and the shared
Workspace theme into initial HTML at `discover/`, `discover/get-started/`,
`discover/analyze-sales-data/`, `discover/api/` and `discover/privacy/`, plus sitemap,
robots and a curated `llms.txt` index. Application and Admin HTML use noindex.
The local static server returns 404 for unknown discovery pages instead of the SPA.

The existing `mem9-ai/drive9-fe` publisher requires companion allowlist/routing changes
before importing this build. Its production preparation installs public canonicals
for `https://drive9.ai/studio/discover/`, adds existing public pages to the root sitemap
and links the guide from the website. Preview pages retain noindex and no canonical.
Root robots allow crawlers to read public discovery and the application/Admin noindex
rules; protected APIs retain backend authorization. Do not block an HTML page in
robots.txt and expect crawlers to observe its noindex tag.
Search and training policy are separate; crawler access is not authorization.
[Google documents this noindex/crawling requirement](https://developers.google.com/search/docs/crawling-indexing/block-indexing).

Search Console/Bing ownership and actual hosted OIDC/crawler verification remain
operator steps. Local tests do not prove indexing, rankings, AI citations or live
deployment. AI referrals measure observed referrers only. Google documents normal
SEO foundations for AI features; `llms.txt` is an optional index, not a ranking promise.

## Verification

Native tests use synthetic OIDC identities, isolated RustFS/S3 and a persistent
local directory for the Global analytics process. They cover verified
PingCAP login/denial, ordinary-account/Key denial, replay, policy removal, logout,
duplicate capture across graceful service restart, GPC, origin rejection, report save/non-overwrite and
source-to-result summaries. Domain fixtures cover dedup across midnight, redaction,
cohort denominators, cross-authority isolation and retention cleanup. Browser tests
cover Admin data/permission/error states, opt-out, public pages, existing sales
journeys and responsive themes. Actual command outcomes belong in the implementation
PR and must be current for its candidate; this guide does not assert unrun gates.

The independent service's local comparison used 100 create-only file writes after
10 warmups in each configuration. Enabled/disabled median latency was
407.38/407.20 ms; P95 was 424.24/423.55 ms (differences of 0.18/0.68 ms).
The 30-day summary took 18.99 ms with no unconfirmed events. These synthetic local
measurements do not establish production latency. The isolation acceptance explicitly stops
analytics, removes optional producer credentials, restarts the API, completes normal
business operations and verifies independent analytics recovery and no main Meta rows.
