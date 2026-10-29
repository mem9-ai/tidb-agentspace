# GH-74: Metadata scale profile

- Status: Proposed amendment to the [control-plane specification](spec.md); no scale implementation or benchmark claim.
- Owner-requested workload: millions of tenants/Workspaces, including individual Workspaces with thousands to a million resources.
- Authority: [Proposed ADR 0017](../../docs/decisions/0017-workspace-kv-control-plane.md); accepted direction does not imply accepted capacity or availability promises.

## 1. Scale is cardinality, traffic and skew

Workspace is an ownership/policy boundary. It is not one mandatory file, transaction lock,
database, queue, connection pool or execution process. A million resources must not become
one JSON value, one CAS revision or an array inside a Workspace descriptor. The same rule
applies to an Organization with many Workspaces/members and a Key with many resource grants.

Model sparse small tenants and hot large tenants separately. An illustrative inventory of
5 million small Workspaces averaging 20 resources plus 100 additional Workspaces with a
million resources each contains 200 million resources. At an **assumed** 4 KiB of primary
metadata per resource, that is about 819 GB before indexes, replicas, operations, history,
secrets and backup. This is sizing arithmetic, not a measured record size or service limit.
Also measure operations/second, hot-key concentration, churn, active fraction and retention.

A resource means a separately managed database or File System with lifecycle/permissions;
ordinary files, tables and rows are separate data-plane namespaces. Supporting a million
metadata descriptors does not allocate a million provider instances or native connections.
Provider quotas, commercial capacity and active data-plane budgets remain independently
enforced. Inactive resources require no resident process, timer or open database connection.

## 2. Cells, partitions and routing

Within each global or regional authority, deploy shared **cells**: independently budgeted
metadata/worker capacity with a bounded failure domain. A cell is not a geographic product
Region or a dedicated deployment per tenant. Pool small tenants; let a hot tenant span
partitions and, when measured demand requires it, isolate its partitions on dedicated cells.
Global cells own global records; regional cells stay inside their declared region/profile.

Route by `(authority, family, ownerId, subjectId)` using versioned hash-prefix/range maps.
`subjectId` is the resource ID for a resource group, normalized name for a name guard, and
principal/Key/request identity for the corresponding family. Hash the full routing tuple;
using only `workspaceId` puts an entire hot Workspace back on one shard. Keep ordered query
indexes separate from write distribution, and shard their writes too. A relational adapter
must place its shard/hash discriminator in effective primary/index keys; hashing only in
application code does not fix a physically sequential write hotspot.

Routing maps have paged/versioned entries and shared default rules, with sparse overrides
for hot ranges. Do not preallocate thousands of buckets, files, directory rows or watchers
for every empty Workspace. Resource IDs remain stable and region-independent; clients do
not choose cell addresses. Routing caches are hints. The serving authority checks tenant,
scope and current ownership epoch before accepting a write. Stale routes refresh or fail
explicitly; they do not read an empty replacement root or bypass authorization.

## 3. Small atomic groups, separately indexed collections

The main specification's `MetaStore` atomic scope means a **bounded consistency group**.
The production routing layout separates the following groups, even inside one Workspace:

| Group                            | Subject / contents                                                                                 | Atomic boundary                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Organization or Workspace policy | Small descriptor, owner/status and policy version                                                  | Policy only; resource/telemetry updates never advance this version              |
| Membership/directory edge        | One member or Workspace-directory identity, with bounded local metadata                            | Large member/Workspace collections are indexed edges, not one Organization file |
| Global resource                  | One desired resource, lifecycle operations, idempotent receipts and dispatch outbox                | Resource-local intent and scheduling evidence commit together                   |
| Regional resource                | One actual resource, private binding/storage refs, attempts/receipts and local observation journal | Provider-effect marker, claims and observed evidence commit together            |
| Resource name                    | One normalized-name claim and original operation/resource identity                                 | A unique conditional claim; no Workspace-wide name map                          |
| Request identity                 | One request-key claim, non-secret canonical intent/placement, fingerprint, stage and generated IDs | Retry resolves the same identity and initial assignment                         |
| Key and grants                   | One Key descriptor; separately partitioned exact-grant edges                                       | No million-ID array; wildcard is an explicit permission, not enumeration        |
| Quota/capacity pool              | One bounded allocation pool and its reservations                                                   | Escrow rights and reservations cannot exceed that pool's allocation             |
| Listing/search/task projection   | Bounded index shard, pages and progress watermark                                                  | Query/discovery projection; never authority for grants or provider effects      |

Groups are logical, not a SQL table/database per resource. A hosted engine stores many groups
in shared tables/key ranges. Records for one resource group use the same routing subject;
retain only bounded hot receipts/operations, with unresolved recovery evidence explicitly
preserved and archived history referenced externally. An unusually hot single resource still
has serialized lifecycle changes; no hash can remove that semantic dependency.

Resource-local authoritative indexes/outboxes update atomically with their group. Workspace
catalogs, status summaries and global search can update asynchronously through a durable
change feed/outbox projector with replay, tombstones and lag watermarks. Such projections
do not decide name uniqueness, account capacity, permission or whether a create happened.
A missing projection cannot justify duplicate provider work. A scale adapter needs indexed
change/outbox discovery; scanning all Workspace/resource groups for every scheduling tick
does not meet this profile.

## 4. Creation across groups

Do not replace a large Workspace transaction with independent PUTs and call the result atomic.
Use a durable staged operation, with the same semantics on every adapter:

1. Freshly authorize; conditionally claim request identity with the original input fingerprint,
   bounded non-secret canonical intent, resolved placement, stage and generated IDs. It is a
   durable initialization operation even before the resource group exists, discovered through
   the replayable pending-work path. Retrying reuses its assignment/IDs rather than resolving
   an automatic/default region again or allocating another identity.
2. Conditionally claim the normalized name for those IDs. A conflicting live/uncertain
   claim blocks another create. A clock/lease expiry alone does not release the name.
3. Reserve product/account rights under that original operation ID.
   A lost reservation reply is reconciled, not treated as free capacity or retried elsewhere.
4. Commit the resource intent and its dispatch outbox in the global resource group, with
   reservation refs. Bind/finalize the name claim and confirm the required reservations;
   only then make dispatch eligible. Intermediate state is explicitly reserving/pending.
5. Dispatch/admit into the target regional resource group, reserve regional capacity and
   execute the existing unknown-effect protocol. Persist the effect marker before a
   non-idempotent request.
6. Global queries regional results/journal to finalize allocation and safe projections. Reconcile partial
   commits; release a name/right only after proving no unresolved binding/effect needs it.

An engine may optimize co-located metadata steps into one transaction, but correctness
cannot depend on a transaction spanning all names, policies, cells or regions. Renaming,
bulk deletion and Workspace deletion are resumable operations over bounded batches. First
change the small Workspace lifecycle/policy to deny new admissions; then enumerate a pinned
inventory plus retained work and reconcile children. A list page alone is not deletion proof.
Do not drop a tenant prefix or vault while upstream ownership remains unresolved.

## 5. Queries, pagination and Portal

ID lookup routes to the canonical group without enumerating other resources. Exact-name
lookup follows its guard to the canonical resource and verifies the binding/tenant. Ordered
lists use purpose-built indexes for Workspace/region/kind and documented status/label filters;
arbitrary searches use a separately budgeted projection. Avoid full scans followed by filtering
and large OFFSET pagination. Expose only supported indexed combinations or an asynchronous job.

Index write sharding trades write concurrency for read fan-out. Use bounded fan-out,
concurrency and candidate/byte budgets with k-way merge, not one query to every resource
partition. Index routing pages must keep that fan-out bounded as a hot Workspace grows;
neither a million partition cursors nor a full ID list belongs in a client cursor. Sort the
initial live list by an immutable tuple such as `(createdAt, resourceId)` with a tie-breaker.

An initial physical index can use `(writeStripe, Workspace, view, timeWindow, createdAt, ID)`:
walk ordered time windows and merge a measured, bounded stripe set per window. Discovering a
new window needs no per-resource update to one global list head. Stripe count, physical key
distribution and sparse authorization/filter scans still need workload measurements; this
is not a constant-cost promise for arbitrary filters or unbounded write throughput.

Two explicit read modes avoid the old restart-on-any-Workspace-write behavior:

- **Live list:** integrity-protected keyset cursor binds tenant, filters, sort, routing/index
  generation, continuation state and expiry. Concurrent creates/deletes may change membership;
  pages do not claim a frozen global snapshot. Unrelated resource writes do not restart the
  list. Candidate limits can return an incomplete/empty page with a continuation token.
- **Snapshot/export:** a retained MVCC index snapshot or materialized manifest pins a declared
  projection watermark and expiry. Recheck current authorization on each page/download.
  Expiry or unavailable routing history returns an explicit restart, never mixed generations.
  The index snapshot is not a simultaneous fresh snapshot of all global/regional authorities.

Resource detail and mutation outcome remain canonical. List responses expose projection
freshness. A supplied `minWriteToken` can wait within a bounded deadline for read-your-write
visibility, otherwise returning `PROJECTION_CATCHING_UP`; a recent successful create must
not be silently presented as proof that no resource exists. Exact-grant callers start from
the grant index or a bounded candidate intersection, with canonical permission checks before
return. They cannot scan or receive another tenant's unfiltered inventory or aggregate counts.

The Portal requests one bounded page, filters/searches server-side and renders a windowed
list. Counts/summaries are projected with freshness; exact inventory/export is an explicit
job. Bulk actions return progress, per-item outcomes and resumable operation identity rather
than loading every ID into the browser. Opening Home/bootstrap never hydrates a million
resources, grants, detailed events or regional connection states.

## 6. Permissions, quotas and admission

Keep Organization/Workspace policy roots small and change their authorization versions only
for policy/lifecycle changes. Membership and exact-grant edges are separately partitioned.
A point action reads the relevant bounded policy/grant and resource records in its own
authority, not the Workspace collection. Region uses Global-pushed signed policy and local
resource state, with no reverse Global lookup. Existing digest/grant semantics remain unchanged;
legacy exact-ID arrays import into exact edges without widening permissions. Large grant
updates are explicit bounded jobs; an atomic replacement requires a staged immutable grant
set and one version-pointer publication, not a million-key transaction.

The [Global-initiated control channel](control-channel.md) supersedes the former online
cross-plane admission design. Global uses current bounded canonical policy read sets to
compile signed manifests and leases. Region atomically installs complete policy and evaluates
local P1/R/P2 versions and lease validity before I/O; no callback, token introspection or
upstream policy fetch is permitted. Resource writes do not contend on a Workspace auth counter.
Global renewal proves a complete relevant source cut; replaying old policy cannot refresh its
age. Revocation has accepted/pending/effective stages with applied-version or old-lease-expiry
evidence. Expired/missing coverage fails closed. Batch active-coverage pushes/renewals and
Global-owned delta reads rather than maintaining one renewal/heartbeat per resource.

Avoid updating one Workspace/Organization resource-count row for every create. Divide strict
quota rights into durable bounded pools: the coordinator allocates disjoint rights whose sum
does not exceed the hard limit; a pool consumes rights atomically with its reservation.
Refill/redistribute on a slower path. Returns are idempotent; issued/unknown rights are not
automatically reclaimed when a worker or lease disappears. A limit reduction below existing
allocations blocks new grants and reconciles outstanding rights before declaring compliance.
Tiny provider quotas may use a single coordinator; throughput claims must measure that limit.
Approximate projected counts can inform UI/billing views, never enforce a hard quota.
Pool rotation/receipt compaction must preserve issued rights and late-return deduplication;
seal old generations before reclamation and retain every unresolved reservation. A bounded
file group cannot silently accumulate an unlimited reservation history.

## 7. Scheduling and resource budgets

Use shared, sharded due queues/change streams with per-Organization/Workspace fairness,
concurrency/rate budgets, weighted scheduling, retry backoff and jitter. Queue items refer to
canonical operations; a late wakeup cannot bypass claim, generation or fresh authorization.
Index feed gaps trigger bounded checkpointed repair, with retained outboxes preventing lost
work. Local small mode can enumerate its explicitly bounded groups at startup; hosted scale
mode needs a proven replayable discovery path rather than a service-wide polling loop.
Cross-plane journal ingestion is always a Global-initiated bounded read of Region/cell/stream
deltas. Region never publishes to Global's queue/store. Global controls polling cadence and
cursors; policy/revocation traffic has priority over bulk status. Provider -> Region callbacks
below are upstream-provider integrations, not permission for a Region -> Global callback.

Provider callbacks/delta APIs and lifecycle observations are preferable where verified;
reconcile long-lived idle resources less often under a declared staleness policy. At one
poll/minute, a million resources already require about 16,667 polls/second for one Workspace,
before retries or index writes. Do not schedule one timer/process/watch/socket per resource
or record a global metadata write for every query, heartbeat or byte transferred. Telemetry
uses separate append/aggregation paths; native connections/workers are bounded by active work.

Account for metadata QPS, scan candidates, CPU, bytes, queue depth, provider calls, active
connections and storage by tenant/cell. Separate background repair, export and bulk deletion
budgets from interactive work. A tenant's overload yields controlled throttling/backpressure;
it must not consume every worker or make unrelated tenants fail. Upstream throttling is a
separate budget and cannot be bypassed by spawning another anonymous account.

## 8. Partition movement and recovery

Global initiates movement commands and queries their progress. Actual copy/fencing stays
inside the owning global/regional metadata authority with its authorized local storage;
Region cannot pull Global or another region's catalog, keys or policy as a recovery shortcut.

Split/move bounded partitions under a versioned routing/ownership protocol: mark the source
moving, durably freeze/fence its writes and new external steps, copy a verified final state
including receipts/outboxes/tombstones, activate the target under a new ownership epoch, then
publish routing. Target staging is not writable before ownership activation. The source
rejects stale epochs and returns a trusted route hint. In-flight effects retain their original
unknown/receipt identity; a migration timeout does not repeat provider work.

Readers pin a supported old routing generation or receive an explicit route-refresh/restart;
never combine two owners as concurrent write authorities. Copy validation and retained
versions/backups precede garbage collection. Membership, grants, IDs, provider locations and
native credentials stay unchanged. This is metadata movement within the allowed authority
location, not permission to move customer data across product Regions. Hosted promotion from
a bounded local profile uses the same freeze/import/verify/cutover rules as the main spec.

## 9. Storage profiles and acceptance

Logical KV independence does not mean equal performance from every storage implementation:

Keep `MetaStore` as the bounded-group correctness interface. Add internal typed `CatalogIndex`
and `ChangeSource` capabilities for collection queries and replayable change discovery;
the same backing engine may implement all three. Domain repositories do not issue SQL or
mistake a group-local `scan` for a global Workspace query. Local mode can rebuild an index
over its declared small inventory; the hosted scale profile requires incremental maintained
indexes/checkpoints and rejects a backend missing them. Exact implementation signatures
are an implementation-design gate, not a new public API in this documentation change.

| Profile                                     | Appropriate role                                                                                     | Required evidence                                                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Plain local files                           | Local development and bounded deployment; small files per atomic group                               | Core durability/isolation, explicit capacity bounds and migration path                                                       |
| TiDB/MySQL transactional KV mapping         | First hosted candidates to benchmark; pooled records and incremental indexes                         | Group-level locking, distributed placement/query plans, hot-index checks and load/isolation results                          |
| TiDB File System or S3 snapshot publication | Bounded groups, immutable payloads/backup; possible storage beneath a proven metadata service/engine | Incremental/paged access, independent publication, durable indexed change discovery and all scale gates before a scale claim |

A full JSON rewrite/parse or one HEAD for an entire Workspace fails this workload. One HEAD
per resource removes that single writer, but does not by itself provide indexed listing,
change discovery, cheap incremental updates or acceptable request cost. If those require a
B-tree/LSM/service, choose and verify an existing engine first; do not casually build a second
database to keep a filesystem-only implementation. File System metadata remains a candidate,
with explicit implementation cost and limits rather than an assumed million-resource claim.

Before selecting capacity, benchmark sparse millions-of-Workspace inventory, one million-
resource Workspace, skewed mixed read/create/update/delete, churn and long retention; record
hardware/runtime/backend versions, generated seed, record/index sizes, active fraction, QPS,
latency percentiles, conflicts, amplification, memory/GC, feed lag and per-resource cost.
Run repair/backup/export/rebalance and provider-failure fixtures concurrently with a small
unrelated tenant's requests. Agree latency/availability/cost targets before calling the scale
gate passed. No synthetic fixture creates live cloud resources. Main-spec META-29–37 define
the required outcomes; none is delivered as a passing benchmark by this document.

Primary references checked on 2026-10-29:

- [TiDB hotspot troubleshooting](https://docs.pingcap.com/tidb/stable/troubleshoot-hot-spot-issues/): row/index key distribution matters; sequential and repeated-value indexes can become hotspots.
- [TiDB transactions](https://docs.pingcap.com/tidb/stable/transaction-overview/): transaction semantics/limits require adapter-specific verification; distributed transactions do not remove a shared hot key.
- [DynamoDB write sharding](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-sharding.html): calculated shard routing permits direct item access; sharded collections add query/merge work. This is a design reference, not selection of DynamoDB.
