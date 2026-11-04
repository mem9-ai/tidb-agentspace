# Public launch: adoption, operator insights and search discovery

## Identity and status

| Field               | Value                                                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feature             | GH-182                                                                                                                                                                                                                                |
| Status              | Accepted by the owner; implementation and verification tracked in GH-184; live enablement separate                                                                                                                                    |
| Parent intent       | [GH-182](https://github.com/mem9-ai/tidb.ai/issues/182); keep open through implementation and launch readiness                                                                                                                        |
| Contributors        | Product intent: Siddon Tang; specification: local coding agent                                                                                                                                                                        |
| Maintainer          | Project owner                                                                                                                                                                                                                         |
| Source baseline     | `f8fc201715aad9d10a04bdd9668b0acc85e632d4` (implementation must pin the accepted specification's full merge SHA)                                                                                                                      |
| Risk                | New pseudonymous behavior collection and cross-Workspace aggregate access; public search exposure                                                                                                                                     |
| Dependencies        | [ADR 0044](../../docs/decisions/0044-workspace-observability.md), [Global API](../../docs/global-public-api.md), [TiUI](../../docs/standards/tiui-design-system.md), [API verification](../../docs/standards/openapi-verification.md) |
| Acceptance baseline | LAUNCH-01 through LAUNCH-12 below; proposed until specification acceptance                                                                                                                                                            |

The owner accepted this design on 2026-11-04 and then clarified two requirements:
Admin uses TiDB Cloud login with a verified email in exactly `pingcap.com`; HTTP
operational monitoring is deferred. These amendments supersede the original exact
account allowlist and web-vital/HTTP monitoring scope. The UI entry is `/admin`.
Signing into a personal Workspace does not grant platform access. Runtime details
and measured limitations are maintained in [product analytics](../../docs/product-analytics.md).

## Outcome and scope

Before promotion, answer four questions: Are people arriving? Do they reach a useful
result? Where do they get stuck? Which sources bring people who return?
For example, distinguish 100 landing visits with no trials from 10 trials that
produced five saved reports and two returning Workspaces. Show actual denominators.

Deliver first-party collection, aggregate operator APIs and dashboard, and public
English product/tutorial pages. Include both browser and API use. Keep existing
Workspace audit/history permissions and storage unchanged. This is separate from
customer usage/billing and does not restore the removed Activity interface.

Exclude session replay, keystroke recording, SQL/file capture, fingerprinting,
customer impersonation, billing, marketing automation and a general admin console.
Do not introduce a third-party analytics vendor or a separate analytics database
for initial launch. Revisit storage based on measured load and retention cost.

## Required behavior

### LAUNCH-01: Collect a small, versioned event vocabulary

| Source          | Events                                                                   | Meaning                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser         | `public_page_view`, `try_clicked`, `sign_in_clicked`, `journey_selected` | Public page and explicit entry intent; journey is agent or self-service                                                                            |
| Browser         | `helpful_vote`                                                           | Optional yes/no answer after a useful result; web-vital and HTTP monitoring deferred by owner                                                      |
| Verified server | `workspace_ready`, `sign_in_completed`, `sample_ready`                   | Actual completed onboarding/sample setup, with guest/account actor classification                                                                  |
| Verified server | `operation_completed`                                                    | Fixed operation enum, outcome, duration and safe error category for resource creation, file preview/read/write, query, analysis, import and export |
| Verified server | `report_saved`                                                           | Successful explicit first-party tutorial report save; generic file existence or writes cannot claim an agent report                                |

Server outcomes are emitted from shared domain/transport completion hooks so REST
and Console use the same definitions. Do not infer success from button clicks,
HTTP attempts, copied credentials, file names or a tutorial being marked done.
Key-authenticated usage means API activity, not proof of an autonomous agent.
Agent connection/evidence requirements remain owned by the applicable agent-journey
specifications; do not invent an `agent_connected` event from a copy action.

Browser events accept only versioned, per-event typed fields: random event/session
IDs, fixed page/journey enums, coarse device class, bounded approved campaign IDs,
referrer category and numeric vital values/ratings. No arbitrary property bags.
Unknown fields/events and unsupported versions fail validation. Server events add
trusted timestamps, environment, authority, pseudonymous Workspace/actor IDs,
operation enum, outcome, request ID and duration. Client submissions cannot supply
trusted outcomes, identity, environment, request linkage or operator flags.

### LAUNCH-02: Define visitors and attribution honestly

Public visits use a random session identifier expiring after 30 minutes of inactivity,
with no persistent cross-device visitor tracking. Label unique sessions as sessions,
never unique people. Keep campaign attribution only within that session, through
the trial handoff; bind it to a Workspace only after verified session authorization.
Never merge unrelated identities based on email, IP or a client-supplied Workspace ID.

Record first public entry per session: fixed page ID, approved campaign ID and
referrer category (`search`, `ai_referral`, `social`, `other`, `direct_or_unknown`).
Map only configured campaign tokens to approved labels; discard unknown raw UTM
values and full referrer URLs. Referrer absence means unknown/direct, not proof
of direct navigation. Track campaign links consistently across public pages and
trial/login handoff without forwarding arbitrary query parameters into OIDC.

Authenticated retention uses a purpose-specific keyed pseudonym of authority and
Workspace ID. Guest and account cohorts stay separate. Cross-device/cross-Workspace
person counts and guest-to-account conversion are unavailable unless an existing
verified product transition provides that linkage. Do not invent it for analytics.

### LAUNCH-03: Make metrics reproducible

All buckets are UTC, with the timezone visible; default range is the last seven
complete days, with Today, 7 days and 30 days available. Today is explicitly partial.

| Metric                 | Definition                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visits and acquisition | Distinct public session IDs by entry page and source; browser-observed and approximate                                                                                        |
| Trial conversion       | Sessions with a verified `workspace_ready` trial handoff / eligible public entry sessions in the same range                                                                   |
| First useful result    | First successful explicit query, analysis, tabular preview, import/export or report save per Workspace; passive resource listing and polling excluded                         |
| Activation             | Workspaces created in range reaching first useful result within 24 hours / Workspaces created in range; incomplete 24-hour cohorts labeled pending                            |
| Time to value          | Median and p90 from server Workspace readiness to first useful result among activated Workspaces; show sample count and never treat non-activators as zero seconds            |
| API adoption           | Distinct Workspaces with successful Key-authenticated meaningful operations; kept separate from browser visits and human counts                                               |
| Active and returning   | Meaningful success per Workspace/day; D1 and D7 retention are activity in UTC day +1/+7 from first meaningful-success day / eligible activated cohort, split by guest/account |
| Friction               | Attempts, successes, failures, safe failure categories and p50/p95 durations by operation; exclude routine polling and identify insufficient samples                          |
| Experience             | Helpful yes / answered votes and LCP/INP/CLS distributions, separately with sample counts; do not claim these measure satisfaction for everyone                               |

An ordered conversion funnel counts only sessions/Workspaces with the required
preceding step. Browser-only intent and authoritative results are distinguishable.
Server outcomes without a browser session contribute to API/Workspace metrics,
not to browser conversion. Retries are separate attempts but never duplicate a
deduplicated event or first activation. Retention is Workspace retention, not person
retention; expired temporary Workspaces are a separate cohort. Empty denominators
show unavailable, not 0% or NaN.

### LAUNCH-04: Protect customer information and respect collection choices

Never retain SQL, shell commands, file paths/contents, resource names, query results,
credentials, cookies, email, raw user agent, IP, raw URLs, query strings, DOM,
stack traces or upstream error text in analytics records. Hashing customer content
is not an acceptable substitute for omission. Prefer enums and coarse buckets.

Provide a public analytics notice and a persistent opt-out control; optional browser
measurement is disabled when opted out or Global Privacy Control is enabled.
Default to session-only first-party measurement with no cross-site tracking.
If deployment policy requires affirmative consent, capture nothing optional before
consent; deployment must explicitly select its reviewed policy. Necessary security
and operational diagnostics remain separately described and are not repurposed as
marketing events when optional measurement is disabled. Optional linkage to browser
acquisition stops at opt-out. Do not make legal compliance claims from this design.

Retain raw analytics events for at most 30 days and identity-free daily aggregates
for at most 90 days. D1/D7 cohort computation may use raw pseudonymous records
within this window. Purge expired raw data and pseudonym/linkage records daily;
do not keep hidden indefinite identifiers in dedup indexes, queues, logs or backups.
Document backup expiry and restoration-time expiry enforcement before launch.

### LAUNCH-05: Bound ingestion and expose incomplete coverage

Use an isolated analytics namespace and bounded daily partitions, distinct from
Workspace history. Regional services write only their own events; Global owns
public acquisition/login events. Transfer only authenticated, versioned daily
summaries/cohort contributions to the operator aggregation service; no Global
credential gains arbitrary regional customer record reads. A companion ADR must
freeze the service identity, pseudonym-key ownership and transport before code.

Start with existing metadata primitives, incremental aggregates and indexed reads;
dashboard requests never scan every Workspace or customer file. Initial limits:
20 events/32 KiB per browser batch, 100 pending events per tab, 60 batches/minute
per session with additional bounded process and edge limits, and 1,000 pending
server events per process. Edge limit state may use transient IPs without retaining
them in analytics. Session limits alone are not abuse protection.

POST success (`202`) means durably accepted after schema validation/deduplication;
queue-only admission must not return a durable acknowledgment. Unique event IDs
are idempotent within the 30-day raw retention window, scoped by trusted producer
identity/session. Conflicting reuse returns `409`; identical retries do not add counts.
Browser requests retry at most twice with backoff, then drop; never block navigation.
Use server receipt time for bucket admission, reject impossible numeric values,
and treat public events as untrusted even when accepted. Public spam cannot forge
activation, sign-in success or retention.

Return `413` for oversized input, `422` for schema failures, `429` with Retry-After
for limits, and `503` when durable ingestion is unavailable. Apply exact Origin and
content-type checks, TLS in hosted mode, and same-origin public collection routing;
CORS is not authentication. Public capture must not issue an account/Owner session.
Optional telemetry cannot fail a completed business action or replay its effects.
Bound server flushes outside the request critical path; count dropped/unconfirmed
events and expose coverage gaps. Process crashes may lose unacknowledged outcomes;
show uncertainty rather than promising an audit-complete product funnel.

### LAUNCH-06: Designated TiDB Account operators only

Reuse verified TiDB Account OIDC code/PKCE verification, with a distinct operator
session bound to verified `(issuer, subject)` and a verified email in exactly
`pingcap.com`, plus current private policy. Reject unverified email, other domains
and suffix/subdomain lookalikes. No first-user admin, Workspace-owner inheritance
or Git-email inference.
Missing private policy denies all access. Personal onboarding remains unrestricted by
operator grants, and operator login never adds Workspace ownership.

Require authenticated operator session and current private-policy membership on every
analytics read, including pagination and exports. Reuse existing state/nonce/replay,
trusted-origin, host-only Secure HttpOnly SameSite cookie and CSRF protections.
Maximum operator session lifetime is one hour; logout/revocation ends access.
Removal from configuration must invalidate membership on the next request after
configuration activation, including existing sessions. Invalid/expired session:
`401`; authenticated non-operator: `403`, before any analytics storage read.
Workspace Keys, guest credentials and local owner bypasses cannot access it.

An operator sees aggregate usage and ingestion health only. No customer files,
SQL, keys, email directory, account impersonation or per-customer data browser.
Audit operator sign-in, denial and summary reads with bounded safe metadata,
separately from the measured product usage, so viewing analytics does not inflate it.

### LAUNCH-07: A small, useful operator dashboard

Console route: `/admin`; direct visits offer “Sign in with TiDB Account”.
Keep the route out of regular customer navigation. The first view is “Product
insights”: visits, active Workspaces, activation and return usage, followed by the
entry-to-result funnel, acquisition table, friction and ingestion coverage.
Provide date/source/journey/actor filters only where the metric supports them.
Show denominators, sample size, freshness and missing Regions beside affected data.
Label source data as approximate or verified, including bot-filtering limitations.

Use installed TiUI and shared theme adapters, English copy, accessible chart tables,
keyboard navigation, both themes and narrow layouts. Persist only nonsensitive view
preferences. Distinguish loading, no traffic yet, insufficient samples, permission
denial and unavailable data. Never replace a failed fetch with zeros. On re-entry,
restore the chosen date range; an expired session returns to sign-in.

### LAUNCH-08: Document complete APIs

All paths below are proposed, relative to the configured authority prefix. Publish
an operator-specific generated contract, separate from Workspace Key capabilities.
Generate types/contracts from the canonical generator during implementation.

| Outcome                                    | Proposed operation                                                                                                                                           | Authority/authentication                                   | Acceptance         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------ |
| Collect optional browser events            | `ingestProductEvents`, `POST /analytics/events`                                                                                                              | Global collection adapter; anonymous untrusted events only | LAUNCH-01/02/04/05 |
| Discover operator session                  | `getOperatorSession`, `GET /operator/session`                                                                                                                | Global; operator cookie, current grant                     | LAUNCH-06          |
| Begin/finish sign-in and logout            | `beginOperatorLogin`, `GET /operator/auth/login`; `completeOperatorLogin`, `GET /operator/auth/callback`; `endOperatorSession`, `POST /operator/auth/logout` | Global; OIDC browser-bound flow / CSRF-protected logout    | LAUNCH-06          |
| Read overview                              | `getProductInsights`, `GET /operator/analytics/summary`                                                                                                      | Global; operator only                                      | LAUNCH-03/06/07    |
| Read acquisition/funnel/friction/retention | `getProductInsightBreakdown`, `GET /operator/analytics/breakdowns/{kind}`                                                                                    | Global; operator only                                      | LAUNCH-03/06/07    |
| Inspect freshness and gaps                 | `getProductAnalyticsCoverage`, `GET /operator/analytics/coverage`                                                                                            | Global; operator only                                      | LAUNCH-05/07       |

Summary inputs: inclusive `from`, exclusive `to` UTC dates, maximum 31 days; optional
approved source/journey/actor enums. Unsupported filter/metric combinations return
`422`. No raw event list/export is provided. Breakdown pages have at most 50 rows,
stable count-descending/label-ascending order and a signed, filter-bound cursor with
15-minute expiry. Return a shared snapshot time, range, definitions version,
coverage, sample counts, nullable ratios/percentiles and next cursor. Partial Region
coverage is explicit. GETs are retry-safe and private/no-store; no background job or
polling API is needed for these bounded aggregate reads. Server transport uses the
existing structured error shape and safe request IDs.

### LAUNCH-09: Publish useful pages that crawlers can read

Serve build-generated public HTML from the independently deployable Console/static
hosting surface: `/`, `/docs/get-started`, `/guides/analyze-sales-data`, and
`/docs/api`. Preserve the existing private application entry/deep links; select
the final route map after inspecting the actual hosting prefix. No API-served
Console assets or parallel Node business runtime. This is repository work, not
an independent website-builder project.

Every public page has meaningful initial HTML without executing JavaScript,
unique title/description/H1, semantic headings, navigable links, absolute canonical
URL, Open Graph/social metadata and descriptive images where used. The homepage
states who it serves, actual PostgreSQL/File System capabilities, one concrete
worked example, temporary Workspace limits and a clear “Try without an account”
action. Tutorials state reproducible inputs, steps, expected result, limitations,
last substantive update and a contextual trial CTA. API docs link to current
OpenAPI and downloadable agent instructions; do not duplicate a stale contract.
Any SoftwareApplication/Organization JSON-LD must match visible verified content;
do not invent pricing, reviews, provider availability or performance claims.

Generate `sitemap.xml` only from approved public canonical URLs. Provide accurate
`robots.txt`, real `404` responses and redirects for actual moved pages. Never
return the SPA with `200` for unknown public content. Include only meaningful
content changes in sitemap lastmod. Query campaigns do not create indexable pages.

### LAUNCH-10: Keep private surfaces private; make AI discovery measurable

Use `noindex` and private/no-store response policy for application, operator,
callback and session surfaces as appropriate. Exclude these from sitemaps. Public
OpenAPI/docs stay crawlable. Robots rules are discovery controls, not authorization;
restricted data always needs backend authentication. Preview/staging hosts default
to noindex and do not emit production canonicals until explicitly configured.

Permit search crawlers on approved public pages, including OAI-SearchBot. Training
crawler policy is a separate operator choice; do not automatically enable training
access to improve search visibility. Validate CDN/WAF access as well as robots
rules. A user-agent claim alone does not establish verified crawler identity.
Separate crawler requests from browser sessions and authenticated meaningful use;
do not claim perfect human/bot classification. AI referral means observed referral
traffic, not evidence of citations, ranking or AI impressions.

AI search optimization starts with clear, crawlable, factual pages and useful
examples. `llms.txt` may be an optional curated docs index; it is not a launch gate
or a ranking guarantee. Google states that its AI features use normal SEO foundations
and require no special schema/files. OpenAI documents separate search/training
crawler controls. Verified references (2026-11-04):
[Google AI features](https://developers.google.com/search/docs/appearance/ai-features),
[OpenAI crawlers](https://developers.openai.com/api/docs/bots).

### LAUNCH-11: Launch and evaluate the complete acquisition loop

After configuring the approved public origin, verify canonical HTTPS redirects,
HTML, sitemap, crawl policy, social preview and real guest/sign-in handoff. Record
campaign IDs for each promotion channel. Register/verify Search Console and Bing
Webmaster Tools only with the owner's authorized account; submit the sitemap and
record verification evidence. These external account actions remain pending until
credentials/access and production domain are supplied.

Evaluate weekly: qualified visits, trial conversion, activation, time to value,
returning Workspaces and source conversion. Search Console impressions/clicks and
observed AI referrals are different datasets. Initial dashboard need not integrate
external reporting APIs; do not fabricate search impression counts. For a small
launch show raw counts alongside rates and avoid conclusions from tiny samples.

### LAUNCH-12: Isolation, performance and reversibility

Feature flags independently disable browser collection, server analytics and
operator presentation. Existing Workspace/API behavior remains usable during an
analytics outage. Stopping collection does not delete prior records; retention
cleanup remains active. No resource recreation, customer metadata migration,
provider credential changes or chargeable infrastructure is authorized by this spec.
Measure before/after in an isolated fixed workload of 100 meaningful operations;
analytics may add no more than 5 ms median/20 ms p95 handler overhead locally,
excluding provider work. Report the measurement environment and observed losses;
these are local acceptance thresholds, not production SLAs. Aggregate read of a
30-day seeded fixture completes within two seconds locally without customer scans.

## Acceptance cases and evidence plan

| Requirement | Required observation                                                                                                                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LAUNCH-01   | Native HTTP/domain tests distinguish attempts, failures and success; forged browser success/identity fields rejected; API-only meaningful operations counted                                                                                              |
| LAUNCH-02   | Two sessions in one browser count as sessions, not people; approved source survives verified trial handoff; arbitrary UTM/referrer/token strings omitted; no unauthorized identity merge                                                                  |
| LAUNCH-03   | Fixed UTC fixture: 10 ready Workspaces, 4 activated gives 40%; 2 return on D1 gives 50% of eligible activated cohort; pending cohorts, zero denominators, API-only traffic, duplicates and boundary dates asserted                                        |
| LAUNCH-04   | Canary secrets in paths/SQL/headers/error text absent from events, queues, storage and operator responses; opt-out/GPC suppress optional collection; advancing clock expires raw/aggregate/dedup/linkage data and restore does not resurrect expired data |
| LAUNCH-05   | Duplicates/restart do not inflate durable accepted counts; oversized/spam/conflicting batches rejected; unavailable store cannot acknowledge durability; queue saturation/crash exposes incomplete coverage without breaking business success             |
| LAUNCH-06   | Synthetic OIDC success for designated identity; missing/expired/revoked/replayed sessions denied; ordinary account, guest, Workspace Key, same-email different subject and removed grant denied before analytics read; no new Workspace ownership         |
| LAUNCH-07   | Browser assertions cover login, filters, totals, permission denial, empty, partial and unavailable states; desktop/narrow light/dark screenshots support visual review                                                                                    |
| LAUNCH-08   | Generated operator contract matches native responses; all business reads work through HTTP without dashboard interaction; invalid filters/cursors and cross-session cursor reuse fail safely                                                              |
| LAUNCH-09   | Fetch built pages with JS disabled: meaningful body, headings, links, canonical and matching metadata; sitemap contains only public routes; unknown page is 404; trial CTA reaches usable Workspace                                                       |
| LAUNCH-10   | Public pages fetchable by approved crawler fixtures; private HTML carries noindex and protected APIs reject anonymous access; preview noindex; no secret/private URL in public artifacts                                                                  |
| LAUNCH-11   | Synthetic tagged entry reaches actual first-result counter; production domain/crawl/search-tool verification recorded separately from local fixture evidence                                                                                              |
| LAUNCH-12   | Fault injection, kill switches, bounded storage scans and measured overhead fixture; product operations remain available and are not replayed on analytics failure                                                                                        |

## Delivery, open inputs and recovery

1. Accept this specification and a companion analytics authority/retention ADR;
   pin the merged full Git revision in bounded implementation tasks.
2. Implement typed capture, aggregates and native acceptance first; operator APIs
   and TiUI dashboard follow with a complete usable path. Do not enable collection
   without its notice/policy and retention controls.
3. Implement public static pages, search metadata and verified promotion handoff.
4. Configure operator identities and public origin, validate hosted SSO/crawl access,
   then enable capture for launch. Production deployment retains existing target,
   environment protection and operator-owned health/recovery requirements.

Open deployment inputs: canonical public origin, designated verified issuer/subject
identities, collection/consent policy and authorized search-tool accounts. Do not
embed private identities in Git. These block live enablement, not fixture development.

For this specification-only change, verify Markdown formatting, repository policy,
links and current source references under the documentation-only gate in
[CI/CD](../../docs/ci-cd.md). No executable contracts, UI or Rust code changes here;
runtime, native and browser suites do not establish this proposed behavior.
Implementation requires the applicable `npm run check`, `npm run backend:check`,
contract/native tests and browser assertions, reusing exact-head CI artifacts.
Do not repeat unrelated provider suites outside enforced gates or run live cloud
provisioning for analytics acceptance. Any failed or unavailable check is reported.

Rollback disables the relevant collection/UI flag and rolls back code; it does not
undo a public crawl or erase retained records. Privacy/retention cleanup continues.
Do not claim improved rankings, deployed analytics or live operator access from a
merged design. The parent intent closes only after implementation and agreed
launch-readiness evidence; no public deployment is performed by the design PR.
