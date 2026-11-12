# Architecture decisions

Record a short ADR for a change to a public contract, isolation model, credential boundary,
billing behavior, design-system foundation, or deployment architecture. Number files
sequentially as `NNNN-short-title.md`. Include status, context, decision, consequences,
migration, and how the decision is verified. Routine implementation choices do not need an ADR.

## Decisions and implementation status

- [0058: Public resource kinds](0058-public-resource-kinds.md) — PostgreSQL databases and File Systems across API discovery and direct access.

- [0055: Unified trial duration](0055-unified-trial-duration.md) — 48-hour new anonymous sessions across browser and agent entry; preserve existing deadlines.

- [0050: Independent analytics service](0050-isolated-analytics-service.md) — separate SlateDB process, storage and credentials; asynchronous best-effort delivery with lower availability than Meta.

- [0049: Product analytics and operator authority](0049-product-analytics-operator-boundary.md) — accepted launch measurement and verified PingCAP/TiDB Cloud Admin access; [runtime and deployment limits](../product-analytics.md).

- [0048: PostgreSQL-only databases](0048-postgresql-only-databases.md) — retire standalone MySQL and DuckDB databases while retaining File System analysis. ADR 0058 supersedes the compatibility entries and cleanup routes.

- [0039: Manual dev smoke release](0039-dev-smoke-release.md) — explicitly selected basic
  dev acceptance with trusted same-commit Quality, protected image deployment and health checks.

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

- [0007: Database browsing](0007-database-browser.md) — scoped schema reads, bounded data preview, and table-to-editor navigation.

- [0010: Read-only file analysis](0010-read-only-file-analysis.md) — scoped snapshot workers, DuckDB SQL and Just Bash, explicit compute permission and bounded execution.

- [0011: Anonymous db9 PostgreSQL](0011-db9-postgres.md) — implemented anonymous PostgreSQL with private credentials, restricted native roles and provider compatibility limits.

- [0014: Automatic Console publishing](0014-console-auto-publishing.md) — a scoped GitHub App synchronizes tested static artifacts to the existing Netlify site.

- [0015: Public-client TiDB Account sign-in](0015-public-client-sso.md) — code + S256 PKCE without a client secret; provider registration and owner authorization remain explicit.

- [0016: Verified email owner grants](0016-verified-email-owner-rules.md) — partially deprecated. Shared-owner rules apply to the loopback fixture. Managed hosting follows [ADR 0030](0030-personal-account-isolation.md).

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
- [0040: Authority-local System State](0040-system-state-metadata.md) — system-owned metadata in each existing Meta authority; security checkpoints use Meta in fresh installations. [ADR 0043](0043-portal-agent-region-control.md) updates connection direction.
- [0041: One Global endpoint for agents](0041-single-global-entry.md) — Key-based discovery, bodyless redirect and direct regional requests.
- [0042: Global Workspaces and regional resources](0042-workspace-resource-regions.md) — one default Region per Workspace initially, independently recorded resource placement, and non-destructive legacy interpretation.
- [0043: Portal, Agent and Region control boundaries](0043-portal-agent-region-control.md) — separate browser, Agent and service interfaces; Region-initiated authenticated control.
- [0044: Workspace audit and request history](0044-workspace-observability.md) — authority-local audit and HTTP history; implementation pending.

## Proposed decisions

- [0034: Global Key authority and independently serving Regions](0034-openapi-security-authorities.md) — owner-confirmed Key/Token and regional autonomy direction; detailed implementation and security gates proposed.

- [0035: Sparse-activity metadata scale](0035-sparse-scale-metadata.md) — proposed independent authority shards and Workspace resource partitioning; bounded resource page reads are a first slice.

- [0019: Portable Workspace KV control plane](0019-workspace-kv-control-plane.md) — Global-initiated encrypted control, independent regional serving, pooled cells/bounded groups, selected hosted SlateDB/object storage, private regional storage directory and phased implementation. The document migration was retired by [ADR 0024](0024-fresh-record-metadata.md).

- [0021: Native Rust computation](0021-native-rust-computation.md) — Region-internal Execute with same-binary child tasks; bundled DuckDB, restricted Bashkit snapshot workers, native SQL and Node-free regional serving.

- [0024: Fresh record metadata](0024-fresh-record-metadata.md) — accepted local reset direction; removes document/import and Node handoff paths.

- [0025: Consolidated hosted and native runtime profiles](0025-consolidated-runtime-profiles.md) — retain hosted SSO/CD/storage while merging the complete native profile.

- [0026: Native hosted Studio](0026-native-hosted-studio.md) — Rust SSO/public hosting, independent `/studio` publication, and explicitly fresh S3 roots/keys; supersedes hosted Node compatibility.

- [0031: Agent REST P0](0031-agent-rest-p0.md) — authenticated context, parsed read-only SQL, retained resource deletion status and atomic file preconditions.

- [0032: REST workflow resources](0032-rest-workflow-resources.md) — addressable preparations, durable setup attempts and removal of historical command routes under GH-76.

- [0036: Global-only Workspace Keys](0036-global-keys-only.md) — retire regional customer Keys, preserve resources/provider credentials, and expose the new Global/Region flow with complete examples.

- [0046: PostgreSQL-compatible resource names](0046-postgresql-resource-names.md) — permit underscores for PostgreSQL Workspace names and use compatibility wording in the Console.

- [0047: Default File System](0047-default-file-system.md) — provision a new Workspace's first File System once and reuse it for the sales sample.

- [0051: Guest Workspace entry](0051-guest-workspace-entry.md) — load the Console and prepare a fresh Guest’s default File System concurrently.

- [0052: Anonymous local agent reports](0052-anonymous-agent-report.md) — isolated public sample and local credential lifecycle.
- [0053: Read-only Studio report links](0053-trial-report-view.md) — stable per-report viewing and expiry.
- [0054: Private CSV workspace for a local agent](0054-private-agent-csv.md)

- [0056: Report continuity](0056-report-continuity.md) — canonical project/Workspace files, visible updates and explicit link revocation.

- [0057: Account display identity](0057-account-display-identity.md) — verified session name/email, separate from the editable Workspace display profile.

- [0059: Rust backend workflow](0059-rust-backend-workflow.md) — one native entry point for local operation, OpenAPI and backend verification.

- [0060: Workspace Key resource types](0060-workspace-key-resource-types.md) — explicit and dynamic resource grants.

## Deprecated decisions

These records preserve the rationale and evidence for retired product paths. [ADR 0058](0058-public-resource-kinds.md) defines the supported public resources. File System SQL analysis continues under [ADR 0010](0010-read-only-file-analysis.md).

- [0006: Zero SQL gateway](0006-zero-sql-gateway.md)
- [0008: DuckDB private storage](0008-duckdb-private-storage.md)
- [0009: Query-scoped file sources](0009-duckdb-file-sources.md)
- [0012: DuckDB catalog reader](0012-duckdb-catalog-reader.md)
- [0045: DuckDB creation-time table snapshot](0045-duckdb-creation-table-snapshot.md)
