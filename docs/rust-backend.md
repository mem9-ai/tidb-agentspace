# Modular Rust backend

- Direction: [ADR 0020](decisions/0020-modular-rust-backend.md) and the
  [GH-88 contract](../specs/gh-88/spec.md), accepted at `b90b68a0d3b437413c11845cdb1ba73af357b99f`.
- Full regional API implementation: [GH-92](https://github.com/siddontang/tidb.ai/issues/92).
- Rust **1.99.1**, a root Cargo workspace and committed `Cargo.lock`.
- The Rust full profile serves Workspace/Keys, lifecycle, SQL/browser, files, analysis,
  result/file exports and confirmed imports. Node remains a compatibility oracle, rollback
  implementation and build/migration tooling; Rust never forwards business operations to it.
- This is the existing loopback guest product profile. Production identity, typed multi-tenant
  repositories, Global policy distribution and million-resource sharding remain GH-74 work.

## Modules

| Crate                 | Responsibility                                                                         |
| --------------------- | -------------------------------------------------------------------------------------- |
| `backend/contracts`   | Metadata port, scoped context and structured errors                                    |
| `meta-service`        | Encrypted SlateDB/S3 authority, durable commits, fencing and mTLS server               |
| `backend/meta-client` | Authority-bound remote Meta adapter; TLS 1.3/mTLS, bounded requests, no retries        |
| `backend/workspace`   | Workspace/Key domain, authorization and five-document compatibility repository         |
| `backend/providers`   | Private Drive9, Zero and db9 lifecycle/vault adapters; native MySQL/PostgreSQL drivers |
| `backend/compute`     | Bundled DuckDB 2.0 and Bashkit; disposable workers from the same executable            |
| `backend/product`     | Regional resources, database browser, files, snapshots, analysis, exports/imports      |
| `backend/api`         | Public HTTP contract, sessions, Host/Origin/CORS, request/cancellation/stream limits   |
| `backend/host`        | Configuration, dependency wiring, real role composition and ordered shutdown           |

Domain operations are shared by Console and agent requests. Providers and computation are
separate crates behind regional application operations. Metadata supports in-process and remote
ports; those are implemented deployment modes. Provider/compute crates do not claim independent
public RPC services. Workers are separate processes even in an all-in-one deployment.

## Build, check and package

```sh
cargo build --workspace --locked
npm run backend:check
npm run check
npm run package:api:rust -- FULL_REVIEWED_SOURCE_SHA
```

`backend:check` runs workspace format, Clippy with warnings denied, Rust tests, and isolated
real RustFS/S3 metadata, ownership, Node/Rust parity and provider-recovery integration tests.
Ordinary `npm test` skips explicitly gated S3 cases; those skips are not integration evidence.
CI uses two Cargo jobs to bound native C++ compiler memory. Initial bundled DuckDB compilation
is substantially slower than an incremental Rust build. Reuse installed RustFS locally.

The debug executable is `meta-service/target/debug/workspace-backend`. For an optimized
artifact, build `cargo build --release --locked -p workspace-backend` and supply that executable
as the package command's second argument. Packaging requires the current clean reviewed Git
revision, writes source SHA/binary SHA-256/platform/architecture and archive checksums, and
includes only the binary, Cargo lockfile, contract and instructions. It excludes private
configuration, state, credentials, Console assets and Node runtime dependencies. A verified
native tidbfs extension is a separately supplied artifact, with its checksum preserved.

The existing `build:api` / `package` commands retain the Node compatibility artifact used by
existing deployment tests and rollback. `build:api:rust` / `package:api:rust` produce the Rust
serving artifact. The Console remains an independently built static artifact. A Node process
serving Vite/static files or running migration/test tools is not a Rust business dependency.

## One executable, independent roles

```sh
workspace-backend serve --config /absolute/private/deployment.json
```

A deployment file selects real roles; private files are owner-only ordinary files and all
references are absolute. A co-located plan can contain:

```json
{
  "format": 1,
  "services": [
    { "kind": "metadata", "configFile": "/srv/config/global-meta.json" },
    { "kind": "metadata", "configFile": "/srv/config/region-meta.json" },
    { "kind": "workspace", "configFile": "/srv/config/region-api.json" }
  ]
}
```

For separate processes, use one role per deployment file. Each Global/Region Meta has a
separate engine, installation, bucket/non-overlapping root, encryption key and identity.
The host rejects duplicates/overlapping roots before opening writers; actual IAM/DNS alias
isolation remains an operator responsibility. Global never opens Region metadata as a second
writer. `initialize` defaults false; it is only for deliberate empty-root initialization.

A full regional API configuration is:

```json
{
  "bind": "127.0.0.1:4318",
  "workspaceId": "ws_agentlab",
  "authorityId": "region:local-compat",
  "importId": "verified-existing-import-id",
  "insecureLoopback": true,
  "consoleOrigins": ["http://127.0.0.1:5173", "http://127.0.0.1:4173"],
  "metadata": { "transport": "inProcess", "authorityId": "region:local-compat" },
  "product": {
    "providers": {
      "filesProvider": "drive9-anonymous",
      "mysqlProvider": "tidb-cloud-zero",
      "postgresProvider": "db9-anonymous"
    },
    "compute": {
      "extensionPath": "/srv/artifacts/tidbfs.duckdb_extension",
      "extensionSha256": "verified-64-character-sha256"
    }
  }
}
```

For a separate regional API process, replace `metadata` with:

```json
{
  "transport": "remote",
  "client": {
    "origin": "https://region-meta.example.internal:7443",
    "authorityId": "region:local-compat",
    "installationId": "existing-region-installation",
    "tokenFile": "/srv/secrets/region-token",
    "tls": {
      "caFile": "/srv/pki/ca.crt",
      "certificateFile": "/srv/pki/client.crt",
      "privateKeyFile": "/srv/secrets/client.key"
    }
  }
}
```

Remote Meta requires TLS 1.3/mTLS; explicit loopback tests can use HTTP with
`insecureLoopback: true` in the client. Regional API startup/authentication/requests do not
use Global or require Global token renewal. Independent regional processes continue serving
when Global is unavailable. Co-location shares a process/host failure domain. A role task
failure leaves healthy roles running; the host is not an automatic HA supervisor.

Omitting `product` deliberately selects the original `workspace-keys-only` partial profile.
It does not advertise the full contract and must not replace a complete Portal API.
`product: {}` enables the full local/demo profile, including snapshot computation without
native tidbfs. Creating/querying native DuckDB databases requires the verified extension;
missing or incompatible artifacts fail before allocating private storage.

## Compatibility and boundaries

The full profile serves the unchanged generated `public/openapi.json`. Resource IDs, native
IDs, regional placement, opaque fields, contents, Key digests/grants/expiry/revocation and all
four native vaults retain their existing schema. The compatibility repository is bounded to
12 MiB per document with 64 KiB encrypted chunks; this is not the future scalable resource
index. Never route millions of resources through this compatibility profile.

The API retains the eight-hour local owner cookie, backend authorization, grant filtering,
Host/Origin/CORS policy, eight admitted requests, bounded bodies/timeouts and secret-once Key
creation. Files/content uploads require octet-stream; downloads stream with backpressure and
expected-length validation. Export bodies allow 8 MiB; other request bodies allow 1 MiB.
Native credentials, Key digests and private DuckDB storage do not enter public resource lists,
usage rows or worker snapshots. Owner sessions are not production login.

Provider creation persists intent before a non-idempotent request. Unknown Zero/Drive9
creation outcomes are not retried. db9 can recover the one deterministic database name under
the original anonymous account. Configuring bindings keep their generated restricted native
roles; restart/setup never rotates credentials or creates a replacement database. Pending
binding values are validated before interpolating server-generated setup SQL.

Native SQL drivers use verified TLS, fresh bounded connections, one statement, exact decimal/int8/
JSON/temporal text preservation and binary base64. Query results retain duplicate columns,
1,000-row/1 MiB limits and safe errors. Neither SQL nor uncertain writes are automatically
retried. Provider compatibility limits in the existing Zero/db9 guides still apply.

DuckDB is bundled into the executable at the existing engine major. The verified tidbfs
artifact is loaded only by native database workers. Selected-file SQL/preview/imports use
bundled CSV/JSON/Parquet support; they do not require provider extensions. Bashkit implements
the existing allowlisted virtual shell instead of spawning a host shell. See
[ADR 0021](decisions/0021-native-rust-computation.md) for the worker boundary and limits.

Exports preserve column order, CSV formula escaping, source/destination authorization,
create-only file/table writes, bounded SQL and partial-write errors. Prepared imports retain
actor binding, five-minute expiration, source-version comparison, field/type confirmation and
single-use submission. Handles are process-local as before; restart requires a new preparation.

## Migration, local cutover and rollback

Follow the complete [Meta migration guide](meta-service.md) before switching an entry point.
The public API never initializes missing expected documents or silently seeds demo resources.

1. Drain the old writer and export all **current** five Meta documents to owner-only files;
   sync files/directories and retain checksums. Preserve provider mode settings and the native
   extension path/checksum alongside existing metadata keys, runtime configuration and backups.
2. Resume the old API while checking an isolated regional copy. Do not run two gateways on
   the same compatibility documents. Compare existing native reads and contract/behavior
   fixtures without provisioning replacements or exposing private credentials.
3. After complete checks pass, drain the old API again and export fresh current state. Start
   the reviewed Rust artifact against the **original** regional authority/import and provider
   configuration. Keep the old listener stopped. Verify IDs/counts/Key grants/vaults, health,
   native reads and the existing Portal using the original API origin.
4. Update the local launcher to start the Rust artifact and retain a private rollback manifest.
   Do not overwrite unrelated Portal edits or re-import stale source JSON.
5. On failure, drain Rust, export current state if necessary, and restart Node against the same
   current regional Meta. Its gateway ownership contract is identical. Restore JSON only from
   a verified fresh export if deliberately abandoning Meta after all target writers stop.

The shared `legacy-gateway` record excludes simultaneous Node/Rust writers. Every document
operation checks its owner inside the metadata transaction. Clean shutdown drains requests
and releases the gateway before metadata closes. An uncertain claim/release requires explicit
reconciliation with the exact stopped owner; there is no timeout-based ownership takeover.
Metadata commits finish durably after caller disconnect; computation cancellation kills its
worker and releases query slots/private temporary snapshots.

Evidence is recorded in the implementation PR and private local cutover manifest. Live
provider availability is environment-dependent; offline CI verifies protocol/lifecycle
fixtures and real S3 durability without cloud credentials. Public hosting, distributed policy
sync/revocation, provider-side execution and production OS/container compute isolation remain
separate work; local snapshot workers are not a hostile-public-compute sandbox.
