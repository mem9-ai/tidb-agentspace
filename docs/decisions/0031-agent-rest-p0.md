# ADR 0031: Agent discovery, read-only SQL and conditional resource mutations

- Status: Accepted direction; implementation tracked by GH-67.
- Date: 2026-10-31.

Adopt the [REST design standard](../standards/rest-api-design.md) and the
[GH-67 behavioral contract](../../specs/gh-67/spec.md). Preserve current format-2 records and
credentials; new public fields are additive. Context is scoped by the regional Workspace
URL, avoiding a Global dependency or a scan of millions of tenant Keys.

Add `queries:read` without changing `queries:execute`. Read-only SQL uses a bounded parser
and conservative function subset, not a SELECT prefix or a request label. PostgreSQL uses
server read-only transactions and DuckDB read-only storage in addition to parsing. TiDB's
[documented READ ONLY compatibility](https://docs.pingcap.com/tidb/stable/sql-statement-start-transaction/)
still allows writes; it is not a security boundary. PostgreSQL's
[transaction access mode](https://www.postgresql.org/docs/current/sql-set-transaction.html)
is a second enforcement layer, not a substitute for rejecting unsafe SQL syntax/functions.

Resource deletion journals uncertain effects before contacting providers and retains
bindings/credentials. An accepted asynchronous provider request is not verified erasure.
Zero lacks a verified deletion API. No autonomous retry, new task queue or service is added.
The bounded single-writer Workspace currently uses process-local coordination; distributed
admission/fencing and million-resource capacity remain separate work.

File conditions use one strong validator. Local compare/write is transactional. Drive9's
`X-Dat9-Expected-Revision` implements atomic revision CAS; its HEAD exposes `X-Dat9-Revision`
and `X-Dat9-Resource-ID`. Verified against `mem9-ai/drive9` server/client/datastore source
on 2026-10-31. No unconditional fallback is permitted. See the spec for identity-race limits.

The owner explicitly requests native API acceptance without frontend tests for this task.
Existing Console contracts remain additive; shared formatting/types/build hygiene still runs.
