# GH-88: Rust backend migration and deployment composition

- Parent: [GH-88](https://github.com/siddontang/tidb.ai/issues/88); related metadata intent: GH-74.
- Status: Owner-selected architecture; implementation in staged, independently evaluated slices.
- Baseline: `7cf93b148c2f2830f1063ec6f24affb60c0f4416`, including independent SlateDB service GH-87.
- Decision: [ADR 0020](../../docs/decisions/0020-modular-rust-backend.md).
- Contributor/maintainer: Siddon Tang; implementation follows the repository's current local-agent workflow.
- Risk: Credential, authorization, persistence, deployment and lifecycle migration; current prototype merge policy applies, with no production deployment authorization.

## Intended outcome

Operate the backend entirely in Rust, using real domain modules that can be embedded in a
single executable or independently hosted as services. Deployment mode changes wiring, not
business behavior or tenant/storage authority. Keep the Console separate and maintain every
existing supported capability and resource during incremental replacement.

## Work packages

| Stage | Complete slice and required evidence                                                                                                                                                                |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Cargo workspace; reusable metadata engine/server; common executable; first Workspace/Key application module; in-process and remote Meta ports; compatible legacy document ownership and persistence |
| B     | Regional resource lifecycle, distributed claims/recovery and provider adapters; preserve anonymous provider identity and uncertain-create reconciliation                                            |
| C     | Database query/catalog and File System operations, scoped file sources and transfers; native credential and hidden-storage parity                                                                   |
| D     | Preview, exports, imports and isolated analysis workers; preserve selected snapshots, read/analyze distinctions, path/result identity and bounds                                                    |
| E     | Complete public API parity, startup/package migration and controlled local cutover; no Node process on the backend serving path                                                                     |
| F     | Full typed Global/regional domains from GH-74, separate public routes/policy delivery and scale/HA evidence; tracked separately from language parity                                                |

Stage A does not claim that a partial Rust API can replace the existing Portal. Do not
silently forward unsupported Rust operations to Node. Keep the active Node entry point until
the complete capability set it advertises has passed the applicable parity/cutover gate.
Independent tasks may refine a stage, but must reference this immutable accepted revision.

## Module and dependency contract

Keep contracts independent of business/storage/HTTP crates. Application services depend on
repository/provider ports. A local metadata adapter and an authenticated remote adapter
implement the same port. The executable owns composition, lifecycle and transport exposure.
No domain operation reads a sibling module's private keys or storage to avoid an RPC.

Global and regional service ownership follows ADR 0019/GH-74. The first regional compatibility
module supports only the existing `ws_agentlab`, preserving its imported document and Key
semantics. This explicit limit is not a multi-tenant identity implementation. Global and
regional methods cannot share a default fallback store. Public data requests target Region
without Global introspection/renewal on the request path.

One multi-role executable must open distinct Meta instances and roots per authority. Remote
service connections authenticate endpoint, authority and installation, disallow redirects,
use TLS 1.3/mTLS outside explicit loopback tests and bound request/response/time budgets.
Local calls enforce the same scope and gateway ownership checks. An ambiguous write has an
unknown outcome; neither adapter reruns a business callback or provider side effect.

Production regions deploy separately to achieve outage independence. In one process,
ordinary failed-role handling keeps healthy roles alive, while a process abort affects every
embedded role. Untrusted analysis uses worker isolation regardless of packaging mode.

## Observable compatibility contract

Use the checked-in generated OpenAPI and current Node tests as the behavior baseline, with
explicit negative cases where the old implementation is weaker than accepted security rules.
During Stage A, implement the existing Workspace reads, local-demo session boundary,
Workspace settings and Workspace Key lifecycle/authentication as a partial local profile.
Supported methods retain request/response shapes and stable error codes. A partial profile
documents its exact route list, fails unsupported calls and does not advertise production
identity, complete API parity, provider support or multi-tenancy.

Workspace Key authentication reads current durable regional state; honor received revocation,
original expiry, action grants and resource grants. Keys cannot list/manage other Keys or
change settings. Local owner sessions are loopback demo state with the existing eight-hour
lifetime, never an internal service-token shortcut or production login. Validate Host/Origin
and do not reflect arbitrary CORS origins. Cross-Workspace requests fail before private data
or provider I/O. Key listing omits digests; creation returns a secret once and persists only
its digest. Resource grants exclude retired simulated PG and internal DuckDB storage.

Operate on the existing encrypted document profile initially. Preserve unknown fields,
file contents, four provider vaults, native connections and in-flight recovery records.
Before opening legacy documents, acquire the same regional gateway guard used by Node.
Second writers fail; recovery requires explicit stopped-owner identity. Clean shutdown drains
business requests, releases the gateway and then closes the metadata engine. Startup failure
after a claim releases it when safe; uncertain claims require operator reconciliation.

## Acceptance baseline

| ID      | Observable requirement and evidence                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RUST-01 | Reproducible pinned Cargo workspace and one shared domain implementation; Rust format/Clippy/tests and existing repository gate pass                                     |
| RUST-02 | One executable starts real co-located roles; single-role configurations start independent processes; isolated real S3 integration checks both                            |
| RUST-03 | Identical Workspace/Key domain cases pass against in-process and remote metadata, including settings changes, Key issue/use/expiry/revoke, restart and failure           |
| RUST-04 | Distinct Global/Region engines/roots/keys; duplicate identities or overlapping roots reject before initialization; authority-negative tests remain                       |
| RUST-05 | Region serves/restarts with Global stopped and has no mandatory upstream client; co-location's shared process failure is documented                                      |
| RUST-06 | Original Key digest/grants/expiry and all resource IDs/files/opaque fields/native vault documents survive a language handoff without upstream create/rotation            |
| RUST-07 | Node and Rust cannot concurrently own compatibility documents; stale writers fail; clean restart and explicit recovery are tested                                        |
| RUST-08 | Cross-Workspace/scope/resource access, expired/revoked Keys and untrusted origins fail before private/provider access; Key secrets/digests do not leak                   |
| RUST-09 | Full provider lifecycle/query/file/browser/analysis/export/import parity covers existing shared fixtures and each provider's recovery/credential boundary before cutover |
| RUST-10 | HTTP/agent contracts and independent Console/API artifacts remain aligned; final serving artifact does not spawn/depend on Node for business operations                  |
| RUST-11 | Both deployment forms drain/close in dependency order; a failed role does not intentionally tear down healthy roles; rejected/unknown writes are not retried             |
| RUST-12 | Live cutover uses complete verified private backups/current-state rollback, preserves provider settings and IDs, and verifies every advertised supported operation       |

RUST-01–08/11 have partial evidence in Stage A; RUST-09/10/12 remain open until later stages.
Record candidate/spec/base revisions, actual commands, fixture results and remaining gaps in
each implementation PR. Passing a partial profile does not close this parent intent.

## Execution and delivery

Use focused branches, local fixtures and real isolated RustFS/S3 integration; reuse the
installed RustFS version. Production services, billable provider changes and destructive
native migrations are outside this authorization. Do not disturb the running Portal or
private migrated state while testing a partial Rust profile. No additional model/execution
dispatcher is required. Follow the current reviewed, signed, latest-head-green PR workflow.

## Stage A implementation status

GH-90 provides the Cargo workspace, reusable metadata library, composable host, Workspace/Key
domain and loopback HTTP profile, with local/remote Meta ports. See the
[runtime guide](../../docs/rust-backend.md) for implemented routes, behavioral evidence,
encoding/admission limits and remaining migration work. RUST-01–08/11 have partial evidence
from the isolated integration suite; RUST-09/10/12 and the parent intent remain open.
