# ADR 0040: Authority-local System State

> **Partially deprecated.** [ADR 0043](0043-portal-agent-region-control.md) supersedes the original Global-to-Region connection direction. Authority-local System State and regional data-path autonomy still apply.

- Status: Meta-backed security state implemented; targeted local verification passed.
- Date: 2026-11-01.
- Scope: application configuration and runtime state that do not belong to a Workspace.

## Decision

Use **System State** for authority-owned application and runtime metadata. It is a logical
namespace in the existing Meta service, not another database or service. Global and each
Region keep their own System State in their respective Meta authority and SlateDB root. The
selected Meta backend remains responsible for encryption, versioned records and durable
acknowledgement; there is no Region-to-Global dependency.

The existing record scope already supports `ownerKind: system`. Construct system scopes
explicitly using the authority, an owner, a record family and a bounded partition. For the
proposed security clock record, the scope is `system / control-plane / runtime-state /
security-clock` in the relevant authority, with `time-floor` as the record key. Other
system purposes use separate scopes or partitions; do not collect all runtime information in
one mutable document. Workspace-owned policy remains scoped to its Workspace and Key.
System State is internal and is not a customer Workspace or an independently exposed API.

## Security state and migration

Fresh installations store Global and regional security time floors, regional Key policy floors,
and renewal witnesses in their own authority-local Meta stores. The Global and Region records
remain independently scoped. Regional policy and witness partitions use a digest of the Region,
Workspace and Key identity; the records are internal System State and contain no provider secrets.

Use versioned compare-and-swap and acknowledge writes only after Meta durability. Initialize
new authorities explicitly. A missing or invalid time floor fails closed on steady startup.
Older file-backed installations retain the existing checkpoint mode; this change does not
silently migrate or reset them. A fresh cloud reset can deliberately create new independent
Meta roots and identities, as authorized by the owner. An in-place migration preserving old
security state has not been implemented; retain an existing volume until a verified migration
or an explicitly authorized fresh reset.

Keeping the checkpoint in the same Meta store simplifies deployment but changes the failure
boundary: restoring or rolling back the entire store can roll back both a policy and its floor.
Meta transactions and versions cannot independently detect that whole-store rollback. Do not
claim the former separate-checkpoint protection for this design. Backup/restore controls and
any independently anchored rollback detection are separate operational decisions.

The Meta clock reserves a five-second future upper bound durably before serving time within it.
Checks still use the current wall clock, including synchronous checks at effect boundaries; they
fail closed if the reservation expires before Meta can renew it. This bounds clock writes to
at most one reservation per window per active authority rather than one write per request.
While a reservation remains valid, both the synchronous snapshot and the asynchronous clock
lookup use in-process atomics; only renewal waits on the local mutex and durable Meta commit.
After restart, the authority waits until the previous reservation has elapsed (at most five
seconds under a correct clock); a larger backward jump fails startup. An S3 commit that outlasts
its reservation must be retried before returning a time. This design assumes one active API
writer per authority; multi-node serving needs explicit fencing and is not established here.
Whole-store rollback cannot be detected by a floor kept in that same store.

GP3 is optional disposable cache capacity for SlateDB or API acceleration. Cache deletion,
eviction or loss must not remove authoritative state, credentials, security floors, or prevent
recovery from Meta/object storage. Cache configuration is separate future work.

## Current implementation

Meta enforces authority-bound `system` scopes. Newly generated Global and Region configurations
select `metadataSecurityState:true`; the cloud reset/bootstrap candidate uses no security PVC.
The existing filesystem mode remains available only for old explicitly configured installations.
See the current test and deployment results rather than interpreting this decision as evidence
that a live cloud installation has already been switched.

Approximate product analytics is not authoritative System State. The owner requires the
separate, asynchronous SlateDB service in [ADR 0050](0050-isolated-analytics-service.md);
its availability and durability must not become Meta dependencies.
