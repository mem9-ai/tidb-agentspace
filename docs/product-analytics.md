# Product analytics and Admin

Implementation for [GH-184](https://github.com/mem9-ai/tidb.ai/issues/184), against
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

Native completion hooks count meaningful product outcomes for Console and API use:
query, file analysis/preview, import/export and explicit report saving. Listing and
polling do not activate a Workspace. Key-authenticated activity is API usage, not
proof of an autonomous agent. Generic file writes cannot claim `report_saved`.

`POST /workspaces/{workspaceId}/reports` saves an explicit user-supplied report as a
new file with `files:write` and selected-resource authorization. It never overwrites
an existing path, returns 201 with a file-metadata Location, and uses existing file
read/content operations for inspection. A lost response is reconciled through file
metadata; the client must not replay it as an overwrite. A successful save is not
evidence of report quality or agent authorship. The self-service sales path uses it.

## Storage and retention

Reuse the native encrypted SlateDB Meta service, with durable WAL acknowledgment
to its existing private S3 object storage. No separate analytics database, vendor
account, customer File System or public bucket is introduced. Global and Regions
retain their independent authority/storage/encryption boundaries.

Each authority uses `Scope::system(authority, "product-analytics", "analytics-v1",
"daily")`. Raw events, deduplication, 30-day identity-bearing projections, approved
attribution and identity-free daily totals have separate prefixes. Sixteen subject
shards per UTC day avoid one shared update counter. Atomic compare-and-set commits
couple an accepted event, its dedup receipt and materialized projection/total.
Dashboard reads use projections rather than raw events or customer Workspace scans.

The bounded launch profile accepts up to 1,024 events per shard/day (16,384 per
authority/day, with possible earlier saturation for a hot subject). Public capacity
rejection is 429; server queue/write loss is visible as unconfirmed coverage. The
server queue holds at most 1,000 jobs and does not block completed product requests.
HTTP 202 for browser capture means durable acceptance, not in-memory admission.
Events within a batch commit individually: a failed batch may be partially retained;
retry the same IDs, never generate replacements to retry an uncertain outcome.

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

The backend reads a private ordinary file (owner-only permissions, no symlink):

```json
{ "subjects": [], "verifiedEmailDomains": ["pingcap.com"] }
```

An empty policy denies all. Explicit subjects can restrict a private installation,
but cannot bypass the verified PingCAP-domain requirement. The browser never reads
this policy file. Admin exposes aggregate insights only; there is no customer data,
credential, impersonation or raw-event browsing API.

## Private runtime configuration

Capture is disabled by default. The independently generated Global role config can
add this optional section (example deployment paths, no keys in source):

```json
{
  "analytics": {
    "pseudonymKeyFile": "/run/workspace/global-analytics.key",
    "operatorsFile": "/run/workspace/admin-policy.json",
    "returnUrl": "https://drive9.ai/studio/admin",
    "browserEnabled": true,
    "campaigns": ["launch"]
  }
}
```

Each regional API config independently opts in:

```json
{
  "analytics": {
    "enabled": true,
    "pseudonymKeyFile": "/run/workspace/region-analytics.key"
  }
}
```

Use ordinary owner-only key/policy files and at least 32 random key bytes. Existing
trusted Console origins and the exact registered callback remain required. Do not
copy real private runtime config, email claims or key bytes into Git. A deployment
requiring another collection/consent policy must leave browser capture disabled
until that policy is implemented and reviewed. The existing diagnostics settings do
not enable marketing measurement.

The generated [Admin/collection contract](../public/operator-openapi.json) is separate
from customer Key contracts; `/operator/openapi.json` under the Global mount serves
it. All reads require the Admin cookie/current policy. Public capture establishes no
customer or operator authority. Date inputs and unsupported filters are validated;
there is no raw-event export. Use the summary and coverage operations for the same
business data the Admin UI reads.

## Search discovery and publication

The independent Console build emits initial HTML at `discover/`, `discover/get-started/`,
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

Native tests use synthetic OIDC identities and isolated RustFS/S3. They cover verified
PingCAP login/denial, ordinary-account/Key denial, replay, policy removal, logout,
durable duplicate capture, GPC, origin rejection, report save/non-overwrite and
source-to-result summaries. Domain fixtures cover dedup across midnight, redaction,
cohort denominators, cross-authority isolation and retention cleanup. Browser tests
cover Admin data/permission/error states, opt-out, public pages, existing sales
journeys and responsive themes. Actual command outcomes belong in the implementation
PR and must be current for its candidate; this guide does not assert unrun gates.
