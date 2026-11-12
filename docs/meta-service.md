# Rust record metadata service

For the complete architecture, clean target domain model and iteration plan, start with
[SlateDB Metadata Architecture Version 1](slatedb-metadata-design.md). This guide describes
the running service, its configuration and its current limits.

The implemented profile uses SlateDB **0.18.0**, Rust **1.99.1** and object storage as the source of truth for acknowledged writes. [ADR 0024](decisions/0024-fresh-record-metadata.md) defines the fresh record layout and retires the five-document compatibility bridge. [ADR 0022](decisions/0022-native-slatedb-transactions.md) supplies the native transaction and durable read rationale.

Global and every Region own separate engines, installations, storage roots, encryption keys and service tokens. Global records regional storage descriptors; regional serving does not look up Global, renew a Global token, or fall back to another store. The local topology shares one RustFS host as a functional development environment; it is not production disaster recovery or regional IAM isolation.

## Memory cache budget

Accepted owner direction: determine the runtime memory capacity, calculate one cache budget,
then divide it among database instances. Do not select a fixed capacity for each instance.

The native host uses the smaller of physical RAM and applicable Linux cgroup limits.
It checks cgroup v1, v2 and visible ancestor limits. Unknown physical capacity stops startup.
The initial default reserves **10 percent** for cache entries, rounded down to whole MiB.
This ratio is a project policy, not a measured optimum. Swap does not increase the budget.
The remaining memory supports the OS, APIs, MemTables, compaction and execution workers.
Cache capacity counts weighted entries; it does not limit process RSS.

The native deployment plan divides this total equally among its Meta or Analytics instances.
The local supervisor calculates one total before starting its separate Meta processes.
It passes the same total and instance count to every child, including after restart.

| Effective memory | Total cache budget | Instances | Cache per instance |
| ---------------- | ------------------ | --------- | ------------------ |
| 512 MiB          | 51 MiB             | 2         | 25 MiB             |
| 2 GiB            | 204 MiB            | 2         | 102 MiB            |
| 24 GiB           | 2457 MiB           | 3         | 819 MiB            |

Inspect the current allocation with `workspace-backend cache-budget --instances 3`.
An optional `--total-mib` argument supplies an explicit total. Startup also logs the budget.
The native plan accepts `memoryCache.totalMiB` to override the total; 0 disables all caching.
For separate processes sharing one memory allocation, set the same `totalMiB` and `instances`
in every plan. Count all Meta and Analytics engines in that allocation. The loader rejects
a count smaller than its local instance count. It does not discover unrelated processes.
Independent containers use their own limits; operators must also budget their combined host use.

A service's optional `blockCacheMib` can reduce its assigned share or disable it with 0.
It cannot exceed that share. Omission or null selects the assigned share; no fixed default applies.
The standalone Meta binary treats an explicit value as its single-instance total.
Library callers must supply an allocation; an unassigned library engine has caching disabled.
Changes take effect after graceful restart. Preserve existing storage roots and encryption keys.

Each engine retains a private Foyer pool for data blocks, indexes and filters together.
Only the memory budget is coordinated; entries and credentials are never shared across instances.
Disk/object-store caching remains disabled. Tests cover aggregate limits, small capacities,
container ancestors, separate process plans, and local supervisor restarts.

Verified upstream behavior for [SlateDB 0.18.0](https://github.com/slatedb/slatedb/tree/v0.18.0):
the default Foyer split cache permits 512 MiB of data and 128 MiB of metadata **per database**.
Always supply the explicit pool when adding an engine; enabling a Cargo feature alone is not
a memory budget. Recheck this boundary when upgrading SlateDB. The regression test flushes
records into SSTs, reopens with a cold cache, and checks warm point/prefix reads for data,
index and filter hits without new cache misses; disabling the cache preserves results.

Caching does not remove all S3 requests. MemTable reads already avoid SST reads; cache misses,
durable writes, manifests and the existing fresh owner/fencing checks still use object storage.
The [0.18.0 release](https://github.com/slatedb/slatedb/releases/tag/v0.18.0) also avoids reading
filters that cannot answer a prefix scan. Transaction creation is now synchronous; the service
still waits for the pinned sequence's durable frontier before authoritative reads.

## Records and transactions

The internal authority-bound service exposes `get`, `list`, `commit` and `resolve`. These are a thin service boundary over the selected SlateDB, not a replaceable-engine framework. Shared Rust modules support direct in-process calls or TLS 1.3/mTLS transport. Outside explicit loopback development, plaintext transport is rejected.

`get` reads named records. `list` scans an ordered prefix with an exclusive cursor and bounded page size. Records contain an opaque version and a JSON value, encrypted individually using installation/path-bound AES-GCM. `commit` checks the supplied version of each changed record, applies one native serializable transaction, records the mutation receipt and awaits durable WAL acknowledgement. Repeating the identical mutation resolves its receipt; changing its fingerprint returns a conflict. Business callbacks and upstream effects are never replayed automatically.

A pinned native sequence is awaited to the object-durable frontier before reading. One response cannot expose pending in-memory grants or mix versions. Unknown writes fail serving closed until recovery. An S3 owner record protects startup and fresh-read takeover; SlateDB itself supplies native writer fencing. The shutdown lifecycle drains accepted requests before closing the engine.

## Domain layout

Workspace/profile, each Resource, Key, local file, activity entry, provider Binding and private Credential are separate records. Key digest indexes reference canonical Key records; authentication reads that Key and its real expiry/revocation before authorizing a resource. The engine checks its configured authority and binds ciphertext to the installation and record path. Scope hashing organizes the namespace; tenant authorization and Workspace selection remain in the business backend. Service tokens and provider credentials never reach the Console.

`system/writer` retains one active API writer per Workspace while provider coordination remains process-local. A lost writer requires explicit recovery with its exact stopped owner; no timeout steals ownership. The same Region can host multiple independent Workspaces. The [identity layer](../backend/identity/README.md) establishes caller identity and grants. Provider operations still require Workspace-level writer coordination.

## Local development

From the repository root, use the pinned [Rust toolchain](../rust-toolchain.toml) and RustFS 1.0.4 on your path. The local stack includes the API and its file-analysis worker, so prepare the pinned DuckDB build inputs first. For work on Meta alone, `cargo build --locked -p workspace-meta-service` builds the standalone service.

```sh
cargo run --locked -p workspace-build-tools -- prepare
cargo build --locked -p workspace-backend
./meta-service/target/debug/workspace-backend local init --directory .data/meta-runtime --api-port 4318
./meta-service/target/debug/workspace-backend local serve --directory .data/meta-runtime
```

Run `local init` once. It creates a new private directory with credentials and a configuration for Global and each of two regional Meta authorities. The first serve initializes their separate object-store buckets. The default Workspace ID is `ws_agentlab`. Use `--workspace` at initialization to select another ID, or `--binary` to pin the native executable. The regional API reads its private provider settings from `rust-api.json`.

`local serve` runs in the foreground. The [Rust supervisor](../backend/host/src/local/supervisor.rs) starts RustFS and a child of the same native executable for each Meta role and the regional API. Set `RUSTFS_BINARY` to select an installed RustFS executable. In another terminal, inspect the supervisor and check API readiness:

```sh
./meta-service/target/debug/workspace-backend local status --directory .data/meta-runtime
curl --fail http://127.0.0.1:4318/api/health
```

Stop the stack with Ctrl-C in the serving terminal, or run `./meta-service/target/debug/workspace-backend local stop --directory .data/meta-runtime`. Use `local serve` with the same directory to reopen it. If shutdown leaves ownership uncertain, inspect the existing processes and writer identity before recovery.

### Run a standalone Meta authority

For an independently managed object store, the [standalone entry point](../meta-service/src/main.rs) accepts a private [Meta configuration](../meta-service/src/config.rs). Provision its storage access, encryption key and service token first. For a fresh installation add `--initialize` on the first run. Reopen the existing installation with its original configuration:

```sh
cargo run --locked -p workspace-meta-service -- --config /absolute/private/meta.json
```

Use `--recover-owner <stopped-owner-id>` only after confirming the recorded writer has stopped. Clients authenticate with the configured authority, installation and service token. The local stack's public API health probe above uses a separate endpoint.

## Version boundary and reset

Installation format 2 and the `recordsV1` capability replace format-1 document storage. Old installations fail explicitly; they are not silently interpreted as empty. JSON import/export and language-handoff commands were removed. For an existing customer installation, a future reviewed migration or old-code recovery would be needed. Existing production upgrades follow the [public compatibility policy](decisions/0061-public-compatibility.md).

For an authorized disposable reset, stop/drain the API, all Meta services and the local object server, remove only that deployment's local state/configuration, then initialize a new directory. Do not delete upstream resources or credentials elsewhere as an incidental cleanup step.

## Validation and current limits

For engine and cache changes, run `cargo test --locked -p workspace-meta-service --lib`. For durable commits, writer fencing and restart through the native protocol, build the fixtures and run the [Meta acceptance target](../backend/test-support/tests/meta.rs) with RustFS 1.0.4 available:

```sh
cargo run --locked -p workspace-build-tools -- prepare
cargo build --locked --workspace --bins --examples
cargo test --locked -p workspace-test-support --test meta -- --ignored --test-threads=1
```

The tests create their own temporary storage and credentials. See [native verification](native-backend-retirement.md) for coverage of the two transports and the full backend acceptance run.

Resource lists use bounded index reads. Some Workspace aggregate views still enforce a 4096-record/24-MiB limit. Each authority uses a single physical shard and each Workspace has one active API writer. Automated failover, receipt garbage collection and million-resource capacity remain open in the [scale design](decisions/0035-sparse-scale-metadata.md).
