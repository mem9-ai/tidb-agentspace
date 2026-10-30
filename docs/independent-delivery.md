# Independent Console and API delivery

The static React Console builds independently of the Rust API. The native API artifact contains no Node runtime, private state or Console assets. [ADR 0026](decisions/0026-native-hosted-studio.md) retires hosted Node serving and allows deliberately fresh S3 roots and keys. [Native Studio deployment](native-studio-deployment.md) owns public SSO, `/studio`, one-time bootstrap and recurring image delivery.

| Component  | Build                                     | Run                                                                  |
| ---------- | ----------------------------------------- | -------------------------------------------------------------------- |
| Console    | `npm run build:console` → `dist/console/` | Static hosting or `npm run start:console`                            |
| API / Meta | `npm run build:api`                       | `workspace-backend serve --config /absolute/private/deployment.json` |

`npm run check` verifies policy, formatting, lint, generated API/client consistency, isolated oracle/tool tests, types and Console build. `npm run backend:check` builds and verifies native modules, SSO/public policy, real S3, transport, API and native packaging. Both gates are required. No check needs cloud credentials or developer data.

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

The local operator manages the native roles and RustFS. For independent deployment, use a metadata role plan and an API role plan, with private absolute configuration references; see [the Rust guide](rust-backend.md). `WORKSPACE_BACKEND_CONFIG=/absolute/private/api-plan.json npm run start:api:rust` is an optional launcher for the API role. Its metadata dependency must already be available. There is no alternate JSON data source or fallback backend.

## Configuration

| Setting                              | Default                        | Behavior                                                                                                                                                 |
| ------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Console `/config.json` → `apiOrigin` | `http://127.0.0.1:4318`        | Exact HTTP(S) origin; set an empty string for an explicitly configured same-origin gateway. No paths, userinfo, or secrets. Read before Console startup. |
| `WORKSPACE_API_ORIGIN`               | unset                          | Local static runner override for the response at `/config.json`; does not rebuild JavaScript. Generic static hosts serve the edited JSON file.           |
| `WORKSPACE_CONSOLE_PORT`             | `4173`                         | Port of the optional Node static runner. Vite development uses `5173`.                                                                                   |
| `WORKSPACE_CONSOLE_DIRECTORY`        | `dist/console/`                | Optional static runner's content directory.                                                                                                              |
| Native API `bind`                    | Explicit private configuration | Loopback for guest development; an explicitly configured public SSO API may bind `0.0.0.0:4318`.                                                         |
| Native `consoleOrigins`              | Explicit list                  | Exact allowed browser origins; public origins must be HTTPS and explicitly trusted.                                                                      |
| Native `product.providers`           | Local/demo defaults            | Explicit provider modes; private bindings/credentials remain encrypted records.                                                                          |
| `WORKSPACE_BACKEND_CONFIG`           | Required by npm launcher       | Absolute owner-only native role plan, with external metadata and credential configuration.                                                               |

Provider setup and native tidbfs requirements are in [the Rust guide](rust-backend.md). Node data-file, provider-vault and environment flags are not product configuration.

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

Customer isolation and direct multi-region public API discovery remain proposed in [the regional API/auth design](../specs/gh-74/regional-api-auth.md). The current public contract has one configured origin. Separate internal Meta authorities do not implement production global policy distribution by themselves.

## Contract and packaging

`server/generate-openapi.mjs` owns the public contract; `npm run api:generate` regenerates OpenAPI and Console types, and `npm run api:check` rejects drift. Console and agent requests share the selected runtime's domain operations. Internal record protocol changes do not require changing the public contract when the observed product API remains the same.

After building both components from reviewed clean source, run:

```sh
npm run build
npm run package -- FULL_REVIEWED_SOURCE_SHA
```

The package contains a platform-specific native API archive, a separate `workspace-console.tar.gz`, source/build metadata and SHA-256 sums. The native API requires neither Node nor frontend dependencies; its common executable can host API, Meta and isolated compute roles. Private configuration, service tokens, encryption keys, user files and provider credentials stay outside every artifact. The optional native tidbfs extension is supplied separately with its verified checksum.

The release workflow packages reviewed main-branch source; it does not deploy. Public hosting still requires a configured target, real identity, environment protection, verification and recovery under [CI/CD policy](ci-cd.md). A source rollback cannot make a different metadata layout readable. The authorized disposable local reset is not a general production migration strategy.

## Verification

Tests cover separate Console/API origins, authentication, scoped Keys, cross-Workspace and cross-resource denials, files, database protocols, analysis and exports. Native/S3 integration verifies both in-process and remote Meta, fresh initialization, durable restart and authority/writer isolation. Native artifact validation runs selected-file computation with no Node executable in PATH.

## Artifacts, promotion, and rollback

After both gates, `npm run package -- FULL_REVIEWED_SOURCE_SHA` packages the native executable and independent Console with source identity/checksums. The API archive contains the executable, Cargo lockfile, OpenAPI, build metadata and instructions. No Node runtime/dependencies or private configuration/state are included. The Console archive contains only static files and an optional local static runner.

Use the native private configuration/S3 root for each deployment; keep it outside artifacts. A failed native image update can restore a compatible prior native digest while preserving records. The one-time switch from Node requires a deliberately new native configuration/storage pair and full Pod-template recovery; an old Node image cannot read native records. Follow [native cutover](native-studio-deployment.md) and [CI/CD policy](ci-cd.md). Packaging alone does not prove deployment.

## Browser verification

The split delivery is checked with the built Console on a different origin/port from a fresh,
fixture-backed API. Verification covers startup/session, reads, scoped key creation/revocation,
API explorer and generated URLs, a local file write, and keyboard navigation. Desktop light
and dark at 1280px and narrow layout at 390px are inspected. Screenshots and observed results
are recorded with the PR; the UI components remain TiUI 2.9.1 with the existing shared overrides.

Observed on 2026-10-28 using the production Console build and standalone API build, a fresh
local store, Console port 4273 and API port 4418. `npm ci` and `npm run check` passed with 58
tests. No cloud credentials or real resource provisioning were used. Browser warning/error
logs were empty during the checked flows. Existing build warnings remain for bundle size
and UIKit's transitive phone-number parser; no checks or warnings were suppressed.

| Flow                    | Observed result                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Startup and reload      | Configuration loads before session creation; resources render across origins; the route and Light/Dark choice survive reload. |
| SQL                     | `SELECT 1 AS connected` returns one row through the configured API.                                                           |
| Files                   | Create `split-api.txt`, edit and save 48 bytes; the listing and stored size update.                                           |
| Keys                    | Create a seven-day key restricted to `shared-files`, close reveal, then revoke successfully.                                  |
| API explorer            | Resource requests return 200 on desktop and narrow layouts. Schema links and cURL examples use port 4418.                     |
| Agent instructions      | Downloaded instructions include the configured API and OpenAPI origins.                                                       |
| Settings                | Save workspace description through the generated client.                                                                      |
| Navigation and keyboard | Narrow navigation reaches API explorer; search opens and Escape dismisses it.                                                 |
| Layout                  | 1280×900 Light/Dark and 390×844 Dark inspected; narrow document width is 390px, with no page-wide horizontal overflow.        |

![Light desktop Console, 1280×900](images/independent-console-light.jpg)

![Dark desktop API explorer, 1280×900](images/independent-console-dark.jpg)

![Narrow API explorer, 390px viewport](images/independent-console-narrow.jpg)

## Hosting below a path

The Console can be built with `npm run build:console -- --base=/studio/`.
It loads `config.json` relative to the Vite base. Set that file to
`{"apiOrigin":"","apiPathPrefix":"/studio"}` for a same-origin gateway.
`apiOrigin` remains an exact origin; the optional `apiPathPrefix` is empty by
default, or an absolute path made of alphanumeric, underscore and hyphen
segments, without a trailing slash. All API calls, schema links and generated
instructions use the resulting base URL.

Set `WORKSPACE_PUBLIC_PATH=/studio` on the API. A gateway forwards
`/studio/api/*` to `/api/*` and `/studio/openapi.json` to `/openapi.json`,
without changing methods, request bodies or authentication headers. The API
still serves no Console assets. Keep API rules before any static SPA fallback;
API errors must never become successful HTML responses.

For SSO, register `https://console.example.com/studio/api/auth/tidbcloud/callback`.
The flow cookie uses `/studio/api/auth/tidbcloud`; session creation and logout
use `/studio/`. Thedefault post-login URL becomes `/studio/`, and explicit
post-login URLs must remain inside that prefix on the callback origin. Public
origin/proxy trust and authorization settings remain independently required.
This is path mounting, not a tenant/security isolation boundary between apps
sharing one browser origin. Default root hosting is unchanged.

See [ADR 0013](decisions/0013-console-path-mount.md) for the deployment boundary.
