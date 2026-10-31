# ADR 0020: Modular Rust backend with composable deployment

- Status: Accepted direction, implementation in stages under [GH-88](https://github.com/siddontang/tidb.ai/issues/88).
- Decision date: 2026-10-29.
- Source baseline: `7cf93b148c2f2830f1063ec6f24affb60c0f4416`.
- Supersedes: Keeping Node ESM as the long-term business backend. ADR 0019's authority,
  durability, credential and migration invariants remain in force.

## Context

The owner selected Rust for all backend business and infrastructure services, with explicit
module boundaries and two deployment forms: one executable hosting multiple modules, or the
same executable starting independently deployed service roles. The first SlateDB service is
already Rust; existing Node business APIs remain the compatibility baseline during migration.
Choosing microservice boundaries must not make local deployment require an orchestration stack.

## Decision

Use one Cargo workspace and one implementation per domain capability. Separate domain crates,
application services, repository/provider ports, transport adapters and the executable
composition root. Domain code does not depend on Axum, socket addresses or service discovery.
Ports support in-process adapters and authenticated remote adapters. Both preserve the same
authorization, consistency, error, idempotency and unknown-outcome contract. In-process calls
still enforce authority and permissions; remote calls do not retry uncertain writes.

The target module boundaries are:

| Module           | Responsibility and authority                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| Contracts        | Versioned request/context/result/error types; no storage or business implementation                        |
| Global control   | Identity/policy, placement, account/product limits, regional directory and Global-initiated dispatch/read  |
| Regional control | Installed policy, resource lifecycle/claims, regional Workspace/Key operations and durable execution state |
| Regional data    | Authorized database/file operations and provider adapters; direct regional entry points                    |
| Metadata         | Independent Global or regional SlateDB/S3 authority; scoped commits, encryption, durability and fencing    |
| Regional Execute | Internal task execution; same-binary child lifecycle and selected-file credential boundaries               |
| API/transport    | HTTP/agent adapters, local-demo sessions and transport policy; calls shared application services           |
| Runtime host     | Configuration, dependency wiring, listeners, service lifecycle and role selection                          |

Modules are logical capabilities, not a requirement for one process per table or provider.
Start with regional Workspace/Key domain extraction and the existing metadata engine. Then
migrate lifecycle/providers, database and file operations, exports and isolated analysis.
Do not add empty service implementations or proxy Node calls and call that Rust parity.

Distribute `workspace-backend` as the common executable. Its private deployment configuration
selects enabled roles and local or remote dependencies. A one-role configuration starts an
independent service; a multi-role configuration composes real modules in one process. Exact
CLI/configuration fields are versioned with the corresponding implementation slice. Separate
thin binaries may be retained as compatibility launchers over the same libraries.

The Region calls its internal Execute module directly; this module has no independently
deployed service, listener or task queue. Its default strategy execs the same binary for one
bounded task. Native engine crashes, memory/CPU/time limits and filesystem isolation retain
the child-process boundary even in an all-in-one deployment. See
[ADR 0021](0021-native-rust-computation.md) for the implementation and compatibility aliases.
Do not replace the restricted Bash interpreter with unrestricted host shell execution.

## Isolation and failure behavior

Each Global/Region metadata authority keeps its own engine instance, installation, bucket or
non-overlapping root, encryption material, identity, WAL/catalog and writer ownership, even
when co-located. No shared SlateDB with authority prefixes substitutes for separate engines.
Reject ambiguous/duplicate authority or storage bindings before initializing any deployment.
Global never directly opens regional metadata as another writer or bypasses regional policy.

Global initiates control traffic and information reads. Region does not acquire an upstream
client, callback, renewal or startup dependency merely because the host can embed Global.
Distributed control traffic requires TLS 1.3/mTLS; explicit loopback test relaxation remains.
Client requests and service identity are separate credentials, and each service reauthorizes
tenant/resource operations after transport authentication.

One process shares a crash, memory and OS failure domain. Role task failure must not
deliberately stop healthy roles, but it cannot provide process/host/region independence.
Use separate regional processes/hosts for the production Global-outage requirement. An
all-in-one topology is suitable for development or an explicitly accepted common failure
domain; its existence does not weaken the distributed regional-autonomy contract.

## Migration and consequences

Follow the [migration specification](../../specs/gh-88/spec.md). Node is transitional only;
new backend domains use Rust. Existing ESM receives scoped compatibility/security fixes until
its replacement passes parity. The Console remains independently delivered TypeScript/React.
Node build/contract/test tooling can remain after Node is removed from the serving path.

Preserve public API success/error shapes, resource/native IDs, region placement, Key
digests/grants/expiry/revocation, opaque fields, upstream credentials, private DuckDB edges,
pending-operation recovery and current metadata durability. Do not rewrite existing
documents into a new typed schema as an incidental language change. Preserve full private
backups; use current-state export after target writes. Never recreate providers to migrate.

The legacy document adapter is single-active across Node and Rust. A Rust process must use
the same regional gateway ownership record and fencing contract before accessing documents.
Mixed-language differential checks use isolated copied fixtures, not concurrent production
writers. Cut over a live entry point only after every advertised capability has parity;
partial Rust profiles must remain explicitly partial and cannot replace the working Portal.

## Verification and revisit

Each slice requires Rust format/Clippy/tests, `npm run check`, shared behavioral fixtures and
real S3 persistence/restart evidence when metadata is touched. Compare in-process and remote
ports with the same domain cases. Verify duplicate writers, stale owners, cross-authority
access, Key expiry/revocation, hidden resources and unknown writes fail safely. CI runs without
cloud credentials. The parent intent stays open until complete serving parity and both
deployment modes are verified. Revisit module extraction when a concrete scaling, isolation,
provider capability or ownership requirement changes the boundary.
