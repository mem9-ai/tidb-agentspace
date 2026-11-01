# Architecture decisions

Record a short ADR for a change to a public contract, isolation model, credential boundary,
billing behavior, design-system foundation, or deployment architecture. Number files
sequentially as `NNNN-short-title.md`. Include status, context, decision, consequences,
migration, and how the decision is verified. Routine implementation choices do not need an ADR.

## Accepted decisions

- [0037: Single Portal sign-in](0037-single-portal-login.md) — one existing OIDC callback,
  distinct Global/Region sessions and joint logout for the bundled cloud deployment.

- [0033: Workspace-owned tutorial progress](0033-workspace-tutorial-progress.md) — durable
  bookmarks, conditional Owner writes, safe browser migration and cross-browser resume.

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

- [0014: Automatic Console publishing](0014-console-auto-publishing.md) — a scoped GitHub App synchronizes tested static artifacts to the existing Netlify site.

- [0015: Public-client TiDB Account sign-in](0015-public-client-sso.md) — code + S256 PKCE without a client secret; provider registration and owner authorization remain explicit.

- [0016: Verified email owner grants](0016-verified-email-owner-rules.md) — opt-in verified email rules for full owner access to the existing shared workspace; no user isolation.

- [0013: Result snapshot exports](0013-result-snapshot-exports.md) — accepted and implemented bounded downloads and create-only copies into public workspace resources.

- [0014: File analysis engine options](0014-file-analysis-engine-options.md) — separate format/default engine from supported methods; CSV supports SQL and raw-text Bash with individual availability.

- [0015: Bash Workspace paths](0015-bash-workspace-paths.md) — preserve the selected file's visible path inside its isolated snapshot, with discovered input metadata and non-conflicting legacy aliases.

- [0016: Selected Bash file variable](0016-bash-selected-file-variable.md) — discoverable, quoted `$FILE` for each fresh selected-file execution; initial examples retain absolute paths.

- [0017: Preview-first file workspace](0017-preview-first-file-workspace.md) — implemented unified reading/analysis experience and bounded read-authorized tabular preview.

- [0018: Contextual file exports](0018-contextual-file-exports.md) — accepted original/output separation and confirmed bounded database import; implementation pending.

- [0020: Modular Rust backend](0020-modular-rust-backend.md) — accepted unified Rust direction, shared modules with single-executable or independent service deployment, preserving regional authority and phased API/resource parity.

- [0022: Native SlateDB transactions](0022-native-slatedb-transactions.md) — concurrent native metadata transactions, pinned object-durable snapshots, receipt replay and lifecycle drain; fixed-engine service contract with compatibility ownership retained.

- [0023: Database import workspace](0023-database-import-workspace.md) — accepted and implemented destination-owned local/public-file CSV/Parquet preparation, reviewed new-table writes and target-bound tickets under GH-103.

- [0027: Single CI evidence](0027-single-ci-evidence.md) — one automatic normal/native/browser gate, exact-commit delivery consumers and retained credential boundaries.

- [0028: Guest expiry retention](0028-guest-expiry-retention.md) — regional Guest expiry and retention boundaries; partially superseded by ADR 0029.
- [0029: Guest logout and provider cleanup](0029-guest-logout-cleanup.md) — authenticated Guest termination, scoped provider attempts, and pending reconciliation.
- [0030: Personal TiDB Account isolation](0030-personal-account-isolation.md) — account-scoped regional access and explicit retirement of the shared Workspace.
- [0032: Writer-safe dev release](0032-writer-safe-dev-release.md) — bounded health checks and explicitly compatible, fenced image recovery for the single-writer profile.

- [0038: Bounded raster image previews](0038-bounded-image-preview.md) — authorized, size-limited image preview with signature checks and an export fallback.

## Proposed decisions

- [0034: Global Key authority and independently serving Regions](0034-openapi-security-authorities.md) — owner-confirmed Key/Token and regional autonomy direction; detailed implementation and security gates proposed.

- [0035: Sparse-activity metadata scale](0035-sparse-scale-metadata.md) — proposed independent authority shards and Workspace resource partitioning; bounded resource page reads are a first slice.

- [0019: Portable Workspace KV control plane](0019-workspace-kv-control-plane.md) — Global-initiated encrypted control, independent regional serving, pooled cells/bounded groups, selected hosted SlateDB/object storage, private regional storage directory and identity-preserving migration; phased implementation.

- [0021: Native Rust computation](0021-native-rust-computation.md) — Region-internal Execute with same-binary child tasks; bundled DuckDB, restricted Bashkit snapshot workers, native SQL and Node-free regional serving.

- [0024: Fresh record metadata](0024-fresh-record-metadata.md) — accepted local reset direction; removes document/import and Node handoff paths.

- [0025: Consolidated hosted and native runtime profiles](0025-consolidated-runtime-profiles.md) — retain hosted SSO/CD/storage while merging the complete native profile.

- [0026: Native hosted Studio](0026-native-hosted-studio.md) — Rust SSO/public hosting, independent `/studio` publication, and explicitly fresh S3 roots/keys; supersedes hosted Node compatibility.

- [0031: Agent REST P0](0031-agent-rest-p0.md) — authenticated context, parsed read-only SQL, retained resource deletion status and atomic file preconditions.

- [0032: REST workflow resources](0032-rest-workflow-resources.md) — addressable preparations, durable setup attempts and removal of historical command routes under GH-76.

- [0036: Global-only Workspace Keys](0036-global-keys-only.md) — retire regional customer Keys, preserve resources/provider credentials, and expose the new Global/Region flow with complete examples.
