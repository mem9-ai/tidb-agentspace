# ADR 0050: Independent, asynchronous SlateDB analytics service

- Status: Accepted owner amendment, 2026-11-04; implementation tracked in
  [GH-190](https://github.com/mem9-ai/tidb.ai/issues/190).
- Supersedes the shared Meta storage and durable collection acknowledgment choices
  in [ADR 0049](0049-product-analytics-operator-boundary.md). Its privacy, authority,
  metric and verified PingCAP Admin requirements remain in force.

## Context

Product analytics can tolerate loss and delayed visibility. Customer permissions,
resource state, security clocks and effect receipts cannot. A separate namespace in
the same Meta engine does not isolate write traffic, availability or recovery. The
owner explicitly requires another analytics service, still using SlateDB, with lower
availability requirements and asynchronous writes.

## Decision

Run a dedicated single-writer analytics process for each producing authority. The
native role loader rejects any plan that combines analytics with Meta, Global or
Workspace roles. Reuse the native executable and pinned SlateDB library, not the
Meta service, protocol, owner record, security clock or recovery machinery.

Each analytics process owns a dedicated S3 root, installation marker, encryption
key, pseudonym key and producer token. Hosted communication requires TLS 1.3/mTLS
plus an authority-bound token. The private protocol accepts typed observations,
approved attribution and bounded summary queries; it exposes no arbitrary KV/Meta
operation. APIs contain only a remote analytics client. The analytics crate has no
Meta service/client dependency. Operator sessions remain in the existing trusted
Global API, with no customer privilege inheritance.

Business completion hooks enqueue at most 1,000 jobs, including staged/in-flight
jobs, without waiting for a network or storage operation. A background sender posts
up to 64 jobs or after one second, with a two-second request deadline and at most
two retries using identical event IDs. Overflow and unresolved delivery are counted
as unconfirmed. Missing optional producer credentials disable that producer without
stopping business startup. There is no fallback to primary metadata.

The analytics process commits raw events, retained dedup receipts and projections
atomically to its own SlateDB memory state. It does not await each write handle's
object-store durability. SlateDB asynchronously flushes its WAL at a one-second
interval; this interval is not a production RPO promise. Browser collection returns
`202 {"accepted":true,"durability":"queued"}` only after validation and acceptance
by this process. It does not claim that S3 has acknowledged the data. A crash may
lose producer queues or recent analytics writes, and displayed totals can recede.
Retained IDs deduplicate retries; lost, unflushed receipts provide no such promise.

Only one process may write a root. Use a single replica and stop/recreate it for
updates; no standby, automatic failover, Meta recovery owner or replay-complete
delivery is introduced. Native SlateDB writer fencing still applies. Restart opens
the analytics root directly and recovers available WAL/SST data. Do not weaken Meta
durability or ownership checks to match this lower-availability profile.

Admin reads remain authenticated aggregate operations. An unavailable analytics
service returns an explicit error or missing-Region coverage, never synthetic zeros.
Producer pending/drop counts and crash-loss uncertainty are distinct from a durable
delivery ledger. Customer business outcomes, billing, quota and security decisions
never rely on these observations.

## Privacy, retention and operations

Raw events stay in their producing authority. Field allowlists, keyed pseudonyms,
GPC/opt-out, 30 daily detail partitions and 90 identity-free aggregate partitions
remain unchanged. Dedicated analytics IAM should permit only its own bucket/root;
do not give it Meta storage credentials. Logical expiry is enforced on reads and by
cleanup; physical object/version/backup reclamation remains an operator lifecycle
policy. The initial implementation did not authorize live provisioning or migration.
The owner's subsequent explicit live-enablement request is tracked in GH-193: use
independent private buckets and namespace/ServiceAccount-bound EKS workload roles.
Preserve existing business storage, identities and provider configuration. Deployment
remains a protected operator action and requires observed real-account acceptance.

Capture remains disabled until explicitly configured. Previous shared-Meta config
names are rejected rather than silently selecting the old store. New code neither
reads nor migrates old analytics namespaces. If an operator enabled the former
profile, stop it and explicitly arrange its retention/purge before retiring its old
cleaner; do not delete or reset unrelated Meta records as part of this change.

## Verification

Native acceptance runs real, separately hosted analytics processes with mTLS and
isolated S3 roots. It checks producer/authority denial, TLS downgrade/hostname/client
certificate denial, normal product login/write and startup while analytics is down,
missing producer credentials, explicit Admin unavailability, independent recovery
and zero analytics records in the main Meta namespace. Domain/storage fixtures
cover schema rejection, cohort denominators, dedup, atomic conflicts, encrypted
path binding, authority isolation and retention. A queue test establishes bounded,
nonblocking admission with an absent service. Existing public/Console behavior is
retained except for the explicit queued acknowledgment.

SlateDB's [transaction contract](https://docs.rs/crate/slatedb/0.17.0/source/src/ops.rs)
and [write design](https://slatedb.io/docs/design/writes/) distinguish atomic memory
acceptance from awaiting durability. Verify the pinned source when upgrading.
Revisit after measured launch load or if analytics becomes billing/security evidence.
