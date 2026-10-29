# ADR 0025: Consolidate hosted and native runtime profiles

- Status: Accepted integration direction for the owner-requested repository merge; verified behavior is recorded in PR evidence.
- Date: 2026-10-30.
- Inputs: hosted Studio `713d63547d24883cc2376542600cc9e8de21448b` and refreshed siddontang main `141652e501c942128ccae617d088a2cdccf9f780`.
- Tracking: [MRG-01–06](https://github.com/mem9-ai/tidb.ai/issues/11).

## Decision

Consolidate both histories without turning a source merge into a destructive runtime cutover.
The existing hosted Node API keeps TiDB Account code + S256 PKCE, exact issuer verification,
verified subject/email grants, public gateway policy, JSON/vault persistence, and the installed
Node image/CD contract. It also serves the newer shared export/import and file operations.
The shared Console retains the newer resource workspaces and upload/import behavior together
with sign-in and `/studio` API path prefixes. All request paths, including binary uploads,
must use the configured base URL.

The native Rust API, independent Global/Region SlateDB services, private versioned records,
pinned static DuckDB, process isolation, local supervisor, and native checks remain intact.
It is an explicitly selected loopback development profile, with no business-operation
forwarding to Node. Node remains its regression oracle as well as the separate hosted runtime.
This integration amends the blanket Node-retirement claim in ADRs 0020/0024 only for the
already installed hosted profile; it does not restore the retired document import/handoff bridge.

| Command                                                    | Profile                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| `npm start`, `npm run start:api`, `npm run build:api`      | Hosted-compatible Node API and its independent `dist/api` runtime closure |
| `npm run dev:api:node`                                     | Local Node API with the hosted configuration contract                     |
| `npm run dev`, `npm run dev:api`, `npm run start:api:rust` | Explicit Rust launcher; private `WORKSPACE_BACKEND_CONFIG` required       |
| `npm run backend:build`, `npm run build:api:rust`          | Native Rust workspace                                                     |
| `npm run package -- SOURCE_SHA`                            | Reviewed native API and separate static Console artifacts                 |

## Storage and rollout boundary

Existing `/data` JSON/vault files stay on the installed persistent volume; image-only dev CD
must not initialize an empty SlateDB root, delete credentials, or reinterpret those files.
Native fresh-local initialization is deliberate, local and separate. Do not point either
profile at the other's storage or claim lossless migration between them. A public Rust
cutover still requires native SSO/host policy, an accepted credential/metadata migration,
configured storage and health/rollback evidence. These requirements are not satisfied by
merging the native sources or by the anonymous native parity tests.

Keep the destination repository's removed commit-trailer enforcement removed. Preserve
existing attribution and original commits; an agent acting for an owner still follows that
owner's personal sign-off preference. Existing main-only Console publication and Node dev CD
remain enabled with their existing protected credential boundaries.

## Verification

Run `npm run check` for the merged Node/Console contract and `npm run backend:check` for all
native phases and isolated RustFS/S3 cases. Run hosted container PR verification and review
the exact candidate. Packaging must boot independently with its runtime dependency closure
and no Console, test fixtures or private state. Add an authenticated SSO-to-import regression
and retain the issuer/PKCE/authorization/session tests. Inspect the merged Console in both
themes at 1280 and 390 pixels. Verify both input heads remain ancestors of the final main.
