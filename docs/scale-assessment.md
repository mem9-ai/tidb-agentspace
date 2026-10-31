# Tenant and Workspace scale assessment

Status: code inspection, updated 2026-10-31. This is not a capacity benchmark or service-level commitment. The current co-located single-writer dev deployment cannot be claimed to support millions of Tenants or one Workspace with a million resources. Resource listing, creation and several resource operations now use bounded pages or point reads, but other collections and shared coordination remain; see [ADR 0033](decisions/0033-sparse-scale-metadata.md) for status and the proposed shard design.

An exploratory [single-Workspace million-record page measurement](scale-benchmark-2026-10-31.md)
is available; its limited request sample does not establish end-to-end capacity.

## What exists

- Verified `(iss, sub)` maps to a deterministic identity-scoped Global metadata record; personal Tenant and Workspace IDs are distinct. Records share the configured Global SlateDB authority, not one database or process per Tenant. Separate Global and Region authorities use separate object-store roots. Region session verification does not call Global.
- SlateDB provides serializable transactions, native ordered-prefix scans, durability barriers and fenced ownership in the current Meta implementation. The public resource list and Portal now use bounded pages; these underlying primitives do not by themselves make the public product scalable.
- The regional managed Workspace cache defaults to 128 open entries, configurable up to 4,096. This is a limit on simultaneously cached/open Workspaces, not a limit on the total number of tenants. Eviction closes an idle Workspace; if every entry is in use the pool returns 429. Authentication of a cached Workspace releases the pool mutex while waiting on metadata and retains a lease so eviction and Guest cleanup cannot close it. Cache misses, eviction and cleanup still hold the shared mutex during remote open/close, and eviction scans the pool, so churn and slow storage can create cross-Tenant contention.
- The regional API's in-process request semaphore permits eight simultaneous requests. The separate HTTP Meta server has its own eight-permit semaphore; in-process Meta access does not traverse that HTTP server. These are concurrency limits, not measured throughput limits.
- Guest expiry has 64 durable partitions. The co-located host runs one scheduler at a one-second interval, requesting up to 128 due and 128 logout entries in one partition per tick, then processes those entries sequentially. Even before provider and storage latency, a full empty scan takes roughly 64 ticks; actual deletion throughput and expiry lag are unmeasured. Unsupported deletes remain pending reconciliation.

## One Workspace with one million resources

The previous ordinary repository `read` and `transaction` paths materialized `state/` and
failed at 4,096 records or 24 MiB. Product resource listing, bootstrap, creation, query,
file and export paths now use bounded resource reads or projections rather than materializing
all resource records. The legacy helpers still exist, and individual projected collections
such as local files for selected File Systems retain their own view limits. Thus a large single
File System or other unconverted workflow can still hit `WORKSPACE_VIEW_LIMIT`.

At one million resources, a 100-record page size implies at least 10,000 sequential page fetches for a full scan, before accounting for associated state, latency and memory. At an illustrative 2 KiB of logical metadata each, the records alone are about 1.9 GiB; this is an arithmetic example, not measured record size or physical storage cost. Raising the limit would amplify latency, memory use and contention rather than solve the design problem.

Every resource page reads by ID without materializing the whole Workspace. Resource
status updates address one record; independent updates can progress concurrently. Key
management and settings load only the target Key and the resources they reference. Key listing
is paginated, and event append uses a retained ordered index. Event listing reads at most the
200 retained events. Ordinary mutations use conditional versions and bounded conflict retries
under the shared side of the Workspace gate; creation, backfill and legacy snapshots still take
its exclusive side.
The Portal keeps a bounded 200-resource window. Creation maintains
name, quota and idempotency indexes atomically. The first creation in an existing Workspace
backfills those indexes in resumable batches, so its total latency is proportional to existing
resources. File operations use a per-File-System index after resumable legacy backfill, but still
materialize the selected File System's files. Provider setup and managed-Workspace cache misses
still hold shared locks across I/O.

The current product enforces free-tier limits of five databases per kind and one File System
per region/provider. The scale fixture inserts synthetic records directly; it does not show
that a customer can provision a million resources under the current quota policy. Larger
paid/enterprise quotas and the corresponding provider capacity are not implemented here.

## Millions of Tenants

Nothing in the per-identity key encoding is itself a demonstrated million-Tenant ceiling. However, one Global and one Region Meta authority each own one SlateDB root/writer, and the co-located host, bounded open pool, common request capacity, per-Workspace writer coordination and cleanup executor form shared bottlenecks and failure domains. Every Meta operation currently checks object-store ownership and acquires an appropriate durable snapshot, so network latency, request rate and object-store operation costs matter even when total data fits. There is no measured million-Tenant scale, high-cardinality load profile, noisy-neighbor isolation, shard balancing, region failover or recovery SLO in this repository. Tenant count alone does not determine required throughput: active fraction, request mix, concurrency, skew and bursts must be specified.

## Required next steps

1. Replace full-state `read`/`transaction` for resource and Key paths with tenant-scoped point reads/writes and bounded indexed scans. Add stable cursor pagination and explicit consistency semantics to the public API and Console; keep authorization on every page. Maintain indexes transactionally and make resource creation/idempotency/recovery bounded.
2. Replace process-wide pool locking during I/O with per-Workspace or sharded coordination, a bounded async open/eviction path, request budgets, backpressure and noisy-neighbor controls. Preserve exact writer ownership and revoke/fence in-flight operations.
3. Partition Global directory and each Region's metadata into independently operated cells/shards. Separate the stateless serving tier from Meta writers, route by Tenant/Workspace and split very large Workspace resource ranges; shard movement needs epoch fencing, resumable transfer and durable routing without Region-to-Global calls. One hot Workspace must not force all its data through one all-record transaction or one worker.
4. Make cleanup scheduling partitioned, rate-limited and measurable, with bounded provider concurrency, backlog/expiry-age metrics and retry/idempotency semantics. Retain unsupported or unconfirmed deletes.
5. Benchmark isolated, production-like object storage with representative 1M+ identity records and one 1M-resource Workspace; include hot/cold cache, skew, burst and sustained rates, p50/p95/p99, memory, cost, restart, writer failure, resharding and authorization checks. Define throughput, latency, RPO/RTO and cleanup-delay targets before selecting shard counts. Record actual numbers and environment; do not promote synthetic fixtures into capacity claims.

See [metadata design](slatedb-metadata-design.md), [ADR 0030](decisions/0030-personal-account-isolation.md) and [ADR 0032](decisions/0032-writer-safe-dev-release.md). The target organization/cell design is a proposal; only the current code and limits above are implemented.
