# ADR 0032: Addressable preparations and setup attempts

- Status: Accepted owner direction; implementation tracked by GH-76.
- Date: 2026-10-31.
- Contract: [GH-76](../../specs/gh-76/rest-workflows.md).

Replace historical public command-shaped preparation/setup routes with noun resources under
[the REST standard](../standards/rest-api-design.md). Remove the old routes without aliases,
as explicitly requested during pre-production iteration. This changes the HTTP contract,
not resource identity, encryption roots, private bindings, Keys or native credentials.

Import uploads and Workspace sources create one preparation collection using different
Content-Type representations. Import/export preparations expose ID, Location, inspection,
consumption and cancellation; their existing process-local five-minute lifetime is explicit.
They are reviews, not background import jobs. Confirmed imports/exports remain separate
resources and retain their create-only and no-blind-retry boundaries.

Setup attempts are durable, independently encrypted records outside bootstrap state, with a
scoped idempotency reference. Record unknown outcome before I/O and publish completion with
its public resource snapshot atomically. GET/list never retry. Explicit new attempts reuse
saved bindings and provider-supported reconciliation/idempotent setup; they cannot create
replacement resources when bindings are missing. Region executes inline with existing
Execute/provider modules, adding no worker, queue or Global dependency.

Complete the related historical table identity and file deletion contracts: table names are
encoded path segments, file deletion identity uses URI query fields without a body. Update
all first-party callers, generated artifacts, native behavioral tests and active docs together.
Historical frozen specs retain their old names as evidence of their original baseline.
