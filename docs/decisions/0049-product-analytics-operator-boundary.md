# ADR 0049: Product analytics and operator authority

- Status: Proposed for [GH-182](https://github.com/mem9-ai/tidb.ai/issues/182);
  no runtime or deployment changes.
- Date: 2026-11-04.
- Contract and acceptance: [launch specification](../../specs/gh-182/spec.md).

## Context

Workspace request history is a customer-authorized regional diagnostic surface,
not a platform analytics feed. Launch measurement needs acquisition, meaningful
outcomes and return usage across Workspaces, including API use. Reusing Owner
permissions or raw customer history for this purpose would change its authority
and privacy boundary. The owner requires designated TiDB Cloud accounts only.

## Proposed decision

Introduce a distinct operator identity/session and aggregate product-analytics
domain. Reuse TiDB Account verification but authorize exact verified issuer/subject
pairs from private configuration on every operator request. No personal Owner,
Workspace Key, email-domain rule or first-user bootstrap grants operator access.
Operator rights provide analytics aggregates only, with no customer content,
credential retrieval, impersonation or arbitrary regional metadata access.

Global captures public acquisition and verified login events. Regions capture
verified business outcomes in a separate, bounded metadata namespace; existing
Workspace history, its retention and its authorization remain unchanged. Raw
events stay within their producing authority. Use existing metadata services
initially; do not provision another database without measured need.

Each authority owns a private analytics-specific pseudonym key, distinct from
encryption, access-signing and customer keys. Region-qualified Workspace pseudonyms
allow local cohort calculation. Global never receives the regional key or raw
Workspace identity. Rotations explicitly break linkage; disclose that measurement
boundary and expire old key material after the retention window. No browser can
choose a trusted pseudonym or business success event.

Regions submit versioned summary snapshots over the existing authenticated
control-plane trust framework with a dedicated analytics-publish capability. Freeze
the concrete adapter and generated internal contract before implementation. Tokens
must bind producer authority, operator-analytics audience and short expiry; they
cannot authorize Workspace APIs or metadata reads. An explicit producer registry
rejects unknown Regions. Do not share customer or operator session credentials.

Summary identity is `(producer, UTC day/cohort day, metric version, dimensions)`.
Include monotonic revision, snapshot time, coverage counters and bounded metric
values. Replace the previous snapshot transactionally, never add each retry to the
total. Identical retries are no-ops; stale revisions cannot overwrite newer data.
Reject invalid dimensions, oversized snapshots and mismatched producer/authority.
Retention reports use counts of eligible/returning Workspaces, not their identities.
For acquisition-to-trial linkage, Global issues an opaque single-use handoff with
a ten-minute expiry bound to the originating browser session and its collection
choice. After verified Workspace authorization, Global consumes it and sends only
the approved campaign/page/journey dimensions through authenticated regional
control. The browser cannot choose the destination Workspace or manufacture
attribution from a Workspace ID. Opt-out clears the pending handoff. Regions
include these approved dimensions in aggregate activation/cohort summaries; no
browser session ID or raw referrer crosses into operator summaries. API-only and
expired/unlinked handoffs stay unattributed. Retries reconcile the same handoff,
never attach it to a different Workspace. Do not infer cross-Region people counts
by summing Workspace counts.

Apply per-event field allowlists before persistence. Retain raw pseudonymous events
and dedup/linkage state for at most 30 days, identity-free daily aggregates for at
most 90 days. Cleanup and restore enforce expiry. Collection gaps, unconfirmed
writes and partial Regions are visible; product analytics is not complete security
audit or billing evidence. Public collection stays untrusted and separately limited.

## Consequences and compatibility

This adds operator/ingestion contracts and private configuration but grants no new
Workspace Key scopes. Keep customer, operator and public collection contracts
separate. Console and API remain independently deployed. Aggregate reads must use
bounded indexed snapshots, not enumerate customer Workspaces or provider resources.

The first dashboard cannot identify individual customers or reconstruct sessions.
Browser session counts, account/guest Workspace activity and API usage have distinct
denominators. Cross-Region person attribution and global person retention are
unavailable; do not hide these limits. Partial data is useful only with visible coverage.

## Verification, rollout and recovery

Native tests must cover ordinary-account denial before analytics access, revoked
operator grants, session replay/expiry, producer impersonation, summary replay and
revision conflicts, expiry after restart, canary-secret redaction and no changes to
customer ownership. The specification defines metric fixtures and browser checks.

Deploy capture and dashboards behind independent flags only after the collection
policy, identity configuration and retention controls are verified. No customer data
migration or provider action is needed. Rollback stops new capture/presentation;
expiry cleanup continues. Revisit this design after the first measured launch,
before adding identity drill-down, a vendor, a new store or cross-authority raw data.
