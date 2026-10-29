# Modular Rust backend

- Direction: [ADR 0020](decisions/0020-modular-rust-backend.md) and the
  [GH-88 contract](../specs/gh-88/spec.md), accepted at `b90b68a0d3b437413c11845cdb1ba73af357b99f`.
- Full regional API implementation: [GH-92](https://github.com/siddontang/tidb.ai/issues/92).
- Rust **1.99.1**, a root Cargo workspace and committed `Cargo.lock`.
- The Rust full profile serves Workspace/Keys, lifecycle, SQL/browser, files, analysis,
  result/file exports and confirmed imports. Node remains an isolated regression oracle and build/test tooling; Rust never forwards business operations to it.
- This is the existing loopback guest product profile. Production identity, typed multi-tenant
  repositories, Global policy distribution and million-resource sharding remain GH-74 work.

The fresh record profile supersedes the document migration baseline; see [ADR 0024](decisions/0024-fresh-record-metadata.md). Old format-1 installations are rejected, and no import or Node rollback backend is retained.

## Modules

| Crate                 | Responsibility                                                                         |
| --------------------- | -------------------------------------------------------------------------------------- |
| `backend/contracts`   | Metadata port, scoped context and structured errors                                    |
| `meta-service`        | Encrypted SlateDB/S3 authority, durable commits, fencing and mTLS server               |
| `backend/meta-client` | Authority-bound remote Meta adapter; TLS 1.3/mTLS, bounded requests, no retries        |
| `backend/workspace`   | Workspace/Key domain, authorization and versioned record repositories                  |
| `backend/providers`   | Private Drive9, Zero and db9 lifecycle/vault adapters; native MySQL/PostgreSQL drivers |
| `backend/compute`     | Bundled DuckDB 2.0 and Bashkit; disposable workers from the same executable            |
| `backend/product`     | Regional resources, database browser, files, snapshots, analysis, exports/imports      |
| `backend/api`         | Public HTTP contract, sessions, Host/Origin/CORS, request/cancellation/stream limits   |
| `backend/host`        | Configuration, dependency wiring, real role composition and ordered shutdown           |

Domain operations are shared by Console and agent requests. Providers and computation are
separate crates behind regional application operations. Metadata supports in-process and remote
ports; those are implemented deployment modes. Provider/compute crates do not claim independent
public RPC services. Workers are separate processes even in an all-in-one deployment. Each worker returns one bounded JSON reply and flushes the same stdout handle before process/runtime exit. Awaiting Tokio `write_all` alone is not a completion barrier for its background writer. Buffered-output and flush-failure regression cases enforce this IPC boundary; diagnostics report only exit status or response byte count, never request contents or credentials.

## Build, check and package

```sh
cargo build --workspace --locked
npm run backend:check
npm run check
npm run package:api:rust -- FULL_REVIEWED_SOURCE_SHA
```

`backend:check` runs workspace format, Clippy with warnings denied, Rust tests, and isolated
real RustFS/S3 metadata, ownership, Node/Rust parity and provider-recovery integration tests.
Heavy native test files run serially to bound concurrent RustFS/role startup and packaging resources; concurrency behavior is exercised explicitly inside those tests. Ordinary `npm test` skips explicitly gated S3 cases; those skips are not integration evidence.
CI uses two Cargo jobs and omits native/Rust debug symbols to bound cold-build time and memory. Functional checks and warnings-as-errors remain enabled. Initial bundled DuckDB compilation
is substantially slower than an incremental Rust build. Reuse installed RustFS locally.

The debug executable is `meta-service/target/debug/workspace-backend`. For an optimized
artifact, build `cargo build --release --locked -p workspace-backend` and supply that executable
as the package command's second argument. Packaging requires the current clean reviewed Git
revision, writes source SHA/binary SHA-256/platform/architecture and archive checksums, and
includes only the binary, Cargo lockfile, contract and instructions. It excludes private
configuration, state, credentials, Console assets and Node runtime dependencies. A verified
native tidbfs extension is a separately supplied artifact, with its checksum preserved.

`npm start`, `start:api`, `dev:api` and the API portion of `npm run dev` now start Rust.
Set `WORKSPACE_BACKEND_CONFIG` to the absolute private deployment file; optionally set
`WORKSPACE_BACKEND_BINARY` to the absolute reviewed artifact. The default binary is the local
Cargo debug build. Missing configuration fails explicitly, with no alternate data file or
fallback backend. The old Node serving commands were removed.
The optional npm launcher is tooling; the distributed native artifact runs directly without it.

`build:api` builds Rust and `package` creates the native API and separate static Console artifacts. The API contains no Node backend, provider state or frontend assets. Node sources under `server/` are regression oracles and tooling, without a serving entry point.

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
  "initializeWorkspace": false,
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
IDs, regional placement, opaque fields, contents, Key digests/grants/expiry/revocation and private Binding and Credential records use the fresh versioned schema. Domain aggregate views are bounded to 4096 records/24 MiB; ordinary authorization uses point reads. Public pagination, provider claims and sharding still require separate implementation.

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

## Fresh bootstrap and deployment

Follow [Meta setup](meta-service.md) to initialize a new deployment. `initializeWorkspace` defaults false and missing Workspace metadata fails closed. Set it true only for deliberate first creation, then disable it after verification. The common executable can host independent metadata and Workspace roles, while local supervision remains optional tooling.

Resources, Keys, files, bindings and credentials are independent encrypted records. Reads use bounded prefix pages; writes condition only changed records on their versions. Existing domain/bootstrap operations reconstruct bounded projections rather than storing or rewriting JSON documents. Key authentication uses its digest index and canonical record; resource authorization performs a point read. Native credentials remain internal.

The API has one active writer per Workspace until provider lifecycle claims support concurrent API writers. `recoverWriterOwner` names the exact stopped owner after a crash; there is no lease timeout or global dependency. Storage version 2 intentionally rejects the old five-document installation. JSON import/export, legacy vault codecs and Node/Rust handoff are retired under [ADR 0024](decisions/0024-fresh-record-metadata.md).

Package reviewed clean source with a full SHA and binary/archive checksums. Keep configuration and state outside the artifact. Deploy all version-coupled API/Meta roles, verify readiness, authorized/denied reads and the Portal. A source upgrade cannot silently reset an incompatible root. The owner authorized one disposable local reset; cloud instances are outside that operation. Production identity, distributed policy, sharding and automatic HA remain future work.
