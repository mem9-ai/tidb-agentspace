# ADR 0017: Portable KV metadata for the Workspace control plane

- Status: Proposed; storage independence and the global/regional three-plane split are owner-requested direction; detailed contracts remain under review
- Date: 2026-10-29
- Parent: [GH-74](https://github.com/siddontang/tidb.ai/issues/74)
- Specification: [Multi-tenant Workspace control plane](../../specs/gh-74/spec.md)
- Implementation: None in this design change; existing single-Workspace JSON persistence remains active

## Context

The current gateway has a fixed Workspace ID, process-local owner sessions, one public JSON
state file and sibling private provider vaults. Pointing a local preview at a fresh state
root can make existing resources appear absent even though their original state still exists.
Its in-process mutation queue does not coordinate multiple API processes.

The product needs Organization/Workspace ownership, explicit Key/resource isolation,
recoverable cloud operations, and migration of existing bindings and credentials. The owner
requested a metadata abstraction with a logical KV structure, bounded retrieval and multiple
possible backends, explicitly including TiDB File System. Ordinary filesystem files should
be sufficient for local use; a particular relational schema or database service must not
become a domain prerequisite.

The owner also requires global control, region control and regional data-plane boundaries.
Business policy and placement belong globally; regional control executes admitted desired
state against its local data plane. A Workspace can span regions, so a resource's region is
part of its immutable routing/ownership context, not only a Console label. The current
single-process gateway and its existing region strings do not implement this topology.

The owner requires planning for millions of Workspaces and individual Workspaces containing
up to a million resources. This invalidates the earlier one-Workspace snapshot/CAS as a
production partition. The [scale profile](../../specs/gh-74/metadata-scale.md) replaces that
granularity; no capacity benchmark or hosted engine selection is claimed.

## Proposed decision

1. Domain services use typed repositories over `MetaStore`, with versioned JSON records,
   explicit ownership, bounded prefix scans and maintained indexes. They do not issue SQL,
   object-store requests or raw filesystem operations for metadata.
2. Require fresh reads and revision-conditional atomic batches within **bounded groups**.
   Workspace is an ownership boundary, not a shared resource write lock. A desired resource/
   operation/outbox commits in its global resource group; actual binding/inbox/attempt/state
   commits in its regional group. Name/request claims, grants and quota pools have separate
   groups; staged coordination confirms prerequisites before effects, without requiring a
   Workspace-wide or global/regional transaction.
3. Use one ordinary JSON state file per bounded group for the first local adapter, owned by one
   authority process. Exclusive root ownership, synced temporary writes, atomic replacement,
   directory sync and explicit recovery are required. Local files do not imply multi-host HA.
4. TiDB File System is an explicit hosted candidate using service-owned metadata storage,
   separate from public File Systems and DuckDB backing stores, with out-of-band bootstrap
   credentials. Evaluate one metadata authority or immutable snapshots with conditional HEAD
   publication; verify fresh reads, durability, path-incarnation/stale-writer protection and
   upload limits. A mount or layer checkpoint does not establish that contract. TiDB/MySQL
   may implement the same KV contract with physical scope/record tables and transactions.
   A later S3 adapter must use conditional snapshot publication or a proven conforming engine.
   Independent per-record PUTs are insufficient. No hosted engine is selected here.
5. Store provider credentials through a separate internal `CredentialStore`. Local private
   files remain an explicit local profile; hosted encryption/IAM needs a chosen managed
   profile. Public metadata/projections never expose native passwords or provider tokens.
6. Migrate through a frozen, complete source bundle, staged import journal, identity/grant/
   credential verification and one-authority cutover. Preserve native instances and accounts;
   import never calls provider creation or setup. Restore/rollback considers all newer state.
7. Keep Workspace Keys scoped to one Workspace; wildcard grants never cross Workspaces or
   expose DuckDB's private backing storage. KV namespacing complements provider/native data
   isolation and does not replace it.
8. Global control owns identity, policy, eligibility, names, product/account reservations,
   desired state and dispatch. Each region owns actual bindings, native credential access,
   execution recovery and observed state; its data plane handles SQL/files/workers. Distinct
   global/regional metadata roots use the same MetaStore interface with separate identities.
   Export only safe status/usage projections globally; replicas do not become authority.
9. Assign one `regionId` before dispatch and verify provider placement separately. Preserve
   legacy `region` values, including `automatic`, without inventing geographic residency.
   Workspace `homeRegion` is a future-create default. Changing regions requires an explicit
   transfer design, not a metadata patch or automatic failover. Shared Workspace ownership
   does not permit cross-region file analysis/data export.
10. Use authenticated at-least-once command/result delivery with stable operation identity,
    fingerprints, regional inbox deduplication and generation/routing checks. Fresh global
    policy admission remains required for new regional requests/external steps, with bounded
    audience/request grants and explicit in-flight semantics. Offline policy leases are a
    separate revocation/SLO decision. Start with modules in one local API deployment; split
    hosted services only after the regional isolation and failure acceptance cases pass.
11. Pool sparse tenants across metadata cells and shard hot tenants by resource/edge identity.
    Keep policy roots small, exact grants as partitioned edges, strict quota rights in bounded
    pools, and list/task projections indexed with explicit lag. Use keyset/live or pinned
    snapshot/export contracts, fair shared workers and ownership-fenced partition movement.
    Millions of resources require the scale profile's incremental/query/discovery/isolation
    evidence; core file durability or conditional object writes alone are insufficient.

## Alternatives and consequences

- A relational domain schema could enforce some relationships in SQL, but would make other
  adapters reproduce database-specific query behavior. Logical KV records with typed
  repositories keep that policy explicit and portable.
- A separate uncoordinated file per logical record cannot atomically publish a resource-local
  bundle. A bounded group snapshot gives the local version a clear boundary; names/rights
  use staged coordination. A snapshot/lock for an entire large Workspace is rejected.
- An eventual `get/put/list` abstraction is too weak for revocation, uniqueness and concurrent
  lifecycle changes. Portability cannot hide the consistency required by those operations.
- A global transaction across every tenant would make custom object-backed storage much more
  complicated. Scope boundaries deliberately expose cross-scope workflows and their recovery.
- Group CAS serializes one resource's lifecycle, while other resources proceed independently.
  Separate policy, query projections and telemetry; shard ordered indexes and measure hot
  keys. Logical KV independence does not promise equal performance from every backend.
- Storage independence is not free: relationship checks, codecs, index updates, conformance,
  crash recovery and import verification are product responsibilities.
- Independent regional execution adds sagas and stale status projections. The initial fresh
  global admission contract adds latency and a global availability dependency; it cannot
  promise offline regional service without changing its revocation policy. Resource data,
  global identity metadata, backups and proxies each need explicit location declarations.

## Migration and compatibility

The specification maps the main JSON state and all four private vault files, including db9
account/recovery state, legacy Key digests, idempotency data, local files, retired records and
hidden DuckDB storage. Original IDs, native roles/passwords and provider account identities
remain unchanged. Unknown or orphan data is preserved privately and reconciled, not silently
discarded. Missing credentials block activation rather than trigger fresh provisioning.
Import also requires explicit execution-region mappings and separate upstream-location
evidence. Global desired records and regional bindings/vaults must agree; restore reconciles
both authorities and pending commands/results before enabling affected resources. An unknown
provider location or missing regional vault cannot be repaired by relabeling or recreation.

Existing Workspace/resource URLs and Key validation remain compatible. A migration must not
reuse `ws_agentlab` as a tenant-independent alias. Existing unauthenticated local-owner setup
stays loopback-only until actual hosted authentication is implemented. API evolution, new
async operations and generated contracts belong to implementation PRs against an accepted
specification revision.

## Verification and revisit

[META-01 through META-37](../../specs/gh-74/spec.md#10-mandatory-requirements-and-acceptance-baseline)
cover adapter conformance, crash/unknown outcomes, authorization before I/O, provider-account
quotas, credential separation, full legacy import, no duplicate provider effects and restore.
The TiDB File System case includes concurrent publication, path replacement, bootstrap and
public/private storage separation; its current product adapter is not a metadata CAS adapter.
Regional cases cover placement, dispatch/results, fresh cross-authority admission, service/
credential isolation, capacity/outages, data movement and distributed import/restore.
Scale cases cover sparse/large tenants, group contention, staged claims, pagination, grant
edges, strict quota pools, fairness, partition movement and reproducible workload/cost evidence.
This ADR does not claim those tests or a production migration exist. Repository checks only
verify the current source/documents.

Revisit scope limits and storage choices after local conformance measurements, before adding
a hosted adapter or cross-Organization provider pool, and before promising production
recovery/availability or a stronger cross-scope revocation contract.
