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
