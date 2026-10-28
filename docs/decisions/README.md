# Architecture decisions

Record a short ADR for a change to a public contract, isolation model, credential boundary,
billing behavior, design-system foundation, or deployment architecture. Number files
sequentially as `NNNN-short-title.md`. Include status, context, decision, consequences,
migration, and how the decision is verified. Routine implementation choices do not need an ADR.

## Accepted decisions

- [0001: Unified Workspace Key](0001-unified-workspace-key.md)
- [0002: TiUI as the shared frontend foundation](0002-tiui-design-system.md) — implemented;
  see its linked standard for current integration and verification evidence.
- [0003: File System regions and provider modes](0003-filesystem-regions-and-modes.md) —
  Singapore default, additive API support, preserved existing regions, and mode boundaries.

- [0004: Drive9 anonymous provider](0004-drive9-anonymous-provider.md) — real Singapore files, private backend bindings, bounded transfers, and explicit provisioning recovery.

- [0005: Independently delivered Console and API](0005-independent-console-and-api.md) — one repository, OpenAPI-generated client, separate runtime artifacts, and retained loopback identity.
- [0006: Zero SQL gateway](0006-zero-sql-gateway.md) — real anonymous MySQL, backend credentials, scoped Workspace Keys, expiry/recovery, and temporary PG withdrawal.

- [0007: Database browsing](0007-database-browser.md) — scoped schema reads, bounded data preview, and table-to-editor navigation.

- [0008: DuckDB private storage](0008-duckdb-private-storage.md) — implemented with a verified native runtime; dedicated backing files hidden behind each DuckDB database.
- [0009: Query-scoped file sources](0009-duckdb-file-sources.md) — implemented authorized, query-scoped CSV/JSON/Parquet inputs in DuckDB; source credentials remain in the backend.

- [0010: Read-only file analysis](0010-read-only-file-analysis.md) — scoped snapshot workers, DuckDB SQL and Just Bash, explicit compute permission and bounded execution.

- [0011: Anonymous db9 PostgreSQL](0011-db9-postgres.md) — implemented anonymous PostgreSQL with private credentials, restricted native roles and provider compatibility limits.

- [0012: DuckDB catalog reader](0012-duckdb-catalog-reader.md) — bounded read-only reuse for server-generated browsing, while customer SQL remains disposable.
