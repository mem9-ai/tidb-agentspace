# Rust metadata service and legacy migration

- Status: Implemented initial storage profile for GH-86, following the owner-approved
  [GH-74 design](../specs/gh-74/spec.md) and [ADR 0019](decisions/0019-workspace-kv-control-plane.md).
- Engine: SlateDB **0.17.0**, Rust **1.99.1**, checked-in root Cargo lockfile shared with the Rust backend workspace.
- Scope: Independent Global/regional metadata services and an opt-in bounded compatibility
  adapter for the existing single-Workspace Node gateway. Full multi-tenant domain migration,
  Global/Region public APIs, automatic HA and million-resource sharding remain future work.

## Ownership and persistence

Global and each Region run separate `workspace-meta-service` processes with distinct authority
and installation IDs, S3 buckets/roots, encryption keys, capability tokens, WALs/manifests and
writer ownership. They reuse service code. A configured authority cannot read or write another
authority's scope. Global's private directory records regional deployment descriptors; normal
regional serving has no Global client, lookup, token renewal or storage fallback.

The active Node business backend remains ESM during the [staged Rust migration](rust-backend.md).
Its optional document-store factory replaces persistence
for the Workspace state and all four provider vaults. It verifies the installed import before
startup and refuses missing documents. State is refreshed before admission; private vaults
refresh at authorized provider entry points. Mutations read a fresh revision, run the existing
callback once and conditionally commit. Conflicts and unknown outcomes do not replay callbacks
or provider I/O. JSON mode remains available for new local demos; a migrated source is frozen.

The compatibility gateway is **single-active** across Node and Rust: it acquires a revision-checked regional
gateway owner record before opening vaults. Every document operation carries that owner and
is checked atomically by Rust. A second gateway rejects with `META_GATEWAY_ACTIVE`; an old
gateway is fenced after explicit recovery. Unguarded legacy clients cannot access documents
while the gateway is active. Clean shutdown releases ownership before its close callback
completes. Existing process-local provider provisioning maps are not distributed claims, so
this guard is required until the typed lifecycle/claim design supports multiple API writers.

This compatibility profile keeps existing IDs, exact Key grants/digests/expiry, opaque legacy
fields, local file contents, provider recovery state and hidden DuckDB storage relationships.
The active legacy Workspace document remains regional. Global currently stores the deployment
directory and a safe import/resource inventory, not the new design's complete live identity,
policy or desired-state domain. Do not advertise full multi-tenancy from this storage bridge.

Inside a service, one serialized owner applies atomic SlateDB batches containing changes,
revision and mutation receipt. Success waits for `await_durable()`. Reads explicitly select
`DurabilityLevel::Remote`, so pending memory does not become authorization truth. An S3
conditional owner record gates startup and every read/write; SlateDB also fences displaced
writers. An unknown write poisons that process's serving path until recovery. Eight admitted
requests bound the queue; unauthorized requests reject before body extraction/storage I/O.

There is one physical SlateDB shard per service in this first profile. Ordinary commits allow
100 changes/1 MiB with values up to 256 KiB. Bounded snapshot groups allow 512 records/18 MiB.
The explicit `legacy-document` compatibility family allows 260 changes/18 MiB, encoding at
most 12 MiB of original JSON into 64 KiB chunks. It rewrites one bounded legacy document and
is not the scalable typed-repository/collection-index profile. Receipts currently remain
retained; production retention/GC, paging and fair multi-shard scheduling require later work.

All KV values, revisions and receipts are encrypted with AES-256-GCM before reaching SlateDB.
Authentication binds ciphertext to installation and record identity. Random nonces prevent
plaintext reuse; corrupt/swapped records fail closed. Local key material is a private 32-byte
hex file. Production supplies it from an independently recoverable regional secret system.
No encryption keys or provider credentials belong in Global registry descriptors, Git,
browser responses, URLs or logs. Installation/owner bootstrap objects contain safe identity
and an encrypted key check. Losing the encryption root cannot be repaired by seeding metadata.

## Build and verify

```sh
npm ci
npm run meta:build
npm run check
npm run meta:check
```

`meta:check` runs Rust formatting, Clippy with warnings denied, Rust tests and real S3 protocol
integration against **RustFS 1.0.4**. Reuse the installed `rustfs` binary; tests create isolated
temporary volumes, ports, buckets and credentials and clean up their child processes. CI
downloads the pinned official Linux binary and verifies its published SHA-256. No cloud
credentials are required. Ordinary `npm test` explicitly skips the S3 integration cases;
the separate required review evidence comes from `meta:check`/the metadata CI job.

The Rust binary also builds independently with `cargo build --release --locked --manifest-path
meta-service/Cargo.toml`. The Node API still builds/packages independently and contains its
metadata client/import/export tools; it connects to an external service rather than embedding
Rust or requiring frontend dependencies. The Console never receives metadata capability tokens.

## Local persistent topology

Use a new private directory and the existing legacy state path:

```sh
npm run meta:local -- init --directory .data/meta-runtime --source .data/workspace.json
npm run meta:local -- serve --directory .data/meta-runtime
```

Initialization writes private bootstrap configuration once. Serving starts one local RustFS,
Global Meta Service, `region:local-compat` and `region:local-secondary`, each with its own
bucket/installation. Global receives their safe storage descriptors. `topology.json` records
successful initialization; restart never auto-initializes a missing expected root. A Global
role failure does not stop healthy regional children. Stop the supervisor gracefully to
release ownership. Its `runtime.lock` is not stolen automatically after a crash.

This is a local functional topology: the RustFS process/host and operator identity are shared.
It is not regional disaster recovery or production IAM/failure-domain evidence. Local S3's
signing-region setting does not establish geographic residency. Production deploys each Rust
service, storage and identities independently; the local supervisor is not a hosted dependency.

The private operator `node-bridge.json` contains Global and Region client descriptors for
import. `node-serving.json` contains only the regional client and import identity for the
running gateway. Regional operation never requires the operator file's Global credentials.

## Import and cutover

```sh
npm run meta:migrate -- --dry-run --source .data/workspace.json \
  --config .data/meta-runtime/node-bridge.json
```

Dry-run reads and validates the legacy reference graph, including public/live bindings and
DuckDB private-storage edges. It does not seed, freeze, provision or contact providers. The
first compatibility gateway supports the existing `ws_agentlab`; it never changes an ID to
fit a different tenant. Provider `automatic`/legacy region strings remain unchanged; the
local execution authority is explicitly `local-compat`, not a new geographic placement.

Stop and drain **every** old gateway/worker/provider refresher. Preserve the actual running
provider environment and preview launcher as additional backup inputs. Then import:

```sh
npm run meta:migrate -- --source .data/workspace.json \
  --config .data/meta-runtime/node-bridge.json \
  --backup .data/meta-runtime/backups/legacy-workspace --source-frozen \
  --runtime-file .data/provider-runtime.json
```

The tool acquires a persistent source migration marker, creates owner-only synced backups,
verifies source stability and backup integrity, stages every document, reads back and compares
the exact original bytes, records the safe Global inventory, then marks the regional import
verified. No create/setup/register/delete/rotation API or native DDL is called. Unknown fields,
orphan bindings and retired simulated PG records remain preserved; hidden storage stays hidden.
Missing required bindings block import instead of causing new native instances.

Resume with the same import identity, source and backup command. Conflicting source/target
data aborts. A verified import is never replayed over newer target writes. The importer
preserves these exact files and their contents:

- `workspace.json`
- `workspace.json.providers.json`
- `workspace.json.databases.json`
- `workspace.json.duckdb.json`
- `workspace.json.db9.json`

Additional `--runtime-file` inputs are copied privately in argument order. Keep the backup,
source and matching private runtime configuration; the original JSON source is not deleted.
Reconfigure every old startup entry point so it cannot restart the old writer after cutover.
The updated JSON adapter rejects migrated source markers. Unmodified historical binaries
must remain stopped; a marker cannot change an old executable's behavior.

Start the existing Node API against only Region:

```sh
npm run meta:api -- --source .data/workspace.json \
  --config .data/meta-runtime/node-serving.json \
  --provider-config .data/provider-runtime.json --port 4318
```

Keep provider mode/extension settings identical. The provider configuration accepts only the
existing explicit mode and DuckDB extension settings. Successful responses retain the public
API shape. Metadata unavailability returns a structured failure; `/api/health` declares 503.
The static OpenAPI document remains available. The service never falls back to empty JSON.
Existing owner sessions are still process-local and need renewal after an API restart; stored
Workspace Keys retain their original bytes, grants and real expiry.

## Rollback and manual ownership recovery

Before target writes, stop the target gateway and restore the verified original deployment
with its complete frozen bundle. After any target writes, **do not point back at old JSON**:

```sh
# Stop/drain every target writer first; keep Meta Service available for the export.
npm run meta:export -- --config .data/meta-runtime/node-serving.json \
  --directory .data/rollback-current --target-frozen
```

The export writes all five current documents with owner-only permissions and a final manifest
into a new directory. Verify it, retain both authorities/backups, then explicitly configure
the legacy gateway to use the exported path with the original provider environment. Never run
both writers. The exporter is for the bounded compatibility profile, not production cross-
Region restore or application-data migration.

After a Meta Service crash, stop/fence its old process and inspect its private owner record.
Start the same installation/key/config with `--recover-owner <stopped-owner-id>`. Normal startup
cannot steal a held/uncertain owner through a timeout. A displaced live process rejects both
reads and writes; this is tested, but automatic failure detection/election is not implemented.
Missing/corrupt roots, wrong installation/key and unavailable storage fail closed. Keep
independent copies of bootstrap configuration, identities and encryption roots for recovery.

Node gateway ownership is a separate record from the Rust engine owner. After an unclean
gateway exit, stop every old gateway, inspect its private `legacy-gateway` scope, and set
`recoverGatewayOwner` in the regional serving configuration to that exact stopped owner ID.
A stale recovery setting cannot steal a newer owner. This workflow is entirely regional and
has no Global expiry or heartbeat. `server/meta/gateway-ownership.mjs --config <serving-file>`
prints only the opaque gateway owner for authorized operators. The Rust Workspace profile
uses this same owner/fencing protocol and preserves the existing document format.
Deploy the updated Rust
service before the Node adapter; the adapter requires the gateway-fencing capability.

## Hosted configuration and evidence limits

The binary accepts `--config <owner-only-json> [--initialize]`. Config fields are defined in
`meta-service/src/config.rs`. Configure a distinct `authorityId` (`global` or `region:<id>`),
installation ID, expected environment, S3 endpoint/region/bucket/prefix, token/key file refs
and TLS certificate/private-key/client-CA paths. Omit static S3 credentials to use the SDK's
configured AWS credential chain and a service-scoped workload identity. Buckets are provisioned
externally; first initialization requires an empty root. The server requires TLS 1.3/mTLS
outside explicit local/test loopback. HTTP S3 is separately restricted to explicit loopback
tests; there is no connection-failure downgrade. Clients verify hostname/CA and send authority
and installation identity on every request, with no redirects or Global renewal.

Tests cover same-revision races, atomic data/revision/receipt recovery, replay mismatch,
authority/installation/token negatives, stale-owner read/write rejection, acknowledged WAL
crash recovery without Global, S3 upload blocking before ACK, encrypted credentials, exact
legacy import and updated rollback export, existing Key scope, Node serving without Global,
unavailable-metadata health/static-contract behavior, real mTLS negatives and persistent local
topology restart. This supplies partial evidence for META-01–06/14–17/25/59–65/67–69.
The suite also rejects a second compatibility gateway. A dedicated DuckDB regression checks
that an asynchronous private connection is awaited before native worker execution.

AWS IAM isolation, production KMS/PKI rotation, multi-zone HA, exhaustive fault/GC/backup
closure, typed multi-tenant repositories, strict quota sagas, policy synchronization, full
public regional auth and million-resource benchmarks are not delivered by this slice. The
design's remaining acceptance cases stay open under GH-74. Do not infer production readiness
from a successful local migration or the current bounded service tests.
