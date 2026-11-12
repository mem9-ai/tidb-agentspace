# ADR 0022: Native SlateDB metadata transactions

> **Current implementation.** Native transactions, durable reads and writer fencing remain current. The original SlateDB version and Node/Rust migration tests below are historical. See [the running Meta service](../meta-service.md) for the pinned engine and Cargo verification.

- Status: Accepted owner direction; implemented under [GH-100](https://github.com/siddontang/tidb.ai/issues/100).
- Date: 2026-10-29.
- Complements [ADR 0019](0019-workspace-kv-control-plane.md) and [ADR 0020](0020-modular-rust-backend.md).
- Baseline: `0e98bc5e0203fb828c3d554348a6d040f12e8f96`.

## Decision and scope

Use the selected SlateDB engine directly inside Meta Service. Keep the existing thin
authority-bound `snapshot` / `commit` / `resolve` service contract and in-process/remote
transports. Do not build alternative-engine adapters or another generic KV transaction
engine for this task. Earlier portable-backend proposals are not implementation prerequisites.

The pinned SlateDB 0.17.0 already provides concurrent transactions, snapshot/read-set
tracking and native writer fencing. Its
[source revision](https://github.com/slatedb/slatedb/blob/c1e36fc07fb9b759d31484dda18c1c1aad8a2853/slatedb/src/transaction_manager.rs)
implements `Snapshot` and `SerializableSnapshot` isolation. One active writing `Db`
installation may accept many concurrent tasks/transactions; multiple independent writing
instances opening the same root compete through fencing rather than becoming a multi-writer
database. Neither a service-wide mutex nor application conflict detection is an engine requirement.

Share `Engine` across requests and use native `SerializableSnapshot` transactions. Read
gateway ownership, mutation receipt, expected revision and the complete bounded group inside
one transaction; write encrypted changes, new revision and receipt in that transaction.
`expectedRevision` remains a service precondition, not a replacement conflict detector.
Native OCC arbitrates changes after the read. A known transaction conflict returns
`META_CONFLICT` without poisoning the engine. After a conflict, one fresh receipt lookup may
prove the identical mutation already committed, or identify a fingerprint mismatch. It never
replays changes, a business callback or a provider effect.

## Durability and coherent reads

Transaction commit returns a write handle before object durability. Await that handle's
`await_durable()` before acknowledging success. A non-conflict commit/durability error is
unknown and fails the process's serving path closed until recovery, as before.

Pin a native transaction's MVCC sequence, then wait for `Db::subscribe()` to report that
exact sequence object-durable before reading any of its records. Keep explicit Remote read
filters. A moving durable filter without this pinned frontier can otherwise return an old
revision and newer records if an earlier memory commit becomes durable between reads.
The prerequisite wait is bounded to 30 seconds and fails if the database closes. A later
commit cannot enter the pinned snapshot. Dropping a read transaction releases its MVCC pin.

This correctness-first release can wait behind earlier pending writes in other groups.
It does not claim independent read latency during an object-store outage. Native transactions
already admitted at a common frontier can execute concurrently; no application mutex spans
their object I/O or durability waits. Eight request slots still bound admission.

## Ownership and shutdown

Retain the conditional object owner for startup admission, explicit stopped-owner recovery
and fresh read barriers. SlateDB already handles writer fencing; the additional record is
not transaction conflict control or an automatic leader election. The read barrier prevents
a displaced process from serving cached authorization before it observes native fencing.
Revisit this record only with equivalent startup and fresh-read takeover evidence.

Retain the Node/Rust compatibility gateway owner. It protects the legacy provider/recovery
workflow, which still assumes one API writer; native storage transactions do not turn that
workflow into distributed claims. Gateway reads participate in the native transaction.

A shared lifecycle read guard admits concurrent operations. Closing takes the exclusive
lifecycle guard, drains accepted transactions, closes SlateDB and releases ownership.
Detached HTTP/in-process operations finish after caller cancellation. This lifecycle guard
is not a transaction mutex and does not serialize normal requests.

## Compatibility, evidence and follow-up

Keep Scope hashing, installation/record-bound AES-GCM, all KV paths, original document/vault
formats, revision/receipt semantics and HTTP contracts. No resource recreation, credential
rotation, live-root rewrite or Portal restart is part of this storage implementation change.
Global and every Region retain independent engines, identities and object roots.

Isolated real RustFS/S3 cases cover unrelated progress while one owner read is held, revision
races, duplicate/mismatched receipts, coherent concurrent snapshots, paused-WAL visibility,
graceful drain/reopen, crash recovery and old-owner rejection. Existing full Node/Rust
compatibility suites run with remote and in-process Meta, including credentials and Global
unavailable. The full shared/Rust gates and latest-head CI remain required delivery evidence.

Five-document reconstruction and its client-side queue are still compatibility boundaries.
Per-resource records/groups, query projections, fair sharding and multiple API writers remain
separate GH-74 work; native transactions alone do not remove document-level conflicts or
prove million-resource capacity. Usage timestamps/counters must eventually leave the primary
authorization document rather than making every data request a canonical metadata rewrite.
