# ADR 0017: Portable KV metadata for the Workspace control plane

- Status: Proposed; logical KV abstraction, ordinary local files and evaluating TiDB File System are owner-requested direction, while the detailed contract is under review
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

## Proposed decision

1. Domain services use typed repositories over `MetaStore`, with versioned JSON records,
   explicit ownership, bounded prefix scans and maintained indexes. They do not issue SQL,
   object-store requests or raw filesystem operations for metadata.
2. Require fresh snapshot reads and revision-conditional atomic batches **within one scope**.
   Organization and Workspace are separate scopes. A resource, name reservation, operation
   and authoritative indexes commit together. No cross-scope transaction is promised.
3. Use one ordinary JSON state file per scope for the first local adapter, owned by one
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

## Alternatives and consequences

- A relational domain schema could enforce some relationships in SQL, but would make other
  adapters reproduce database-specific query behavior. Logical KV records with typed
  repositories keep that policy explicit and portable.
- A separate file for every logical record is inspectable but requires a transaction/journal
  protocol to update grants, guards and indexes together. A bounded per-scope JSON snapshot
  gives the first local version a simpler atomic boundary.
- An eventual `get/put/list` abstraction is too weak for revocation, uniqueness and concurrent
  lifecycle changes. Portability cannot hide the consistency required by those operations.
- A global transaction across every tenant would make custom object-backed storage much more
  complicated. Scope boundaries deliberately expose cross-scope workflows and their recovery.
- Scope CAS creates contention within a busy Workspace. Coalesce observational writes and
  keep bulk events/results outside hot metadata. Measure before changing partitioning.
- Storage independence is not free: relationship checks, codecs, index updates, conformance,
  crash recovery and import verification are product responsibilities.

## Migration and compatibility

The specification maps the main JSON state and all four private vault files, including db9
account/recovery state, legacy Key digests, idempotency data, local files, retired records and
hidden DuckDB storage. Original IDs, native roles/passwords and provider account identities
remain unchanged. Unknown or orphan data is preserved privately and reconciled, not silently
discarded. Missing credentials block activation rather than trigger fresh provisioning.

Existing Workspace/resource URLs and Key validation remain compatible. A migration must not
reuse `ws_agentlab` as a tenant-independent alias. Existing unauthenticated local-owner setup
stays loopback-only until actual hosted authentication is implemented. API evolution, new
async operations and generated contracts belong to implementation PRs against an accepted
specification revision.

## Verification and revisit

[META-01 through META-21](../../specs/gh-74/spec.md#10-mandatory-requirements-and-acceptance-baseline)
cover adapter conformance, crash/unknown outcomes, authorization before I/O, provider-account
quotas, credential separation, full legacy import, no duplicate provider effects and restore.
The TiDB File System case includes concurrent publication, path replacement, bootstrap and
public/private storage separation; its current product adapter is not a metadata CAS adapter.
This ADR does not claim those tests or a production migration exist. Repository checks only
verify the current source/documents.

Revisit scope limits and storage choices after local conformance measurements, before adding
a hosted adapter or cross-Organization provider pool, and before promising production
recovery/availability or a stronger cross-scope revocation contract.
