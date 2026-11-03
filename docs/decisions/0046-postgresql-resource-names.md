# ADR 0046: PostgreSQL-compatible resource names

- Status: implemented locally, 2026-11-03.
- Scope: resource creation names and Console wording.

The owner requested PostgreSQL resource suggestions beginning with `tidb_pg`. PostgreSQL
resource names may therefore include lowercase ASCII letters, digits, hyphens and underscores,
must begin with a letter and remain 3–40 characters. Other resource kinds retain their existing
name contract. Existing names and provider identities are unchanged. The public creation schema
and native validation enforce the same distinction, and provider-generated database names and
credentials remain independent of the Workspace resource name.

The Console uses “PostgreSQL-compatible” as capability wording and does not imply that the
currently configured provider is a TiDB Cloud Starter instance. It retains known compatibility
limits, including NUMERIC precision. Provider identifiers remain unchanged in the public API.

Native API cases cover permitted and rejected names, idempotency and other kinds; schema and
browser cases cover the documented contract, generated suggestions and form validation. This
is additive for existing clients and does not change existing resources or authorization.
