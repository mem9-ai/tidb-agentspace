# ADR 0011: Anonymous db9 PostgreSQL behind Workspace Keys

Runtime/storage amendment: [ADR 0020](0020-modular-rust-backend.md) selects the Rust backend;
[ADR 0024](0024-fresh-record-metadata.md) replaces the original JSON vault/runtime with
individual encrypted Meta records. Original integration evidence below remains historical.

- Status: accepted in PR #41; implemented for owner-requested integration, 2026-10-28.
- Parent: [GH-40](../../specs/gh-40/spec.md). See [runtime guide](../db9-postgres.md) and [verification](../db9-verification.md).

The owner supplied db9 as a free PostgreSQL service. Add it as an independent PostgreSQL
provider; it is not TiDB Cloud PG Starter. The existing single Workspace Key continues to
combine action and resource grants, while the service owns all upstream credentials.

Use official REST for anonymous registration/token refresh/database creation and verified-TLS
PostgreSQL wire sessions for native setup and SQL. The official HTTP SQL endpoint documents
result-shape restrictions (including commented SELECT/EXPLAIN); native execution provides the
single-statement and result boundary directly. No db9 or Ti CLI is a product dependency.

Store account and resource credentials in an owner-only ignored PG vault, separate from public
resource state. Persist intent before side effects and returned bindings before setup. Never
re-register or recreate automatically after an uncertain result. A setup retry may recover the
same deterministic instance by reading provider metadata. A generated native role owns the
workspace schema and has no superuser, create-role or create-database power. Customers never
execute with the provider account token or admin role. Validate the provider host/port/user and
all untrusted metadata; no public credential/URL/TLS override inputs are accepted.

Reuse query budgets, result envelopes, backend authorization, private state durability and
cancellation behavior from the existing SQL boundary. Browse the workspace schema only, with
PostgreSQL quoting. Do not revive old simulated PG records. Unknown metering/region/lifetime
stays explicit; token expiry is not database expiry. Free-tier availability and quotas remain
provider-controlled; no paid upgrade or account claim is automatic.

Verified official references (2026-10-28):

- [REST API](https://db9.ai/docs/api/): anonymous-register/refresh, database creation/lookup,
  user creation and HTTP SQL behavior.
- [Anonymous lifecycle](https://db9.ai/docs/platform/anonymous-and-claimed-databases/): anonymous
  accounts need no email/card; five databases including branches, refreshable seven-day token.
- [Native connection/TLS](https://db9.ai/docs/connect/): PostgreSQL tenant-prefixed role,
  postgres database, pg.db9.io / pg.d0000.db9.io and ports 5432/5433. TLS must be requested.
- [Security](https://db9.ai/docs/platform/security-and-auth/): regular users require GRANTs
  and cannot perform superuser operations. Verify deployed role/schema behavior before enabling.

Read the actual provider response rather than relying on illustrative connection examples.
Revisit for persistent production identity, tenant-scale account ownership, connection pools,
read-only roles, multiple schemas or another PostgreSQL provider. Existing prototype local
identity, owner-only credential files and rollback limitations still apply.

Verified deployment compatibility: db9 documents NUMERIC as limited to 28–29 significant
digits ([data types](https://db9.ai/docs/sql/data-types/)). Live testing confirmed loss of the
30th digit in a cast. The gateway preserves native text values, but cannot restore precision
the provider already removed. Surface this in Details and API/agent documentation; do not
advertise unrestricted PostgreSQL type compatibility. Timestamp text, JSON, bigint and numeric
wire values bypass JavaScript number/date coercion. Expression index parts without a catalog
column name are labeled as expressions, rather than inventing a column identity.
