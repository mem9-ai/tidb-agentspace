# Modular Rust backend: first migration slice

- Direction: [ADR 0020](decisions/0020-modular-rust-backend.md), [GH-88 specification](../specs/gh-88/spec.md).
- Implemented slice: GH-90, following the accepted specification at
  `b90b68a0d3b437413c11845cdb1ba73af357b99f`.
- Runtime: Rust **1.99.1**, one root Cargo workspace and committed root `Cargo.lock`.
- Status: Real Workspace/Key business logic and composable metadata services. The full
  provider/data/analysis API is still on Node; the active Portal is not cut over to this partial profile.

## Modules and dependency direction

| Crate/source          | Implemented responsibility                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `backend/contracts`   | Metadata port, scoped request/context and structured error types; no HTTP/storage dependency                                        |
| `meta-service`        | Existing independent encrypted SlateDB/S3 engine, local port and mTLS HTTP server, now a library plus compatible thin binary        |
| `backend/meta-client` | Remote Meta port with authority/installation checks, TLS 1.3/mTLS, no proxy/redirect/automatic retry and bounded responses/timeouts |
| `backend/workspace`   | Workspace read/settings, Key issue/list/revoke/auth and filtered events; guarded legacy repository behind the metadata port         |
| `backend/api`         | Explicit loopback migration profile, HTTP methods, local-demo sessions, Host/Origin/CORS and admission/body limits                  |
| `backend/host`        | Private deployment plan, real role composition, dependency wiring and ordered shutdown; common `workspace-backend` executable       |

The domain crate does not depend on Axum, HTTP clients, SlateDB or S3. It uses the same
metadata port for embedded and remote execution. Neither mode forwards an operation to Node.
The workspace engine is still the bounded compatibility document profile from GH-86, not
the future typed multi-tenant repositories or million-resource collection/index profile.

## Build and verify

```sh
cargo build --workspace --locked
cargo build --release --locked -p workspace-backend
npm run backend:check
npm run check
```

`.cargo/config.toml` keeps build outputs under `meta-service/target/`, preserving existing
metadata launch/test paths. The common debug executable is
`meta-service/target/debug/workspace-backend`; the release executable is in the corresponding
`release/` directory. The original `workspace-meta-service --config ...` launcher remains
compatible and delegates to the shared library. Building/running either Rust executable
does not require Node or the Console; npm commands are optional shared test/build tooling.

`backend:check` runs workspace build, Rust formatting/Clippy/tests and eight real isolated
RustFS/S3 integration cases. Existing metadata tests retain ACK/WAL, crash, fencing, encryption,
mTLS and persistent local-bootstrap coverage. New tests run the same Workspace/Key requests
against Node and both Rust modes, including a remote mTLS deployment, original Key validity,
scope/expiry/revocation, Host/Origin/preflight, unknown fields, source/vault preservation,
Node/Rust ownership exclusion, explicit stale-owner fencing and language handoff in both
directions. They also reject overlapping storage/duplicate authorities before opening writers
and verify that a failed Global role does not stop a healthy regional role or seed a root.

CI runs `backend:check` without cloud credentials using pinned Rust/RustFS. Ordinary `npm test`
explicitly skips the four metadata and four Rust backend S3 integration cases; those skips
are not integration evidence. Shared quality and backend checks are both required.

## One executable, different deployment plans

Run the same executable with a private deployment file:

```sh
workspace-backend serve --config deployment.json
```

All configuration and private material use owner-only ordinary files. Deployment role
references are absolute paths, avoiding a working-directory-dependent choice of authority.
The following paths are illustrative deployment locations, not checked-in runtime data.

For one process containing Global Meta, regional Meta and the regional Workspace module:

```json
{
  "format": 1,
  "services": [
    { "kind": "metadata", "configFile": "/srv/workspace/config/global-meta.json" },
    { "kind": "metadata", "configFile": "/srv/workspace/config/region-meta.json" },
    { "kind": "workspace", "configFile": "/srv/workspace/config/region-workspace.json" }
  ]
}
```

For independently deployed services, give each process a single-role plan. The Global
process receives only its Global metadata configuration. The Region Meta process receives
only its regional metadata configuration. The Workspace process uses a remote regional port.
Multiple regions follow the same pattern with separate identities, objects, keys and endpoints.
Global control, provider/data and execution-worker roles are not implemented by this slice;
unknown role names/configuration fields reject rather than starting a placeholder service.

Metadata role configuration uses the existing [Meta Service fields](meta-service.md#hosted-configuration-and-evidence-limits).
`initialize` defaults to false. Set it true only for deliberate initialization of an empty
new root; never use it to repair missing expected metadata. `recoverOwner` is an optional
explicit stopped engine-owner identity, using the same recovery protocol as the thin binary.
The host rejects duplicate authorities, installations, key/token material, listener addresses
and overlapping object roots before starting roles. Operators still own actual IAM/DNS/storage
alias isolation; comparing configuration does not prove that two endpoints are different stores.

An embedded regional Workspace configuration is:

```json
{
  "bind": "127.0.0.1:4320",
  "workspaceId": "ws_agentlab",
  "authorityId": "region:local-compat",
  "importId": "the-verified-import-id",
  "insecureLoopback": true,
  "consoleOrigins": ["http://127.0.0.1:5173"],
  "metadata": {
    "transport": "inProcess",
    "authorityId": "region:local-compat"
  }
}
```

For a separate Workspace process, replace `metadata` with:

```json
{
  "transport": "remote",
  "client": {
    "origin": "https://region-meta.example.internal:7443",
    "authorityId": "region:local-compat",
    "installationId": "the-regional-installation-id",
    "tokenFile": "/srv/workspace/secrets/meta-token",
    "tls": {
      "caFile": "/srv/workspace/pki/ca.crt",
      "certificateFile": "/srv/workspace/pki/client.crt",
      "privateKeyFile": "/srv/workspace/secrets/client.key"
    }
  }
}
```

Remote metadata requires TLS 1.3/mTLS; explicit HTTP loopback test clients may use
`insecureLoopback: true`. The Workspace HTTP profile itself currently requires explicit IPv4
loopback and `insecureLoopback: true`; production identity/public hosting is not supplied by
this slice. It has no Global endpoint/client or token-renewal path. A remote commit failure
can be unknown: neither transport retries it or replays a business callback.

## Supported profile and compatibility

| Method    | Route                                      | Authorization                                                                                        |
| --------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| GET       | `/api/health`                              | Local health; verifies current regional metadata and reports `migrationProfile: workspace-keys-only` |
| POST      | `/api/session`                             | Local demo session, eight-hour HttpOnly/SameSite cookie; not production login                        |
| GET       | `/api/v1/workspaces`                       | Owner or Workspace Key with `resources:read`                                                         |
| GET       | `/api/v1/workspaces/ws_agentlab`           | Owner or Workspace Key with `resources:read`                                                         |
| PATCH     | `/api/v1/workspaces/ws_agentlab/settings`  | Owner only                                                                                           |
| GET, POST | `/api/v1/workspaces/ws_agentlab/keys`      | Owner only; Key creation persists a digest and returns its secret once                               |
| DELETE    | `/api/v1/workspaces/ws_agentlab/keys/{id}` | Owner only; durable revocation                                                                       |
| GET       | `/api/v1/workspaces/ws_agentlab/events`    | Owner or read-scoped Key; resource grants and hidden/retired resource rules apply                    |

Other routes return structured 404 and are outside this profile's advertised surface. This
profile does not serve the full OpenAPI document or claim full API/provider compatibility.
Existing Node API/generator/client contracts remain the active product baseline. The same
successful Workspace/Key response shapes and stable error codes are compared in integration
tests. Invalid/non-object JSON and incorrect content type fail with the existing API codes.
Name limits follow JavaScript UTF-16 length and trimming semantics. Corrupt/missing Key expiry
and malformed non-null revocation state fail closed; invalid metadata is not repaired to
grant access. Rust accepts valid Unicode JSON; an unsupported legacy encoding fails preflight
without overwriting its source. It never intentionally generates a broken surrogate at a
description truncation boundary.

The HTTP profile admits eight requests, bounds bodies to 1 MiB/10 seconds and retains at
most 4096 unexpired demo sessions. Provider credentials and native storage never enter its
public responses. Metadata transaction completion remains serialized/durable after a caller
disconnects. Key last-use writes retain the compatibility behavior; scalable telemetry and
typed authorization are separate GH-74 work.

## Handoff, recovery and limits

Use isolated generated fixtures for development. Do not point a partial profile at the
active Portal's metadata or start a second writer against live roots. The integration suite
creates private temporary imports with native credential fixtures and cleans them up.

The Rust repository checks the verified regional import, then acquires the same
`legacy-gateway` record as Node. A second Node or Rust writer rejects. Every document call
carries its owner and is checked inside the metadata transaction boundary. Recovery uses
optional `recoverGatewayOwner` with the exact stopped gateway identity; there is no lease
timeout or Global renewal. A displaced process rejects reads and writes and cannot release
the newer owner's guard. An uncertain claim/release needs explicit regional reconciliation.

Workspace updates preserve the existing document's resources/files/opaque fields. All four
native vault documents remain untouched by this slice. Shutdown drains the Workspace HTTP
service and releases its gateway before stopping metadata listeners/engines. A failed role
reports its own failure and leaves healthy roles running. Monitor each configured endpoint;
this host is not an automatic HA supervisor or a distributed health registry.

Embedded roles share a process/host failure domain. Deploy Global and Regions in separate
processes/hosts for regional outage independence. Global never initiates a second regional
SlateDB writer. Customer analysis still requires isolated worker processes/containers when
migrated later, even when distributed from the same binary.

Before eventual live cutover, apply the complete [migration/rollback guide](meta-service.md):
drain old writers, preserve verified private backups and provider runtime settings, and
export current state rather than restoring stale JSON after target writes. Full provider
lifecycle/data/analysis/export parity, typed Global/regional policy, public identity, automatic
HA and million-resource sharding remain tracked under GH-88/GH-74. Stage A is not that endpoint.
