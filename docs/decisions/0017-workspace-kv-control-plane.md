# ADR 0017: Portable KV metadata for the Workspace control plane

- Status: Proposed; portable KV, hosted object storage as source of truth and the global/regional three-plane split are owner-requested direction; detailed contracts remain under review
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

The owner requires a Global -> Region invocation/dependency graph with no reverse call or
unsolicited regional reporting. Global queries any regional information it needs. Production
communication must be strongly encrypted/authenticated; local tests may explicitly relax
transport. The [control-channel contract](../../specs/gh-74/control-channel.md) supersedes the
earlier Region -> Global online-admission dependency and result-publisher proposal.

Regional independence is a hard owner requirement: a Global outage must not stop established
regional service, including after a policy-heartbeat interval or regional restart. This
supersedes the earlier authorization-lease-expiry shutdown proposal. Persist verified local
policy without synchronization TTL; enforce real credential expiry and received revocations.

After reviewing an object-backed metastore reference, the owner requested object storage as
the hosted metadata source of truth. The [object-metastore design](../../specs/gh-74/object-metastore.md)
requires recovery of every acknowledged commit from objects, including the accepted WAL
tail. This supersedes the earlier SQL-first hosted evaluation order; local files remain the
local authority. Object checkpoints that lag a local/Raft-only ACK are a different profile.

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
4. Prefer an object-native engine for hosted metadata: accepted WAL, SSTs, manifests and
   recovery/routing evidence are durable in objects before ACK; local caches are disposable.
   Evaluate pinned SlateDB first, without claiming current conformance or selecting a runtime
   binding. Pool groups in physical shards; verify CAS/atomic batches, durable visibility and
   read/write ownership. SQL may be a rebuildable query projection or an explicit alternative
   database-authority profile, never an uncoordinated second writer. TiDB File System remains
   a service-owned candidate, separate from customer/DuckDB storage and with independent
   bootstrap credentials. Qualify publication, path incarnation, payload limits and object
   recovery of its namespace/catalog as well as file bytes. Bounded snapshot+HEAD supports
   small inventories; neither it nor independent per-key PUTs establishes hosted scale.
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
   Return safe status/usage evidence only to Global-initiated queries; derived global views
   do not become regional execution authority.
9. Assign one `regionId` before dispatch and verify provider placement separately. Preserve
   legacy `region` values, including `automatic`, without inventing geographic residency.
   Workspace `homeRegion` is a future-create default. Changing regions requires an explicit
   transfer design, not a metadata patch or automatic failover. Shared Workspace ownership
   does not permit cross-region file analysis/data export.
10. Global initiates command/policy delivery and journal/health/result reads. Region persists
    local observations and returns request-bound replies; no reverse RPC, Global broker/store
    write, introspection or policy pull is allowed. Use stable command identity,
    fingerprints, inbox deduplication and generation checks. Signed, atomically installed
    policy remains durable local authority without a Global heartbeat/renewal TTL. Revocation
    stays pending for an unreachable target until applied evidence exists; there is no fixed
    offline propagation bound. Preserve genuine credential expiry, local deny floors and
    in-flight semantics without requiring Global connectivity.
11. Pool sparse tenants across metadata cells and shard hot tenants by resource/edge identity.
    Keep policy roots small, exact grants as partitioned edges, strict quota rights in bounded
    pools, and list/task projections indexed with explicit lag. Use keyset/live or pinned
    snapshot/export contracts, fair shared workers and ownership-fenced partition movement.
    Millions of resources require the scale profile's incremental/query/discovery/isolation
    evidence; core file durability or conditional object writes alone are insufficient.
12. Production cross-plane hops require TLS 1.3, mutual certificate/service identity checks
    and signed persisted commands/policy. Bootstrap/rotate trust out of band or through
    Global-initiated requests; Region never enrolls at Global. Explicit loopback/in-process
    test relaxation cannot apply to remote/hosted targets or activate after connection failure.
13. Hosted Global and Region serving paths use separate processes/failure domains. Regional
    endpoints/discovery, session issuance/refresh, policy/bindings, Vault/KMS/PKI, provider
    credentials and restart recovery do not depend on Global. Known regional work continues;
    new Global-coordinated changes may wait. Compact resolved telemetry regionally without
    requiring Global ingestion ACKs; preserve canonical state and unresolved ownership.
14. Generate separate Global/public Region/private control OpenAPI contracts from shared
    schemas and explicit route ownership. Data clients call Region directly, with separate
    origin/issuer/audience credentials. Regional token exchange/refresh/reauthentication uses
    regional storage/signers. The [API/auth contract](../../specs/gh-74/regional-api-auth.md)
    separates durable grants, credential versions and short access tokens: a new continuity
    grant needs explicit owner authorization; legacy 7/30/90-day Keys keep their real expiry.
    No child credential gains Global privileges or outlives an explicit authorization end.

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
- Independent regional execution adds sagas, durable policy and stale Global projections.
  Global disconnection has no policy-age shutdown deadline. A disconnected Region cannot
  observe a new Global revocation; its status remains pending rather than falsely immediate.
  Regional local denials, genuine credential expiry and independent recovery still apply.
  Data, identity metadata, backups and proxies each need explicit location declarations.

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

[META-01 through META-66](../../specs/gh-74/spec.md#10-mandatory-requirements-and-acceptance-baseline)
cover adapter conformance, crash/unknown outcomes, authorization before I/O, provider-account
quotas, credential separation, full legacy import, no duplicate provider effects and restore.
The TiDB File System case includes concurrent publication, path replacement, bootstrap and
public/private storage separation; its current product adapter is not a metadata CAS adapter.
Regional cases cover placement, pushed commands/pulled results, durable local admission, service/
credential isolation, capacity/outages, data movement and distributed import/restore.
Scale cases cover sparse/large tenants, group contention, staged claims, pagination, grant
edges, strict quota pools, fairness, partition movement and reproducible workload/cost evidence.
Channel cases cover invocation/egress direction, incremental reads/recovery, signed policy,
policy/revocation histories, real TLS identity negatives and explicit local-only relaxation.
Autonomy cases blackhole Global through serving/session renewal, regional restart, telemetry
retention and resynchronization; shared-process local tests are not hosted availability evidence.
API/auth cases cover origin/contract ownership, local exchange/refresh/reauthentication,
credential/grant lifetimes, refresh replay, audience isolation, browsers and safe data retries.
Object-profile cases cover accepted-WAL object-only recovery, durable visibility, obsolete
readers/writers, compaction/GC closure, projection rebuild, regional bootstrap/secret recovery
and measured batching/cost/isolation. Engine defaults or object-backed file bytes do not
establish these properties without acceptance evidence.
This ADR does not claim those tests or a production migration exist. Repository checks only
verify the current source/documents.

Revisit scope limits and storage choices after local conformance measurements, before adding
a hosted adapter or cross-Organization provider pool, and before promising production
recovery/availability or a stronger cross-scope revocation contract.
