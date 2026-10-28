# ADR 0011: Reuse a bounded read-only DuckDB catalog reader

- Status: Implemented for the loopback prototype, 2026-10-28.
- Reproduction and scope: [GH-39](https://github.com/siddontang/tidb.ai/issues/39).
- Amends: [ADR 0008](0008-duckdb-private-storage.md) for **server-generated browsing SQL only**.

## Context and decision

A table-details request previously ran four sequential statements in four disposable native
workers. Each reopened remote database storage. On the same Singapore database, the table
list took 6.1 seconds and the details took 26.4 seconds. Native inspection confirmed attachment
costs dominated SQL execution; merely opening read-only did not materially change them.

Read columns, constraints and indexes in one native SELECT with ordered nested results.
Keep at most one reusable catalog worker per API process, attached to one private database
read-only. Reuse it only for server-generated list/details/100-row-preview SELECTs. Every
operation uses a fresh SQL connection. No catalog results or authorization decisions are cached.
The API checks the current Workspace Key's workspace/action/resource/expiry/revocation before
invoking the adapter on every request. Never route customer SQL or file-source queries here.

Close the reader after 15 seconds idle or 60 seconds total age (after an active request ends).
Close an idle reader before any ordinary SQL/provisioning or switching database, releasing
its storage handle before opening another worker. While the reusable reader is busy, a
catalog request for another database uses a disposable read-only worker under existing
admission. Idle eviction and subsequent launches share a close barrier; idle readers do not
add an extra worker beyond the existing four-operation budget. Same-database operations
remain serialized and return busy rather than queueing unbounded work.

Timeout, disconnect, native errors and API close dispose the reader. A request's 15-second
budget includes reader release/reconnection; do not retry SQL automatically. Keep native
memory, statement/result limits, locked configuration, verified artifacts and backend-only
credentials unchanged. Public SQL and selected-file catalogs retain disposable workers.

## Consequences, verification and recovery

Repeated table inspection avoids remote reattachment. First access after eviction remains a
cold remote connection; this change does not accelerate arbitrary customer SQL or provide a
shared SQL session. A read-only handle holds native resources briefly. Single-process,
loopback operation is still the deployment boundary; multi-instance writers and public
untrusted SQL require separate isolation/coherence work.

Native tests in `server/duckdb-catalog.test.mjs` count real worker launches, verify ordered
metadata/escaped names/views/indexes, writer handoff, database isolation, read-only enforcement,
timeout/cancellation, idle/age eviction, shutdown and failure without retries. API tests cover
Key denials after browsing. The runtime guide records live timings; CI needs no cloud keys.
Revisit the lease and storage behavior when upgrading the pinned extension or introducing
multi-process API deployment. Rollback restores disposable catalog reads without changing
public contracts, bindings or stored data.
