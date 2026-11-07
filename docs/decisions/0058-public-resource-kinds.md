# ADR 0058: Publish only supported resource kinds

Accepted on 2026-11-07. Supersedes the compatibility records and customer cleanup routes in [ADR 0048](0048-postgresql-only-databases.md).

The Workspace offers PostgreSQL-compatible databases and File Systems. Resource discovery,
agent context and Console bootstrap return capability entries for exactly these two kinds.
PostgreSQL retains its availability flag so clients can distinguish an unconfigured provider.

Resource schemas, examples, tutorials, catalog queries and imports follow the same boundary.
Authorized requests to read or delete an old standalone database by ID return 404 before
provider I/O. Its stored data and credentials stay untouched. Database queries accept SQL
for the selected PostgreSQL database. File analysis continues to execute SQL over an
authorized file snapshot.

Clients consuming the former MySQL or standalone DuckDB entries must remove those lookups.
The native regression test seeds both old records, checks the three discovery responses and
direct operations, verifies the records and bindings are intact, and exercises PostgreSQL
queries and File System analysis.
