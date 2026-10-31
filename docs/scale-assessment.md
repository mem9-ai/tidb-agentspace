# Tenant and Workspace scale assessment

Status: code inspection, updated 2026-10-31. This is not a capacity benchmark or service-level commitment. The current co-located single-writer dev deployment cannot be claimed to support millions of Tenants or one Workspace with a million resources. The latter is already blocked by a concrete implementation limit. An opt-in bounded resource list and single-record update have been implemented, but most product paths still require the legacy Workspace view; see [ADR 0033](decisions/0033-sparse-scale-metadata.md) for status and the proposed shard design.

## What exists

- Verified `(iss, sub)` maps to a deterministic identity-scoped Global metadata record; personal Tenant and Workspace IDs are distinct. Records share the configured Global SlateDB authority, not one database or process per Tenant. Separate Global and Region authorities use separate object-store roots. Region session verification does not call Global.
- SlateDB provides serializable transactions, native ordered-prefix scans, durability barriers and fenced ownership in the current Meta implementation. The API layer is not yet a direct paginated resource repository: these underlying primitives do not by themselves make the public product scalable.
- The regional managed Workspace cache defaults to 128 open entries, configurable up to 4,096. This is a limit on simultaneously cached/open Workspaces, not a limit on the total number of tenants. Eviction closes an idle Workspace; if every entry is in use the pool returns 429. The shared mutex covers authentication and remote open/close, and eviction scans the pool, so churn and slow storage can create cross-Tenant contention.
- The regional API's in-process request semaphore permits eight simultaneous requests. The separate HTTP Meta server has its own eight-permit semaphore; in-process Meta access does not traverse that HTTP server. These are concurrency limits, not measured throughput limits.
- Guest expiry has 64 durable partitions. The co-located host runs one scheduler at a one-second interval, requesting up to 128 due and 128 logout entries in one partition per tick, then processes those entries sequentially. Even before provider and storage latency, a full empty scan takes roughly 64 ticks; actual deletion throughput and expiry lag are unmeasured. Unsupported deletes remain pending reconciliation.

## One Workspace with one million resources

The ordinary repository `read` and `transaction` paths take a Workspace-wide lock and scan/materialize the `state/` records, with a hard limit of 4,096 records or 24 MiB. Resources share that budget with other state; 4,096 is **not** a promise of 4,096 usable resources. Once the aggregate limit is reached the code returns `WORKSPACE_VIEW_LIMIT` (413). Individual resource point lookups, explicit resource pages and Guest cleanup have more targeted paths, but they do not remove the ordinary state-view limit. Most writes inflate, modify and compare the full state; some Key comparisons are nested. Consequently ordinary reads/writes become more expensive as state grows even before the hard cap.

At one million resources, a 100-record page size implies at least 10,000 sequential page fetches for a full scan, before accounting for associated state, latency and memory. At an illustrative 2 KiB of logical metadata each, the records alone are about 1.9 GiB; this is an arithmetic example, not measured record size or physical storage cost. Raising the limit would amplify latency, memory use and contention rather than solve the design problem.

An explicit resource page reads by ID without materializing the whole Workspace. Resource
status updates address one record; independent updates can progress concurrently. Key
management, settings and event listing now load the Key and event collections plus the
specific resources they reference, and event append loads only events. These paths still
coordinate with legacy transactions through a Workspace-wide gate; Key collections retain
the per-prefix view limit, and the Portal/bootstrap and resource creation are still limited.
Deletion reads only the target resource but local cleanup still loads Workspace file records.

## Millions of Tenants

Nothing in the per-identity key encoding is itself a demonstrated million-Tenant ceiling. However, one Global and one Region Meta authority each own one SlateDB root/writer, and the co-located host, bounded open pool, common request capacity, per-Workspace writer coordination and cleanup executor form shared bottlenecks and failure domains. Every Meta operation currently checks object-store ownership and acquires an appropriate durable snapshot, so network latency, request rate and object-store operation costs matter even when total data fits. There is no measured million-Tenant scale, high-cardinality load profile, noisy-neighbor isolation, shard balancing, region failover or recovery SLO in this repository. Tenant count alone does not determine required throughput: active fraction, request mix, concurrency, skew and bursts must be specified.

## Required next steps

1. Replace full-state `read`/`transaction` for resource and Key paths with tenant-scoped point reads/writes and bounded indexed scans. Add stable cursor pagination and explicit consistency semantics to the public API and Console; keep authorization on every page. Maintain indexes transactionally and make resource creation/idempotency/recovery bounded.
2. Replace process-wide pool locking during I/O with per-Workspace or sharded coordination, a bounded async open/eviction path, request budgets, backpressure and noisy-neighbor controls. Preserve exact writer ownership and revoke/fence in-flight operations.
3. Partition Global directory and each Region's metadata into independently operated cells/shards. Separate the stateless serving tier from Meta writers, route by Tenant/Workspace and split very large Workspace resource ranges; shard movement needs epoch fencing, resumable transfer and durable routing without Region-to-Global calls. One hot Workspace must not force all its data through one all-record transaction or one worker.
4. Make cleanup scheduling partitioned, rate-limited and measurable, with bounded provider concurrency, backlog/expiry-age metrics and retry/idempotency semantics. Retain unsupported or unconfirmed deletes.
5. Benchmark isolated, production-like object storage with representative 1M+ identity records and one 1M-resource Workspace; include hot/cold cache, skew, burst and sustained rates, p50/p95/p99, memory, cost, restart, writer failure, resharding and authorization checks. Define throughput, latency, RPO/RTO and cleanup-delay targets before selecting shard counts. Record actual numbers and environment; do not promote synthetic fixtures into capacity claims.

See [metadata design](slatedb-metadata-design.md), [ADR 0030](decisions/0030-personal-account-isolation.md) and [ADR 0032](decisions/0032-writer-safe-dev-release.md). The target organization/cell design is a proposal; only the current code and limits above are implemented.
