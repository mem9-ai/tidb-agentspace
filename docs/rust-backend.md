# Modular Rust backend

- Direction: [ADR 0020](decisions/0020-modular-rust-backend.md) and the
  [GH-88 contract](../specs/gh-88/spec.md), accepted at `b90b68a0d3b437413c11845cdb1ba73af357b99f`.
- Full regional API implementation: [GH-92](https://github.com/siddontang/tidb.ai/issues/92).
- Rust **1.99.1**, a root Cargo workspace and committed `Cargo.lock`.
- Hosted integration: [ADR 0026](decisions/0026-native-hosted-studio.md) and [deployment/login guide](native-studio-deployment.md). Rust owns SSO, trusted public HTTP policy and `/studio`; old Node serving is retired. The owner permits fresh S3 roots/keys without migrating old data.
- The Rust full profile serves Workspace/Keys, lifecycle, SQL/browser, files, analysis,
  result/file exports and confirmed imports. The Node business implementation and its dedicated regression tests are removed. Rust also generates OpenAPI, supervises local roles and drives native acceptance.
- Managed TiDB Account login reserves a personal Workspace under [ADR 0030](decisions/0030-personal-account-isolation.md). The shared-owner SSO profile is a local compatibility fixture.

The fresh record profile supersedes the document migration baseline; see [ADR 0024](decisions/0024-fresh-record-metadata.md). Old format-1 installations are rejected, and no import or Node rollback backend is retained.

## Modules

Follow a regional file request from **API → product → Workspace** for authorization. Product then calls a provider for file I/O or Execute for analysis of an authorized snapshot. Follow a metadata write from **Workspace → contracts → Meta**. The host chooses embedded Meta or the remote client. Each module guide includes a focused test command to run from the repository root.

| Module                                            | Responsibility                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| [Host](../backend/host/README.md)                 | Executable, local supervision, role composition and shutdown          |
| [API](../backend/api/README.md)                   | Global and regional HTTP handlers, authentication and request limits  |
| [OpenAPI](../backend/openapi/README.md)           | Contract definitions, served views and offline exports                |
| [Product](../backend/product/README.md)           | Regional resource lifecycle, files, SQL, analysis and transfers       |
| [Workspace](../backend/workspace/README.md)       | Action and resource grants, versioned record repositories             |
| [Identity](../backend/identity/README.md)         | Personal identity reservations, Global Keys and regional grants       |
| [Providers](../backend/providers/README.md)       | Private Drive9 and db9 adapters and native PostgreSQL driver          |
| [Execute](../backend/execute/README.md)           | Disposable DuckDB and Bashkit tasks for selected snapshots            |
| [Contracts](../backend/contracts/README.md)       | Scoped metadata port, requests and service errors                     |
| [Meta client](../backend/meta-client/README.md)   | Authority-bound remote transport with mutual TLS                      |
| [Meta service](../meta-service/README.md)         | Encrypted SlateDB records, durable commit receipts and writer fencing |
| [Cache budget](../backend/cache-budget/README.md) | Shared host or container memory budget for database block caches      |
| [Analytics](../backend/analytics/README.md)       | Separate best-effort measurement service and asynchronous producers   |
| [Build tools](../backend/build-tools/README.md)   | Pinned native dependencies, packaging and acceptance profiles         |
| [Test support](../backend/test-support/README.md) | Isolated native processes, fixtures and HTTP acceptance cases         |

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

If Regional initialization fails after acquiring the Workspace writer, the host attempts
to release that writer before reporting the error. On shutdown it drains the roles,
releases Workspace writers, then closes Meta. An unconfirmed release makes the host
exit with an error. A restart after an uncertain exit requires checking ownership and
using the existing explicit recovery procedure.

The regional [Guest cleanup processor](../backend/api/src/guest_cleanup.rs) claims work through the identity scheduler. It records provider deletion attempts before I/O. An uncertain outcome remains available for reconciliation. Provider acceptance alone cannot establish physical erasure. See [Guest logout and cleanup](decisions/0029-guest-logout-cleanup.md).

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

Execute owns the child lifecycle, an empty environment, bounded pipes and kill-on-drop cancellation. Each task has a 15-second deadline. Snapshot tasks receive the selected data. PostgreSQL queries use the provider driver directly. The [public resource boundary](decisions/0058-public-resource-kinds.md) retired standalone MySQL and DuckDB databases.

Each child flushes the same stdout handle before process/runtime exit. Awaiting Tokio
`write_all` alone is not a completion barrier for its background writer. Buffered-output,
flush-failure, child cancellation/deadline and native CLI tests enforce this
boundary. Diagnostics report only exit status or response byte count, never input or secrets.
See [ADR 0021](decisions/0021-native-rust-computation.md) and the implemented
[architecture diagram](architecture.md#backend-boundaries).

## Build, check and package

```sh
cargo run --locked -p workspace-build-tools -- prepare
cargo build --locked --workspace --bins --examples
cargo acceptance all
cargo run --locked -p workspace-build-tools -- package FULL_REVIEWED_SOURCE_SHA
```

[Contribution checks](../CONTRIBUTING.md#rust-backend-modules) include workspace formatting, Clippy and unit tests. For compilation timings add `--timings` to the build command. The [CI policy](ci-cd.md) describes which jobs can reuse the compiled dependencies.

The prepare command checks the platform, archive length and SHA-256 digests pinned in `scripts/duckdb-runtime.json`. It verifies the local cache or downloads the official static libraries used for File System SQL analysis. Cargo's checked-in configuration selects that directory. The Execute build script verifies each linked library.

Native macOS ARM64 and Linux x86-64 GNU are currently pinned; cross builds and other targets
fail explicitly until an appropriate artifact is pinned and verified.

The core-functions, JSON, Parquet and local extension-loader libraries are registered once before
opening a database. Existing autoload/autoinstall, external access and selected-file restrictions
remain enforced. The API stays one executable without a DuckDB shared-library runtime dependency.
`workspace-backend runtime-info` reports its embedded DuckDB version/target/archive identity;
packaging rejects an executable that disagrees with the source pins and records that identity.
See
[DuckDB's official library distribution](https://duckdb.org/docs/2.0/operations_manual/installing_duckdb/install_script)
and [Rust linking options](https://duckdb.org/docs/2.0/clients/rust/troubleshoot).

The debug executable is `meta-service/target/debug/workspace-backend`. For an optimized
artifact, run `cargo run --locked -p workspace-build-tools -- prepare`, then build `cargo build --release --locked -p workspace-backend` and supply that executable
as the package command's second argument. Packaging requires the current clean reviewed Git
revision, writes source SHA/binary SHA-256/platform/architecture and archive checksums, and
includes only the binary, Cargo lockfile, contract and instructions. It excludes private
configuration, state, credentials, Console assets and Node runtime dependencies.

`workspace-backend serve-api --config /absolute/private/deployment.json` runs a regional plan. For a local installation use `workspace-backend local init` and `workspace-backend local serve`. See the [quick start](../README.md#local-setup).

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
      "postgresProvider": "db9-anonymous"
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
`product: {}` enables the full local/demo profile, including snapshot computation with the bundled DuckDB engine.

## Compatibility and boundaries

The full profile serves the unchanged generated `public/openapi.json`. Resource IDs, native
IDs, regional placement, opaque fields, contents, Key digests/grants/expiry/revocation and private Binding and Credential records use the fresh versioned schema. Domain aggregate views are bounded to 4096 records/24 MiB; ordinary authorization uses point reads. The product [pages resource lists](../backend/product/src/resource_pages.rs) using bounded index reads. The [scale design](decisions/0035-sparse-scale-metadata.md) records the limits of that implementation.

The API retains the eight-hour local owner cookie, backend authorization, grant filtering,
Host/Origin/CORS policy, eight admitted requests, bounded bodies/timeouts and secret-once Key
creation. Files/content uploads require octet-stream; downloads stream with backpressure and
expected-length validation. Export bodies allow 8 MiB; other request bodies allow 1 MiB.
Native credentials, Key digests and private DuckDB storage do not enter public resource lists,
usage rows or worker snapshots. Hosted sessions require verified TiDB Account sign-in; local guest sessions remain explicit loopback only.

Provider creation persists intent before a non-idempotent request. Unknown Drive9
creation outcomes are not retried. db9 can recover the one deterministic database name under
the original anonymous account. Configuring bindings keep their generated restricted native
roles; restart/setup never rotates credentials or creates a replacement database. Pending
binding values are validated before interpolating server-generated setup SQL.

Native SQL drivers use verified TLS, fresh bounded connections, one statement, exact decimal/int8/
JSON/temporal text preservation and binary base64. Query results retain duplicate columns,
1,000-row/1 MiB limits and safe errors. Neither SQL nor uncertain writes are automatically
retried. Provider compatibility limits in the [db9 guide](db9-postgres.md) still apply.

Sales sample status reads reconcile a recorded `outcome_unknown` file-write intent by
reading only its existing File System and `/us-sales.csv`. The bounded bytes must exactly
match the public fixture and have a stable version across verification before the attempt
is durably marked `ready`. Missing, changed, inaccessible or unverifiable files retain their
unknown outcome. This also recovers conditional-create conflicts with an existing identical
sample; it never overwrites files, provisions resources or replays provider writes. Native
sales-sample acceptance covers scoped observation, concurrent checks, restart and no replay.

Selected-file SQL, previews and imports use the bundled DuckDB engine with CSV, JSON and Parquet support. Bashkit implements
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

Package reviewed clean source with a full SHA and binary/archive checksums. Keep configuration and state outside the artifact. Deploy all version-coupled API/Meta roles, verify readiness, authorized/denied reads and the Portal. A source upgrade cannot silently reset an incompatible root. The owner now authorizes a fresh hosted deployment under ADR 0026, using a new S3 prefix and keys. For managed customer isolation and its deployment limits, see [ADR 0030](decisions/0030-personal-account-isolation.md). Sharding and automatic HA remain future work.

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
