# ADR 0033: Sparse-activity metadata scale

- Status: proposed architecture and partial implementation, 2026-10-31.
- Scope: Global and regional metadata for a large population of mostly idle Tenants and
  Workspaces, including a Workspace containing a million resources. These cardinalities are
  storage targets, not requests-per-second objectives or a demonstrated capacity.

## Current slice

The resource list defaults to an independently authorized, bounded ID-ordered page of stored
resource records (100 by default, up to 512). A restricted Key reads only its explicit
grants. Existing records need no backfill for this ID index. Updates of one resource no longer
inflate the entire Workspace. Independent point updates can run concurrently, while a shared
read/write gate still excludes them during legacy snapshot transactions; the remaining legacy
paths therefore continue to cause Workspace-wide contention.
Regional Workspace cache access holds the pool mutex only for bookkeeping. Authentication,
cold opening, eviction, cleanup and shutdown perform metadata I/O outside it. A per-Workspace
in-flight reservation coordinates callers of the same Workspace and fences a victim until its
writer is released; waiters receive their own pinned lease and are independently authenticated.
Open jobs continue if the originating request is cancelled. Pending opens consume bounded pool
capacity and may return `WORKSPACE_POOL_BUSY`; eviction still scans the bounded cache for an idle
victim. An unknown writer claim or release fails the pool closed until operator recovery: the
service does not automatically adopt an existing writer. Shutdown drains or rejects in-flight
reservations before declaring success. This removes metadata I/O from the shared lock; it does
not eliminate short in-memory synchronization, SlateDB writer limits, or cold-churn costs.
Key listing is owner-only, ID-ordered and paginated (default 100, maximum 512); each page is
independently authorized. The response now contains `nextCursor`; existing clients must follow
it rather than assuming the first response contains every Key. Bootstrap contains the first Key
page and `keysNextCursor`. Create/revoke read only their target Key and explicitly granted
resources. Key authentication, projected resource/Key mutations and event append can run
concurrently through the shared read gate. Mutations fence the Key and selected resource
versions and retry confirmed conflicts with fresh authorization; unknown commit outcomes are
not retried. The fence uses no-op conditional writes, which can contend on the same Key or
resource and advance its metadata version.

Event append maintains an ordered retention index and a head record; an existing collection of
at most 200 retained events is indexed once. Subsequent appends address only the head, new event,
and oldest event when pruning. Event list and bootstrap still read the retained 200 events to
honor the existing list contract. The head is a contention point and the shared gate still
coordinates with older transactional writers.

Existing local demo files receive resumable path, directory and usage indexes. Single-file
reads and writes address the target and parent; updates atomically maintain the indexes and
usage counters. Directory listing is cursor-paged (default and maximum 32). `/files` now defaults
to the root directory, and clients follow `nextCursor`; `/bootstrap` no longer embeds local file
contents. Portal directory browsing retains at most 200 entries. The first legacy file-index
build still scans old file records and waits for completion. Drive9 continues to own its file
contents and listing behavior. The local demo remains limited to 2,000 newly created entries per
File System, so synthetic records above that count do not establish product capacity.
Deleting a local File System clears its records in bounded batches while rechecking the caller;
an interrupted cleanup remains in the deleting state and can be resumed by retrying deletion.
Bootstrap and usage return a first bounded page and a continuation cursor. The Portal loads
subsequent pages on demand and resolves a directly linked resource separately. It currently
retains at most 200 resource records in its current window and permits returning to the first
page. Explicitly selected Key grants remain selected and hidden selections are disclosed.
Key inventory and resource selectors also use bounded 200-record windows. Listing, bootstrap and usage return stored status;
resource detail refreshes provider status. A cursor is a position, not a snapshot: concurrent
insertions before it may be missed and deletions may disappear. A page can be empty and still
have a next cursor. Callers of the former default unpaged resource list must follow `nextCursor`.
Workspace-wide usage query counts are reported for owner/wildcard access; for a restricted Key,
the response labels its count as page-scoped.

Creation uses colocated name, free-tier quota, idempotency and resource records in an atomic
metadata commit. Existing Workspaces build versioned resource indexes in an in-process background
task, in batches of up to 1,536 with durable checkpoints, releasing the Workspace gate between
batches. A creation request waits briefly for small backfills. Otherwise it returns 503
`RESOURCE_INDEX_MIGRATING` without creating a resource, and a client may retry the same request.
The task is started on demand; after shutdown or a failure a later creation resumes it. Index-changing
updates are fenced while backfill runs. The first file-index migration remains request-driven.
Resource creation, local file operations, bindings, setup attempts and index backfill use
conditional commits under the shared side of the Workspace gate; confirmed conflicts retry with
fresh reads. Migration-marker absence is fenced against concurrent index-changing writes. Legacy
snapshot and writer close operations still acquire the exclusive side. Remote provider operations
and resource lifecycle coordination retain resource-scoped locks. This is not a finished
million-resource design.

## Placement proposal

Global and each Region have independent shard catalogs and separate SlateDB roots and
writers. A cell holds many cold Tenants; it is not a dedicated database per Tenant. Keep a
small fixed number of virtual buckets per authority, initially assigned to a measured number
of physical shards. Stable, keyed hashing over identity selects a Global directory bucket;
regional routing uses `(tenantId, workspaceId)` to select its home bucket. A regional
catalog maps a versioned bucket to a physical shard and ownership epoch. Placement is
durable, caches have bounded size and are hints, and Region continues routing with its own
durable catalog when Global is unavailable. Global can initiate an authenticated management
request to Region; Region does not call or report back to Global.

A large Workspace needs multiple resource partitions, not merely a hash of Workspace ID.
Assign each immutable resource ID to a virtual resource bucket, route the canonical resource,
provider binding, credentials, and resource-local operations together, and keep tenant,
Workspace and authorization in every key and check. Index lookup must be bounded: an
independent Workspace directory stores partition locations and the cursor carries the route
generation and per-partition progress for a bounded fan-out merge. A physical shard may own
many virtual buckets; do not make a per-Workspace list of millions of physical partitions.
Exact bucket count, fan-out, index access patterns and split triggers need measurement.

## Indexes and mutation boundaries

- The canonical ID record supports point access and ordered ID listing. Name uniqueness,
  kind/status filters, quota counters and idempotency require explicit indexed records;
  each entry identifies its Workspace and resource and never authorizes an operation.
- Within one shard, commit the canonical record and its colocated indexes atomically using
  version preconditions. Name reservation and quota are Workspace-wide invariants; once a
  Workspace spans shards, place them in a durable home-shard reservation/operation record.
  Coordinate create/delete as a recoverable state machine, with idempotent steps and a
  reconciler; no cross-shard atomic transaction or exactly-once provider call is assumed.
- A cross-shard list/filter index is a projection with a durable change position and explicit
  lag/watermark. Verify authorization and current canonical state before returning protected
  data or performing an effect. State pagination and concurrent-change semantics explicitly;
  provide snapshot semantics only if a real retained snapshot is implemented.
- Migrate existing data using resumable, versioned backfill checkpoints and dual-write or a
  bounded write fence. Ensure every resource, binding, credential, reservation and delete
  journal is accounted for before switching reads. An interrupted backfill must be restartable;
  never silently interpret a missing index as a missing resource or reset existing state.

## Shard movement and failure

Use a durable placement epoch and a fenced writer per SlateDB root. Provision a destination,
copy a consistent snapshot, replay changes to a known position, fence source writes, drain
and verify final state, then atomically advance the catalog epoch. Old routers must fail closed
and refresh their route; they cannot continue writing to the old owner. Resume or roll back
from recorded checkpoints after a crash. Preserve credentials and deletion/idempotency journals.
Do not open two independent writers to the same SlateDB root or let Global availability
become a dependency of normal Region traffic. HA election, credential rotation, recovery SLOs,
operator tooling and safe cutover remain implementation work.

## Acceptance before a capacity claim

Use isolated object storage and actual SlateDB with a stated machine, version and settings.
Seed at least one million identity/Tenant records and a separate million-resource Workspace;
record logical and physical sizes. Use a declared skewed workload with few active tenants and
resources, controlled concurrency and realistic page sizes; measure point reads/writes,
pagination, creation/deletion, auth isolation, contention, p50/p95/p99, errors, memory and
object-store requests. Exercise cold/warm cache, restart, writer fencing, credential survival,
shard movement, policy revocation and backlog recovery. No arbitrary million-QPS target follows
from the record count. Compare results with explicitly chosen availability and latency targets;
the current prototype has not passed these acceptance cases.
