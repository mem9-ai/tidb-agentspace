# ADR 0044: Workspace audit and request history

- Status: Accepted for [GH-119](https://github.com/mem9-ai/tidb.ai/issues/119). The regional phase is implemented in this revision; Global history remains planned. Deployment is not implied.

The owner removed the Console Activity views on 2026-11-02 because the hosted experience was slow
and did not provide useful, clear information. The regional APIs and retained records are unchanged.
Console presentation described below is the accepted design for a future useful history experience,
not a claim that those views are currently available.

- Date: 2026-11-02.
- Extends [Global and Regional security](0034-openapi-security-authorities.md), [sparse metadata](0035-sparse-scale-metadata.md), and [the feature proposal](../../specs/gh-119/spec.md).

## Problem and decision

A Workspace owner needs both a trail of significant changes and diagnostics for API requests. The current latest-200 successful-change feed is neither complete security audit nor request history. Add separately labeled, independently stored audit and HTTP streams with explicit authority, coverage, retention and loss state. Preserve the legacy feed during migration and never backfill it as complete audit history.

Global and each Region are separate authorities and sources of truth. Each records only operations it actually serves and exposes an owner-authorized list under that authority. Ship Region request history and the scoped Region audit together first; ship Global request and Key-lifecycle audit in a following bounded change. The first phase must clearly state that Global activity is unavailable. The Console chooses the source and identifies it; it must not imply a complete merged multi-Region chronology. A later aggregate requires an independently specified, authorized and bounded design. Workspace attribution happens only after identity and authority verification: an invalid bearer token, forged Workspace path or anonymous request is never attributed to the claimed customer Workspace. Unattributable failures are platform-only, outside the Workspace feed, and disclosed as a coverage limit.

The first version grants list access to the verified Workspace Owner session, with authorization and revocation rechecked on every page. Existing Workspace Keys gain no new access implicitly. Any agent access requires an explicit new scope and resource-filtering decision. Both list operations are part of the public API contract and share the domain operations used by the Console; they are not direct metadata reads from the browser.

## Records, retention and disclosure

Request diagnostics contain server-generated IDs, validated actor and Workspace identity, authority/Region, allowlisted operation and method, response code, start/end times and duration. They never store raw URL paths or query strings, request or response payloads, headers, cookies, IP addresses, SQL, Bash, file bytes, tokens, secret material or raw upstream errors. Unknown operations use a fixed safe label. History-list requests are excluded to prevent recursive capture. Request duration ends at response headers; streaming-body completion is not implied by the status code. Record creation occurs after identity is trusted, with bounded queues and a visible dropped/degraded indicator; a diagnostics failure must not silently retry customer operations.

Security audit records significant access decisions and lifecycle or data mutations with a stable operation ID, trusted actor and target, authority, timestamps, decision and `attempted`, `succeeded`, `denied`, `failed` or `unknown` outcome. Per-operation allowlists constrain fields. Before an external side effect, the authoritative operation and durable audit intent must be atomically recorded or coupled through a recoverable idempotent journal; unavailable intent rejects before provider I/O. Completion is recorded from acknowledged outcomes. An uncertain provider result remains `unknown` and is reconciled explicitly; neither UI nor logging automatically replays it. Coverage explicitly enumerates supported actions and gaps, including unauthenticated requests and unavailable authorities.

Initial product defaults are **up to seven days and 100,000 records per Workspace and authority** for HTTP diagnostics, and **up to 30 days and 100,000 records per Workspace and authority** for audit. The earlier age or count limit defines the visible window. The API displays earliest retained time, truncation/loss and coverage start; no compliance or completeness guarantee is implied. Records outside the age window are excluded from reads even if bounded physical cleanup is delayed. Cleanup uses bounded batches; capacity/queue pressure has explicit per-stream behavior and visible degradation. Audit intent must not be silently dropped to preserve availability.

## API, storage and failure boundaries

Regional operations are `GET /api/v1/workspaces/{workspaceId}/request-history` and `GET /api/v1/workspaces/{workspaceId}/audit-history`, with equivalent authority-local Global contracts still to be designed. Responses return records, an opaque cursor, source/coverage, retention and degradation metadata. Page size is 1–100; ordering is stable descending server sequence with unique IDs. Bounded time filters and cursors are validated against authority, Workspace and filter; they are never trusted as authorization. Stale/expired cursors return a documented recoverable error.

The regional Owner-session contract is published separately at `/owner-openapi.json`; the existing Workspace Key contract does not grant history access. The Console identifies regional coverage and preserves the legacy feed. Coverage starts at the first confirmed journal write for that Workspace; it does not guarantee continuous collection. Expiry and count limits are visible, and the earliest retained timestamp is unknown when concurrent updates or a bounded index scan cannot establish it reliably. Diagnostic loss counts across restarts are unknown. Global Key activity and requests are not included.

Use encrypted authority-scoped metadata with separate request and audit prefixes, guarded by the existing Workspace writer fence and metadata authorization. Bounded ordered indexes and compare-and-set commits must survive concurrency, crashes and restart without crossing Workspace boundaries. Batch or partition diagnostic ingestion so requests do not contend on one authority-wide hot counter; measure queue saturation, append throughput and latency under realistic traffic before enabling capture. Do not place request payloads or full streams in bootstrap, public object storage, provider filesystems or internal DuckDB backing stores. List and cleanup use bounded pages. Logging cannot turn a completed side effect into a silent replay; failure messages expose only safe typed errors.

## Delivery and evidence

Implement against a merged, revision-pinned version of [GH-119](../../specs/gh-119/spec.md). Update the API generator, generated contracts, native domain tests and Console together. Verify tenant/resource isolation, expired and revoked sessions, authorization denials, redaction, capacity, cursor integrity, crash/restart, provider failure, uncertain outcomes and no recursive logging. Capture UI empty/loading/error/coverage states and both viewport sizes/themes. Existing successful events remain accurately labeled until their replacement is proven. Rollback stops new capture and leaves prior data untouched; no rollout may claim a complete audit trail without independently verified coverage.

An isolated local exercise, `cargo run --locked -p workspace-test-support --bin history-load`, uses four concurrent clients and 100 authenticated reads against the native API, metadata service, and local RustFS. Before batching, 28 of 101 requests including warmup were retained and the stream reported degradation. After grouping bounded batches by Workspace, all 101 were retained with no observed loss; approximately 76 requests/s and 108 ms p95 were observed for this run. These figures describe a single local workload, not a production capacity guarantee. Measure representative deployment traffic and storage latency before a production rollout.

For operations, the regional HTTP-history worker reports process-wide counts of unconfirmed
records by bounded cause category at most once a minute and on a graceful stop. The report
contains no Workspace identifiers, request contents, or raw errors. A timeout means the write
outcome was not confirmed; it does not establish that the record was lost. These ephemeral
aggregate counts cannot identify affected Workspaces or prove completeness across restarts.
