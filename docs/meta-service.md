# Rust record metadata service

For the complete architecture, clean target domain model and iteration plan, start with
[SlateDB Metadata Architecture Version 1](slatedb-metadata-design.md). This guide describes
the running service, its configuration and its current limits.

The implemented profile uses SlateDB **0.18.0**, Rust **1.99.1** and object storage as the source of truth for acknowledged writes. [ADR 0024](decisions/0024-fresh-record-metadata.md) defines the fresh record layout and retires the five-document compatibility bridge. [ADR 0022](decisions/0022-native-slatedb-transactions.md) supplies the native transaction and durable read rationale.

Global and every Region own separate engines, installations, storage roots, encryption keys and service tokens. Global records regional storage descriptors; regional serving does not look up Global, renew a Global token, or fall back to another store. The local topology shares one RustFS host as a functional development environment; it is not production disaster recovery or regional IAM isolation.

## Memory cache budget

Each Meta configuration accepts `"blockCacheMib": 32`. Omitted values default to **32 MiB per
engine**; an integer from 0 through 1024 is accepted. Set 0 to disable the cache or, for example,
8 to reduce it on a small host. Invalid values fail validation before storage is opened.
Changes take effect after a graceful service restart; retain the existing roots and keys.

The `foyer` feature is enabled explicitly, and one private Foyer memory pool holds data blocks,
indexes and filters together. The configured budget is their combined weighted entry capacity,
not a data-only budget with an additional hidden metadata cache. Pools are never shared across
Global, Region or Analytics installations. Disk/object-store caching remains disabled.

| Engines sharing a host/container                     | Default total cache entry budget |
| ---------------------------------------------------- | -------------------------------- |
| Global Meta + one Region Meta                        | 64 MiB                           |
| Global Meta + two Region Meta (local development)    | 96 MiB                           |
| Global Meta + one Region Meta + one Analytics engine | 72 MiB                           |

[Analytics](product-analytics.md) uses the same `blockCacheMib` option with an **8 MiB** default.
Count every engine in each deployment, including separate processes on the same small host.
These budgets are project defaults, not measurements of the deployed machine's memory limit.
Before increasing them, inspect both container limits and available host memory. Reserve space
for MemTables, compaction, in-flight reads, cache bookkeeping, the API and computation workers:
weighted cache capacity is not a process RSS limit. With a tighter budget, setting both Meta
engines to 8 MiB reduces their combined cache capacity to 16 MiB.

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

`system/writer` retains one active API writer per Workspace while provider coordination remains process-local. A lost writer requires explicit recovery with its exact stopped owner; no timeout steals ownership. The same Region can host multiple independent Workspaces. This is not production identity or multi-writer provider execution.

## Local development

```sh
npm ci
npm run backend:build
npm run meta:local -- init --directory .data/meta-runtime --api-port 4318
npm run meta:local -- serve --directory .data/meta-runtime
```

Init creates a **new** owner-only directory, three distinct Meta configurations, fresh encryption/service/storage credentials and an empty Workspace configuration. It does not read `.data/workspace.json`, import old state or provision cloud resources. Pass `--binary /absolute/reviewed/workspace-backend` to pin an immutable native artifact. `--workspace ws_example` selects a different API Workspace identity for backend evaluation; the current Console targets `ws_agentlab`. API provider/compute configuration lives in private `rust-api.json`; see [the Rust guide](rust-backend.md).

Serving uses the common native executable for Global Meta, each Region Meta and the regional API, each in its own process. The optional Node supervisor owns only local orchestration and RustFS. Initial creation is explicit; successful initialization is persisted and later startup refuses missing expected metadata. Stop the supervisor gracefully before another start. Preserve a held/uncertain runtime lock until its processes have been inspected and stopped.

Reuse installed RustFS **1.0.4** (`RUSTFS_BINARY` can select it). Tests use independent temporary data directories, ports, buckets and credentials. They never load the developer's persistent state.

## Version boundary and reset

Installation format 2 and the `recordsV1` capability replace format-1 document storage. Old installations fail explicitly; they are not silently interpreted as empty. JSON import/export and language-handoff commands were removed. For an existing customer installation, a future reviewed migration or old-code recovery would be needed. The owner's explicit local reset authorization applies only to the named test deployment and excludes deletion of cloud instances.

For an authorized disposable reset, stop/drain the API, all Meta services and the local object server, remove only that deployment's local state/configuration, then initialize a new directory. Do not delete upstream resources or credentials elsewhere as an incidental cleanup step.

## Validation and current limits

Run `npm run check` and `npm run backend:check`. The latter covers Rust format/Clippy/tests and real S3 integration: fresh bootstrap, version races, ordered pagination, receipts, durable visibility, crash/writer recovery, mTLS, tenant/authority isolation and full API behavior in both transport modes. Ordinary Node tests explicitly gate the native/S3 suites.

The Meta record API has bounded pages and per-record conditions. The current Console/domain aggregate still has a 4096-row/24-MiB view bound; its public APIs need pagination before large deployments. Single Workspace API ownership, one physical shard per authority, receipt GC, production identity and automatic HA remain future work. Do not advertise million-resource capacity from this implementation.
