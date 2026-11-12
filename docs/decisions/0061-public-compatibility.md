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
