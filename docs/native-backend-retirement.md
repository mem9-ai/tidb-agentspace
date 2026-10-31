# Native backend source and local preview

Status: owner-approved retirement, GH-34 (2026-10-30). This completes the source cleanup
following [ADR 0026](decisions/0026-native-hosted-studio.md). Earlier Node acceptance reports
remain historical evidence, not instructions to restore that implementation.

## Source boundary

The product uses the existing TiUI React Console and the native Rust API/Meta/compute roles.
The Node behavioral oracle, local JSON/vault persistence, provider/SQL/browser/analysis/
import/export/SSO implementations and their dedicated tests are removed. The unused Node
runtime packager and Node-only database/shell dependencies are removed as well.

Node remains for Console building, OpenAPI generation, local operator orchestration and
test driving. [Server tooling](../server/README.md) and [contract tooling](../tools/api-contract/README.md)
describe those boundaries. `jose` remains a development dependency only for the signed fake
identity provider in native SSO tests; it is not a product API runtime dependency.

## Verification ownership

| Gate                    | Current responsibility                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`         | Policy, pinned runtime, formatting/lint, generated contracts, Console/tool tests, strict TypeScript and independent Console build       |
| `npm run backend:check` | Rust format/build/Clippy/unit tests, actual native HTTP contracts, isolated real RustFS/S3, SSO, provider recovery and native packaging |

Native integration tests assert expected statuses, values, permissions and persisted records
directly. They do not run a second business implementation to compute the expected answer.
`contract.test.mjs` retains its schema and all-JSON-operation coverage assertions and now
starts the real native executable. Native product scenarios retain binary transfers,
CSV/Parquet parsing, sandboxed SQL/Bash, export/import confirmation and source/destination
permission checks. Workspace tests retain expiry/revocation, cross-Workspace/resource
denials, mTLS/in-process Meta and restart durability. Rust unit tests and native SSO cases
remain required. Fewer Node tests reflect removal of an implementation, not equivalent
line-by-line coverage of every historical Node case.

All automated fixtures use temporary directories and explicit fake providers, never live
credentials. The static Parquet sample removes the need for Node DuckDB in the test harness.
The PR records the exact candidate, actual gate results and any limitations.

## OpenAPI behavior coverage audit

The [GH-58](https://github.com/mem9-ai/tidb.ai/issues/58) audit applies
[OpenAPI verification](standards/openapi-verification.md) to the accepted source baseline
`c2358141bd147ac65fd342d68e007fd8a6be8fa3`. Operation/schema coverage is not a percentage of
behavioral coverage. The following mapping records concrete assertions rather than inferring
completeness from a route being called once.

The evaluated branch also incorporates the independently delivered personal-account isolation
at `7654e103bff16bca50347356fc5f8c8e05093693`. Its native SSO cases exercise two accounts and
a Guest, same-account relogin, legacy Workspace denial, regional continuity without Global
and revoked-cookie replay. They remain part of the full backend gate; see
[ADR 0030](decisions/0030-personal-account-isolation.md). No live retirement operation is
part of this coverage audit.

Identity probe compilation runs once in a bounded preparation hook, outside each case's
unchanged 120-second behavioral deadline. A cold link of several probe executables must not
consume the login/isolation/recovery acceptance budget. Build failure or preparation timeout
still fails the suite; a cached build is not behavioral evidence.

| Area                         | Existing evidence at the baseline                                                                                                                          | Added regression evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication and isolation | Native Workspace/Key tests cover missing/expired/revoked keys, basic resource grants, origin policy, Workspace separation and retained digests.            | [Authorization cases](../server/test-support/product-api-authorization-cases.mjs) exercise 17 protected query/catalog/file/analysis/import/export operations with missing, invalid, expired, revoked, action-denied and resource-denied credentials, asserting zero provider calls. Two actual Workspaces deliberately share resource IDs and file paths. Discovery/usage remain filtered; private DuckDB storage is not a grant target; selected sources independently require read/analyze grants. |
| Database reads and writes    | Native product tests query provider fixtures and inspect catalog metadata; Rust driver/Execute tests cover specific value, connection and engine behavior. | [Database cases](../server/test-support/product-api-cases.mjs) verify MySQL and PostgreSQL INSERT/UPDATE/DELETE/readback, affected rows, empty results, exact decimal/int8/null/boolean/binary values and one external attempt after a lost write response.                                                                                                                                                                                                                                          |
| Files                        | Native product cases save/list local text, transfer upstream bytes and run actual DuckDB/Bash on selected snapshots.                                       | [File cases](../server/test-support/product-api-file-cases.mjs) verify UTF-8 byte sizes, canonical paths, parent/type/directory conflicts, invalid-path rejection before I/O, overwrite/delete outcomes, binary bytes/download headers and create-only conflict preservation.                                                                                                                                                                                                                        |
| Exports                      | Existing cases cover CSV/JSON/JSONL downloads and file/database targets with basic source/destination permissions.                                         | [Export cases](../server/test-support/product-api-export-cases.mjs) assert exact serialized contents, column order, quoting/formula protection, byte counts, immutable existing targets and denial before I/O. A raw JSON numeric value above 2^53 exposed and now guards against CSV integer rounding; Rust tests also cover signed/unsigned 64-bit extrema.                                                                                                                                        |
| Imports                      | Existing CSV/Parquet cases cover review, actor/destination binding, single-use tickets, upload limits, source permissions and SSO logout after CREATE.     | [Import cases](../server/test-support/product-api-import-cases.mjs) add authenticated cross-Workspace ticket rejection, concurrent confirmation with exactly one CREATE/INSERT pair, local/upstream source-version changes, row bounds, reviewed field/type and dialect-safe identifier/value mapping, consumed uncertain writes, recoverable table-name conflicts and Key revocation between CREATE and INSERT.                                                                                     |
| Restart and recovery         | Native Meta/Workspace/Guest/SSO tests cover S3 durability, mutation receipts, writer fencing, retained credentials and Global outage.                      | [Recovery cases](../server/test-support/product-api-cases.mjs) read acknowledged local text, upstream binary bytes and database fixture state back through the actual restarted API. Keys and revocation survive; process-local preparations are unavailable after restart. Abrupt process termination uses explicit recovery of only the stopped writers, with no initialization, replacement resources or credential rotation.                                                                     |

The new cases are registered by `server/rust-product.test.mjs` and run in both remote and
in-process Meta compositions. The [fixture](../server/test-support/product-api-fixture.mjs)
starts actual Rust APIs/Meta against isolated real RustFS roots. The second Workspace uses
an independent API process sharing the same Meta authority; it does not rely on a nonexistent
Workspace ID to demonstrate isolation. The normal `backend:test:integration` command owns
these cases; there is no separate frontend prerequisite or second business implementation.

The database transport fixture intentionally supplies fixed SQL responses and observed
effects. It proves native API authorization, routing, value preservation, generated statements
and no-retry behavior; it is not a MySQL/PostgreSQL wire-protocol implementation or evidence of
live-provider compatibility. Upstream file bytes are held by an isolated fake provider; restart
assertions prove retained bindings and continued access, not that this service owns upstream
storage durability. Existing Rust tests exercise real DuckDB/Bash, while persistent tidbfs
database storage still requires its separately verified extension/provider integration.
The suite does not claim production failover, exhaustive interleavings or every five-minute
preparation-expiry timing boundary. Revisit this mapping when adding a provider or public
operation, changing credential/transaction boundaries, or expanding the supported deployment.

The CSV fix preserves exact JSON integer values during export instead of converting them
through floating point. Public request/response schemas and credential/storage formats are
unchanged. Run the full native gate for backend evidence; a normal `npm test` with native
opt-in cases skipped does not establish these outcomes. The PR owns exact candidate/results.

## Agent API P0 additions

[GH-67](../specs/gh-67/spec.md) and [ADR 0031](decisions/0031-agent-rest-p0.md) add
native HTTP evidence in [agent REST cases](../server/test-support/agent-rest-cases.mjs), in
both remote and in-process Meta compositions. They cover caller-only permission/expiry
discovery, read-only query/catalog grants, rejected writable CTE/session/function escapes
before provider I/O, resource details/deletion grants, synchronous local tombstones,
accepted/unknown external removal, retained private credentials and no replay after graceful
or explicit stopped-writer crash recovery. File cases cover strong metadata ETags, malformed
conditions, missing/stale versions, identical-byte updates, recreation, competing writers and
a provider change between HEAD and conditional PUT. Local comparison/write is transactional;
Drive9 uses provider revision CAS, with the identity-race limitation stated in the spec.
The native PostgreSQL wire fixture additionally asserts read-only transaction and search-path
ordering. This is protocol ordering evidence, not a live PostgreSQL/TiDB service certification.

Existing Keys, native bindings and format-2 storage are reused; no reset or credential
migration is required. Existing `queries:execute` implies the new `queries:read`; new read-only
Keys never gain import/export destination writes. Zero reports deletion unsupported. db9
physical removal completion remains operator reconciliation. Only confirmed deleted resources
leave the default collection; their tombstone remains addressable for authorized inspection.

## Local cutover

Package reviewed clean source with a source SHA and checksums. Publish the independent
Console and native executable from the same revision. Stop the old local product processes
gracefully before replacing their ports; keep native metadata, encryption keys, provider
bindings and ownership coherent. Update the existing private topology's executable reference
without initializing new storage. Follow [local runtime](meta-service.md) for recovery.

Use a single canonical Console entry point with runtime API configuration pointing to Rust.
Verify health, an authenticated read, an unauthenticated denial and the browser after cutover.
Remove obsolete local preview artifacts only after their replacement works. Preserve other
contributors' source and uncommitted edits. This task does not authorize cloud resource,
shared bucket, hosted runtime-configuration or production-data deletion.
