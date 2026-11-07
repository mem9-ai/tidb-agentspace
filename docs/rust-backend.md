# Modular Rust backend

- Direction: [ADR 0020](decisions/0020-modular-rust-backend.md) and the
  [GH-88 contract](../specs/gh-88/spec.md), accepted at `b90b68a0d3b437413c11845cdb1ba73af357b99f`.
- Full regional API implementation: [GH-92](https://github.com/siddontang/tidb.ai/issues/92).
- Rust **1.99.1**, a root Cargo workspace and committed `Cargo.lock`.
- Hosted integration: [ADR 0026](decisions/0026-native-hosted-studio.md) and [deployment/login guide](native-studio-deployment.md). Rust owns SSO, trusted public HTTP policy and `/studio`; old Node serving is retired. The owner permits fresh S3 roots/keys without migrating old data.
- The Rust full profile serves Workspace/Keys, lifecycle, SQL/browser, files, analysis,
  result/file exports and confirmed imports. The Node business implementation and its dedicated regression tests are removed. Node runs build/operator tools and native test fixtures only; Rust never forwards business operations to it.
- Explicit local guest mode and hosted shared-Workspace SSO are supported. Typed multi-tenant
  repositories, Global policy distribution and million-resource sharding remain GH-74 work.

The fresh record profile supersedes the document migration baseline; see [ADR 0024](decisions/0024-fresh-record-metadata.md). Old format-1 installations are rejected, and no import or Node rollback backend is retained.

## Modules

| Crate                  | Responsibility                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `backend/contracts`    | Metadata port, scoped context and structured errors                                          |
| `backend/identity`     | Inactive Global identity reservations and Region-local owner policy primitives               |
| `meta-service`         | Encrypted SlateDB/S3 authority, durable commits, fencing and mTLS server                     |
| `backend/meta-client`  | Authority-bound remote Meta adapter; TLS 1.3/mTLS, bounded requests, no retries              |
| `backend/workspace`    | Workspace/Key domain, authorization and versioned record repositories                        |
| `backend/providers`    | Private Drive9, Zero and db9 lifecycle/vault adapters; native MySQL/PostgreSQL drivers       |
| `backend/execute`      | Region-internal Executor; prebuilt static DuckDB 2.0/Bashkit tasks via the same binary       |
| `backend/product`      | Regional resources, database browser, files, snapshots, analysis, exports/imports            |
| `backend/analytics`    | Independent SlateDB analytics process and bounded asynchronous producers; no Meta dependency |
| `backend/api`          | Public HTTP contract, sessions, Host/Origin/CORS, request/cancellation/stream limits         |
| `backend/host`         | Configuration, dependency wiring, real role composition and ordered shutdown                 |
| `backend/cache-budget` | System and container memory limits; one cache budget divided among database instances        |

The identity module reserves a complete Global personal identity group atomically and stores only
verifiers for Guest secrets. The co-located Global-initiated Region initialization installs owner
policies, an empty Workspace and an expiry job. A separately deployed Global must use an
authenticated Region control service and never open a remote Region Meta store directly.

Approximate analytics runs only in a separate, single-writer process under [ADR 0050](decisions/0050-isolated-analytics-service.md); see [configuration and failure semantics](product-analytics.md). It never shares the Meta service or prevents product serving when unavailable.

The native host has an explicitly configured co-located Guest mode. It routes an authenticated
regional browser cookie to a bounded Workspace pool, rechecking the durable grant and policy on each
request and retaining a Workspace lease through response streams. The host-only `Secure`,
`HttpOnly`, `SameSite=Strict` cookie expires at the Guest's original deadline. The auth configuration
identifies the active browser session, and sign-out revokes and clears attached Guest and account
sessions. With Global down, existing regional sessions continue while new signup is unavailable. A failed Global startup
requires a host restart before new signups can resume.

The opt-in host runs a bounded regional scheduler that claims expired Guest jobs and marks them
`providerCleanupDeferred`. It does not contact providers or delete resource or credential records;
it does not assert that in-flight work has drained or resources were deleted. The queue preserves
claims and uncertain outcomes for later reconciliation. See [ADR 0028](decisions/0028-guest-expiry-retention.md).

This is not yet complete hosted multi-tenancy. The default configuration leaves Guest disabled;
account SSO still grants the legacy shared Workspace. Guest Keys can address an explicit Workspace without a browser cookie; Key-based Workspace
discovery and crash recovery for active Workspace writers remain outstanding. Regional identity checks deny
expired Guest access, but a future destructive executor must fence in-flight operations before
provider effects or removal of records. Production rollout has not been verified.

An inactive DB9 cleanup adapter can issue one deletion request for a durably claimed Guest
resource after checking the scoped Workspace, provider binding, existing account and Region
policy. A successful [DB9 deletion response](https://db9.ai/docs/api/) is acceptance only, not
proof that the resource has been deleted. A production executor must fence and drain in-flight
operations, reconcile provider state, and verify every owned resource before removing metadata
or credentials. Missing credentials or an uncertain outcome must remain visible for recovery.
There is no running cleanup executor or verified live-provider deletion in this implementation.

Domain operations are shared by Console and agent requests. Providers and computation are
separate crates behind regional application operations. Metadata supports in-process and remote
ports; those are implemented deployment modes. Provider/Execute crates do not claim independent
public RPC services. Execute is an internal Region module, not another service role.

## Regional Execute

Product operations call `Executor.execute(task)` in process. The default implementation
starts `workspace-backend execute` using the currently running executable, passes one bounded
JSON request through stdin and receives one bounded JSON reply through stdout. The child
exits after that task. There is no Execute listener, service discovery, broker, durable task
queue, independently deployed binary or separately configured service.

`product.execute` is the sole native-extension configuration. Unknown product fields reject
at startup rather than silently selecting a fallback. Pre-production development names are
replaced directly; there are no transitional command/configuration aliases. Provider
connections, metadata and public HTTP request/response contracts are unchanged. This refactor
does not add an in-process thread strategy.

Execute owns child lifecycle, an empty environment, bounded pipes, discarded stderr and
kill-on-drop cancellation. The normal deadline is 15 seconds; only server-generated native
import writes retain the existing 30-second commit budget. Analysis admission remains two
tasks; native DuckDB admission remains four tasks with one active query per database.
Snapshot tasks receive selected data only. Persistent DuckDB tasks receive only their own
private storage connection. Native MySQL/PostgreSQL requests use provider drivers directly.

Each child flushes the same stdout handle before process/runtime exit. Awaiting Tokio
`write_all` alone is not a completion barrier for its background writer. Buffered-output,
flush-failure, child cancellation/deadline and native CLI tests enforce this
boundary. Diagnostics report only exit status or response byte count, never input or secrets.
See [ADR 0021](decisions/0021-native-rust-computation.md) and the implemented
[architecture diagram](architecture.md#backend-boundaries).

## Build, check and package

```sh
npm run backend:build
npm run backend:check
npm run check
npm run package:api:rust -- FULL_REVIEWED_SOURCE_SHA
```

`backend:check` checks formatting first, then builds the workspace and runs Clippy with warnings denied, Rust tests, and isolated
real RustFS/S3 metadata, ownership, native API contracts and provider-recovery integration tests.
Heavy native test files run serially to bound concurrent RustFS/role startup and packaging resources; concurrency behavior is exercised explicitly inside those tests. Ordinary `npm test` skips explicitly gated S3 cases; those skips are not integration evidence.
CI uses two Cargo jobs and omits Rust debug symbols to bound cold-build time and memory. Functional checks and warnings-as-errors remain enabled. Reuse installed RustFS locally.

For focused checks after preparing/building the native backend, use `backend:fmt`,
`backend:clippy`, `backend:test` and `backend:test:integration`. CI runs those same phases as
separate steps and caches dependency builds, excluding workspace binaries, incremental
state and private runtime data. See [the cache and timing policy](ci-cd.md#rust-build-cache-and-timing-evidence)
for cache scope, invalidation and cold/warm verification. `npm run backend:build -- --timings`
produces a local Cargo HTML report in `meta-service/target/cargo-timings/`; CI retains this
report as an artifact. A warm cache still builds the current workspace and runs every check.

DuckDB 2.0.0 uses official **prebuilt static libraries**, with release/archive and individual-file
SHA-256 pins in `scripts/duckdb-runtime.json`. `npm run backend:build` first runs
`backend:prepare`, which verifies or downloads the matching native artifact into ignored build
cache. There is no bundled DuckDB C++ compilation, system-library probing or automatic fallback.
For direct Cargo commands, first run `npm run backend:prepare`; checked-in Cargo configuration
selects the fixed static path, and the Execute build script verifies every linked library. A
native-only build environment can supply those exact pinned files at that path and run Cargo
without Node; the preparation script itself uses only Node built-ins, without Console packages.
Native macOS ARM64 and Linux x86-64 GNU are currently pinned; cross builds and other targets
fail explicitly until an appropriate artifact is pinned and verified.

The core-functions, JSON, Parquet and local extension-loader libraries are registered once before
opening a database. Existing autoload/autoinstall, external access and selected-file restrictions
remain enforced. The API stays one executable without a DuckDB shared-library runtime dependency.
`workspace-backend runtime-info` reports its embedded DuckDB version/target/archive identity;
packaging rejects an executable that disagrees with the source pins and records that identity.
The separate tidbfs extension still requires its own verified artifact. See
[DuckDB's official library distribution](https://duckdb.org/docs/2.0/operations_manual/installing_duckdb/install_script)
and [Rust linking options](https://duckdb.org/docs/2.0/clients/rust/troubleshoot).

The debug executable is `meta-service/target/debug/workspace-backend`. For an optimized
artifact, run `npm run backend:prepare`, then build `cargo build --release --locked -p workspace-backend` and supply that executable
as the package command's second argument. Packaging requires the current clean reviewed Git
revision, writes source SHA/binary SHA-256/platform/architecture and archive checksums, and
includes only the binary, Cargo lockfile, contract and instructions. It excludes private
configuration, state, credentials, Console assets and Node runtime dependencies. A verified
native tidbfs extension is a separately supplied artifact, with its checksum preserved.

`start:api:rust`, `dev:api` and the API portion of `npm run dev` explicitly start Rust. `npm start` and `start:api` also select Rust.
Set `WORKSPACE_BACKEND_CONFIG` to the absolute private deployment file; optionally set
`WORKSPACE_BACKEND_BINARY` to the absolute reviewed artifact. The default binary is the local
Cargo debug build. Missing configuration fails explicitly, with no alternate data file or
fallback backend. No alternate backend is started when native configuration is missing.
The optional npm launcher is tooling; the distributed native artifact runs directly without it.

`build:api:rust` builds Rust and `package` creates the native API and separate static Console artifacts. The API contains no Node backend, provider state or frontend assets. `build:api` is the native build; the hosted image contains no Node runtime.

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

The independent Global public API uses a `global` role; [Global configuration](global-public-api.md)
and [regional Token configuration](regional-token-api.md) describe the opt-in security flow.
They can share this binary or run in separate processes; the default hosted plan remains
co-located. For separate processes, use one role per deployment file. Each Global/Region Meta has a
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
    "execute": {
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
usage rows or worker snapshots. Hosted sessions require verified TiDB Account sign-in; local guest sessions remain explicit loopback only.

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

Package reviewed clean source with a full SHA and binary/archive checksums. Keep configuration and state outside the artifact. Deploy all version-coupled API/Meta roles, verify readiness, authorized/denied reads and the Portal. A source upgrade cannot silently reset an incompatible root. The owner now authorizes a fresh hosted deployment under ADR 0026, using a new S3 prefix and keys. Distributed policy, customer isolation, sharding and automatic HA remain future work.

## Shared Global listener behind a gateway

A Region with `publicPath:"/studio"` and a shared Global mount at `/studio/api/global`
accepts both a preserved public prefix and the gateway's `/studio`-stripped internal prefix
`/api/global`. Both mounts use the same Global router and enforce its Host, Origin, Owner
and Token rules. Public discovery, OpenAPI servers, issuer, cookie paths and the existing
Portal callback retain their configured external paths; the internal mount is not a new
authority or a data proxy. See [path hosting](independent-delivery.md#hosting-below-a-path).

Native SSO acceptance exercises both forwarding modes: one Portal callback, isolated
Global/Region sessions, Owner-only Key creation, Global-to-Region Token issuance and a
regional resource mutation, plus hostile Host/Origin, cross-session and logout denials.
