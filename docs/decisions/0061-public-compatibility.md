# ADR 0061: Public API and data compatibility

Accepted on 2026-11-12. The first public compatibility baseline closes the early
interface-redesign exception. Existing paths, operation IDs, request shapes, successful
responses, error codes, scope and resource checks, conditional writes, cursor behavior,
and idempotent side effects are supported behavior. New incompatible behavior requires
an opt-in contract while the supported interface remains available. Console and API
remain independently deployable.

Clients can encounter new resource kinds, providers, locations and capability entries.
The currently supported PostgreSQL and File System capability entries remain present.
Use only understood capabilities for actions. Resource creation and grants still validate
their closed set of supported targets server-side. Public sample status retains its
existing spelling and exposes only the documented fields, even as recovery records evolve.

The supported upgrade floor is installation format 2. Preserve Workspace and resource
identities, file bytes and versions, credential bindings, grant decisions and outstanding
idempotency receipts. The original format-1 prototype was retired under ADR 0024.
Introduce record changes with explicit compatible reads or resumable migrations. Include
an interruption/retry case for each new migration. An image rollback requires separate
evidence that the old program can handle the candidate's writes. An isolated compatibility
test supplies evidence about its exercised states; deployment recovery still follows ADR 0032.

## Release evidence

The [baseline manifest](../../tools/api-contract/compatibility-baseline.json) pins the frozen
seven contract views and the public predecessor used to build historical writers and obtain
the downloadable JS and Python clients. Keep both Git revisions reachable. Native CI
compares the candidate with the frozen contract and with the preceding main revision after
the freeze. It retains a JSON report with contract findings, SHA-256 artifact identities
and the outcomes of historical-client, storage-upgrade and rollback probes. Attach that
report to the release before its CI artifact expires. Record additional release-specific
migration and provider tests when the affected behavior goes beyond the fixture.

For local reproduction, use the pinned Node/Rust toolchains and an isolated RustFS binary
as in the native verification guide. Build each revision in its own Cargo target. CI caches the two predecessor binaries
by source and toolchain. Use oasdiff 1.37.0 on PATH or set OASDIFF_BINARY.

```sh
bash scripts/build-compatibility-baseline.sh /tmp/agentspace-predecessor
npm run backend:build
node scripts/compatibility-report.mjs /tmp/agentspace-predecessor meta-service/target/debug /tmp/agentspace-compatibility.json
```

The probe uses two isolated loopback Owner sessions and a controlled SQL provider. It
exercises scoped, expired and revoked Keys, a regional token, two Workspaces with the same
paths, distinct content and a conflicted sales sample, old conditional versions and
a post-upgrade write. It does not attest external provider durability, OIDC login, or
every possible historical record. Preserve the oldest supported fixtures when adding a
new released runtime. The report does not enable deployment rollback automatically.
