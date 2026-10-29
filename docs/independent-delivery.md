# Independent Console and Rust API delivery

The Console and business API build, run and package independently. The Console is static React; the API is a native Rust executable. Optional Node launchers, regression oracles and local RustFS supervision are tooling. No Node business backend or JSON migration/rollback API is packaged.

| Component       | Build                                     | Run                                                                  |
| --------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| Console         | `npm run build:console` → `dist/console/` | Static hosting or `npm run start:console`                            |
| Rust API / Meta | `npm run build:api`                       | `workspace-backend serve --config /absolute/private/deployment.json` |

Use the pinned Node/npm versions for Console and tooling and the pinned Cargo workspace for the native backend. `npm run check` verifies repository policy, formatting, lint, generated API/client consistency, isolated behavior tests, types and the Console production build. `npm run backend:check` separately builds and verifies Rust plus real S3, transport, native artifact and full API integration cases. Neither suite uses developer data or cloud credentials.

## Configuration and startup

Follow [Meta bootstrap](meta-service.md) for a new local deployment. It creates independent Global/Region Meta roots and an empty Workspace. Fresh installation format 2 rejects old document roots; [ADR 0024](decisions/0024-fresh-record-metadata.md) records the explicit local reset boundary. No cloud resources are created automatically.

```sh
npm run backend:build
npm run meta:local -- init --directory .data/meta-runtime --api-port 4318
npm run meta:local -- serve --directory .data/meta-runtime
```

In a separate terminal:

```sh
npm run dev:console
```

The local operator manages the native roles and RustFS. For independent deployment, use a metadata role plan and an API role plan, with private absolute configuration references; see [the Rust guide](rust-backend.md). `WORKSPACE_BACKEND_CONFIG=/absolute/private/api-plan.json npm run start:api` is an optional launcher for the API role. Its metadata dependency must already be available. There is no alternate JSON data source or fallback backend.

The Console loads `/config.json` before creating its API client. `apiOrigin` selects the regional API without rebuilding JavaScript; an empty string uses the page origin. For the optional local static runner, set `WORKSPACE_API_ORIGIN` and `WORKSPACE_CONSOLE_PORT`. Console origins must be allowlisted in private API configuration. Credentialed CORS, Host/Origin restrictions, HttpOnly local owner sessions and backend action/resource authorization remain required.

Use the same hostname for Console and API (`127.0.0.1` for both, or `localhost` for both).
They can use different ports. The HttpOnly SameSite=Strict cookie is not shared between
`localhost` and `127.0.0.1`; cross-site cookie authentication is not implemented. Every browser
API request includes credentials; CORS does not grant API permissions. Unknown origins are
rejected before session creation or provider access. Non-browser agents use Workspace Keys
without relying on CORS or Console sessions.

For a separate browser-verification API, keep its Console/API hostname pair distinct from
the active user preview (for example, use `localhost` for verification and `127.0.0.1` for the
user preview). Different ports on the same hostname do not isolate local owner session
cookies between independent API processes. Preserve the active serving process and confirm
the user's actual tab, URL and authenticated read after a preview update; another working
directory or an already loaded tab can still serve an older Console build.

Production identity and direct multi-region public API discovery remain proposed in [the regional API/auth design](../specs/gh-74/regional-api-auth.md). The current public contract has one configured origin. Separate internal Meta authorities do not implement production global policy distribution by themselves.

## Contract and packaging

`server/generate-openapi.mjs` owns the public contract; `npm run api:generate` regenerates OpenAPI and Console types, and `npm run api:check` rejects drift. Console and agent requests share the Rust domain operations. Internal record protocol changes do not require changing the public contract when the observed product API remains the same.

After building both components from reviewed clean source, run:

```sh
npm run build
npm run package -- FULL_REVIEWED_SOURCE_SHA
```

The package contains a platform-specific native API archive, a separate `workspace-console.tar.gz`, source/build metadata and SHA-256 sums. The native API requires neither Node nor frontend dependencies; its common executable can host API, Meta and isolated compute roles. Private configuration, service tokens, encryption keys, user files and provider credentials stay outside every artifact. The optional native tidbfs extension is supplied separately with its verified checksum.

The release workflow packages reviewed main-branch source; it does not deploy. Public hosting still requires a configured target, real identity, environment protection, verification and recovery under [CI/CD policy](ci-cd.md). A source rollback cannot make a different metadata layout readable. The authorized disposable local reset is not a general production migration strategy.

## Verification

Tests cover separate Console/API origins, authentication, scoped Keys, cross-Workspace and cross-resource denials, files, database protocols, analysis and exports. Native/S3 integration verifies both in-process and remote Meta, fresh initialization, durable restart and authority/writer isolation. Native artifact validation runs selected-file computation with no Node executable in PATH.

For visible frontend changes, use the [TiUI standard](standards/tiui-design-system.md), inspect desktop and narrow layouts and retain screenshots. For a backend cutover, verify the existing Portal against the selected API origin and record the actual source/artifact identity. Do not overwrite unrelated Console edits while updating backend roles.
