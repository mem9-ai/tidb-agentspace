# TiDB Workspace: product and service architecture

Design baseline: 2026-10-27. This is the proposed architecture for an independent developer
and agent product. The repository currently implements a loopback-only interactive prototype
with simulated cloud resources. See [ADR 0001](decisions/0001-unified-workspace-key.md) for the
accepted single-key authorization model.

## Product model

A Workspace is the persistent context for one application, experiment, or agent workflow.
Developers can add MySQL-compatible Starter databases, PostgreSQL-compatible Starter databases,
and File Systems as needed. Resources have their own capabilities, regions, lifecycle, and
internal provider bindings. MySQL and PG are separate instances; changing a connection string
does not change an instance's protocol. Files can be used without creating a database.

The product owns its customer accounts, authorization, support experience, and billing view.
Customers do not need a TiDB Cloud account or provider management key. Upstream cloud tenants,
projects, credentials, and consumption ledgers are implementation details of internal services.

```text
Product account / customer tenant / billing account
  ├─ Workspace A
  │   ├─ MySQL resource → internal provider resource binding
  │   ├─ PG resource → internal provider resource binding
  │   ├─ File System → internal provider resource binding
  │   ├─ Workspace Keys → action + resource grants
  │   └─ Activity, usage, and budget attribution
  └─ Workspace B
```

Workspace ownership is an authorization boundary; actual data isolation also relies on the
provider's instance, database user, filesystem, and internal credential policies. Internal
cloud organization limits may be shared across many customer workspaces. Capacity allocation
must respect those upstream limits instead of promising a fresh provider free tier to each
customer.

The first-run path is: create/open a Workspace, add one resource, create a scoped Workspace
Key, complete a useful request from an agent, then inspect the resulting data and usage.
A new workspace should not require provisioning all three resource types. The prototype
preseeds them to demonstrate an established workspace.

Supabase's project-level grouping is a useful product reference; TiDB Workspace groups an
optional mix of three distinct resource types. [Supabase Platform](https://supabase.com/docs/guides/platform)

## Console information architecture

| Page             | Primary task                                  | Important states and interactions                                                                                                                    |
| ---------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview         | Understand resources and the next useful step | Resource health, create resource, connect agent, allowance summary, recent activity, empty-workspace onboarding                                      |
| Databases        | Create and use MySQL or PG resources          | Resource list, per-database SQL editor and connection actions, protocol, region, lifecycle, supported capabilities; future native client integration |
| File System      | Manage agent context and output               | Directory navigation, filtering, preview/edit/upload/download, scoped access; future streaming and checkpoints                                       |
| Connect an agent | Complete the first authenticated request      | Workspace Key, environment setup, OpenAPI, project instructions, REST examples, future MCP integration                                               |
| API keys         | Grant access to a workflow                    | Allowed resources, allowed actions, explicit future-resource permission, expiry, last use, rotation and revocation                                   |
| API explorer     | Try the actual public API                     | Endpoint/scope selection, request and response examples, error codes, request ID, contract download                                                  |
| Monitoring       | Understand behavior and performance           | Resource health, actual activity, query/file metrics, actor/resource filters, measurement freshness                                                  |
| Usage & billing  | Understand allowances and charges             | Per-resource usage, customer allocation, upstream allowance attribution, estimated/settled spend, limits                                             |
| Settings         | Manage the personal workspace                 | Names, profile and account/session status; future account claim, security, export and deletion                                                       |

SQL Editor belongs inside Databases, scoped to a selected MySQL or PostgreSQL resource;
it is not a peer of Databases in the workspace navigation. The implemented route is
`#databases/<resource-id>/sql`. Database names, row actions, and connection dialogs must
open that exact resource, with Databases remaining active in the sidebar. Reload and
browser back/forward preserve the resource; switching databases clears previous query
results/errors. An unavailable or non-database resource must never silently select another
database. Legacy `#sql` links open the database list for explicit selection. Keep the query
target, displayed database, and URL consistent when adding future database tools.

File System opens files in a non-modal reading panel beside the desktop file list. On narrow
screens the panel has an explicit return to the list. Markdown is rendered by default;
JSON, CSV, common source files, and plain text have text-based previews with an Edit source
tab. Save keeps the current file open. The existing API still accepts only UTF-8 text up to
256 KiB; automatic preview has a separate 128 KiB budget plus line/complexity limits.
Oversized, unsupported, invalid, or failed previews show a reason and retain Download and
navigation. Text source editing remains available; correcting a draft can restore its preview.
Binary images, PDFs, and rich media are not implemented. See the
[file reading standard](standards/tiui-design-system.md#theme-responsive-behavior-and-interaction).

Use real TiUI components, its semantic palette and theme provider, with the Workspace's
larger typography and spacing requirements. The [TiUI standard](standards/tiui-design-system.md)
defines verified defaults, component selection, light/dark/system behavior, responsive
interaction, and migration evidence. [ADR 0002](decisions/0002-tiui-design-system.md) records
the accepted foundation. Preview status, limits, and the three resource types need text labels.

The prototype now uses TiUI components and a single provider-controlled theme. Shared
readability, modal, navigation, code, and SQL adapters live under `src/ui/` and `src/features/`.
Build repeated domain compositions such as ResourceCard, QuotaMeter,
ConnectionPanel, PermissionEditor, and ActivityTable from verified TiUI primitives/business
components. Organize new features into focused modules with shared API/domain types. Register
navigation and capabilities for future services instead of adding global conditionals
throughout the app.

## Backend boundaries

Start with one modular Workspace service and a provisioning/reconciliation worker. Use the
team's established Go or TypeScript stack and existing provider clients. Separate deployment
into microservices only when independent scaling or ownership justifies it.

```mermaid
flowchart TB
  console[Developer Console] --> gateway[Product API / regional data gateways]
  agent[Agent / CLI / SDK] --> gateway
  mcp[MCP transport: future] --> gateway
  gateway --> policy[Workspace Key: action + resource policy]
  policy --> core[Workspace domain operations]
  core --> metadata[(Independent metadata database + outbox)]
  core --> usage[Usage attribution + product billing]
  core --> audit[Activity / metrics / request tracing]
  core --> worker[Provisioning and reconciliation worker]
  core --> adapters[Internal MySQL / PG / File System adapters]
  worker --> adapters
  adapters --> provider[Existing TiDB Cloud services]
  broker[Internal credential broker / secret manager] --> adapters
```

The Console and agents use the same domain commands and authorization. Console-specific
read aggregation can reduce round trips; it must not create a separate authorization model.
MCP maps tool calls onto the same operations.

Separate resource management from bounded SQL/file data operations. Both public paths accept
the customer's Workspace Key. Internally, regional gateways can pool SQL connections and
stream files so large payloads do not overwhelm the central control service. Upstream data
credentials remain internal. Native MySQL/PG clients and filesystem mounts require a deliberate
protocol gateway or bounded delegated product session; they are not automatically supported
by placing a Bearer key in a provider connection string.

Provider adapters should expose capability discovery, create/describe/delete, internal
connection resolution, credential binding, usage retrieval, and available data operations.
Capabilities include region, preview status, limits, supported operations, credential version,
and feature version. A Workspace default region is a preference, not a claim that every
component is available there.

TiDB Cloud documents management APIs, but this repository has not verified every required
PG and Files management/credential/metering operation. Confirm public or internal integration
contracts before implementing adapters; do not invent provider endpoints or scrape browser
credentials. [TiDB API overview](https://docs.pingcap.com/api/)

## Customer identity and single-key access

Production customers sign in to this product. Human, agent, and service-account principals
share one authorization model. The local prototype uses a guest owner; a later identity
service should allow a guest workspace to be claimed without moving its resources.

A public key combines workspace ownership, allowed actions, allowed resource IDs, and expiry.
For example, a key can query PG and read/write Files while being denied access to MySQL.
Resource discovery, usage, and activity also respect this boundary. Resource-level checks
must occur in the service before returning data or making provider calls.

The prototype supports `resourceIds: ["db_vectors", "fs_shared"]` or an explicit `["*"]`.
Exact selections never expand to newly created resources. Resource creation needs the explicit
wildcard plus `resources:write`. A key cannot create/administer other keys; the local owner
session manages credentials. More granular per-resource actions and filesystem path rules
can extend this model later.

Internally retain distinct secrets: cloud management credentials, native SQL users/passwords,
and filesystem owner/scoped tokens. Store production secrets in a secret manager and keep
only references in metadata. The customer neither supplies nor rotates these credentials.
Internal rotation should not force a public Workspace Key change.

Upstream File System credentials have distinct management/data roles, and revoking an owner
token does not automatically revoke scoped tokens it issued. Track those internal bindings
when implementing rotation or cleanup. Public key revocation first blocks product requests;
long-lived sessions and delegated access must also implement bounded lifetime/revocation.
[File System authorization](https://docs.pingcap.com/tidbcloud-filesystem/filesystem-authorization/)

## Resource lifecycle, metadata, and API contract

Real provisioning uses persistent operation state:
`requested → provisioning → active / failed → deleting → deleted`.
Creation accepts `Idempotency-Key` and returns `202 + operation_id`. Workers retain provider
request IDs, retry safely, reconcile observed state, and recover partial failures. Commit
metadata and outbox records atomically. Never solve an uncertain upstream outcome by blindly
creating another potentially billable resource.

Core metadata includes product accounts/tenants, principals, workspaces, resource/provider
bindings, key digests/grants, secret references, operations, idempotency records, outbox events,
audit records, usage events, quota allocations, and product billing attribution. Keep it in
an independent database, outside customer-deletable application instances. Real file contents
belong in the File System provider rather than the control-plane metadata database.

Proposed production resources:

```text
GET/POST   /v1/workspaces
GET/PATCH  /v1/workspaces/{workspace_id}
GET/POST   /v1/workspaces/{workspace_id}/resources
GET/DELETE /v1/workspaces/{workspace_id}/resources/{resource_id}
GET        /v1/workspaces/{workspace_id}/capabilities
GET/POST   /v1/workspaces/{workspace_id}/keys
DELETE     /v1/workspaces/{workspace_id}/keys/{key_id}
POST       /v1/workspaces/{workspace_id}/queries
GET/PUT    /v1/workspaces/{workspace_id}/files
GET        /v1/workspaces/{workspace_id}/usage
GET        /v1/workspaces/{workspace_id}/events
GET        /v1/operations/{operation_id}
```

This is a proposed surface. The exact implemented contract is `public/openapi.json`;
`server/generate-openapi.mjs` is its source. The prototype has one workspace, synchronous
simulated provisioning, bounded UTF-8 file operations, supported demo SELECT patterns, keys,
usage, activity, and settings. Production needs pagination, streaming, conditional writes,
query timeout/cancellation, and stable typed errors with request IDs/retryability. Generate
SDK/CLI types from the public contract and keep changes backward compatible where required.

## Usage, billing, and monitoring

The independent product owns customer plans, budget policy, payment experience, invoices,
and support. An internal ledger attributes/reconciles upstream provider cost to customer
workspaces. A customer invoice is not a requirement to open a TiDB Cloud billing account.
Avoid double charging and do not expose internal organization-wide credits as a separate
customer allowance for every workspace.

For the validation release, keep spending at $0 and show measured usage, allocated allowance,
capacity limits, freshness, and what happens at a limit. No payment data is collected. Fetch
real limits from provider configuration when integrating; do not permanently hard-code a
pricing assumption into the UI. PG and Files are preview offerings with distinct capabilities
and regional availability. [Starter plans](https://docs.pingcap.com/tidbcloud/select-cluster-tier/),
[PG FAQ](https://docs.pingcap.com/tidbcloud/pg-faq/), and
[Filesystem limits](https://docs.pingcap.com/tidbcloud-filesystem/manage-filesystem-limits/)

Meter upstream data activity, including any native/delegated access, with immutable deduplicated
events and versioned prices. Distinguish estimates from settled spend and account for lag.
A budget alert is different from an enforced cap; promise hard limits only when all data
paths and existing sessions obey them.

User observability covers resource status, queries, file activity, usage and agent attribution.
Platform observability covers provisioning latency, upstream failures, retries, quota exhaustion,
orphaned resources and ledger reconciliation. Production audit includes denied and failed
requests with redacted sensitive payloads. The prototype retains only the latest 200 successful
mutation events and displays clearly labeled illustrative charts; it is not cloud telemetry.

## Delivery stages and acceptance

| Stage                            | Scope                                                                                                                             | Acceptance                                                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current prototype                | Guest owner, three demo resource types, persistent local files, single-key action/resource policy, OpenAPI and all Console routes | Local quality gate, API regression tests, browser inspection; no real cloud resources                                                                                             |
| V0 real free-resource validation | Controlled internal tenant, real MySQL/PG/Files adapters, internal credentials, allocated free capacity                           | One customer key queries both databases and writes/reads Files across sessions; forbidden component access fails; revocation affects every component; usage matches provider data |
| V1 developer beta                | Product sign-in/guest claim, multiple workspaces, real metrics, SDK/CLI/MCP, finer policies                                       | Successful first agent read/write is measurable; cross-workspace isolation; retry-safe operations; no customer provider-key requirement                                           |
| V2 commercial/collaborative use  | Payments/invoices, budgets, account security, sharing/team capabilities, provider-specific features                               | Accurate customer/upstream ledger reconciliation, tested revocation, export/delete and safe migration/rollback                                                                    |

The term "$0 version" is interpreted as free allowances / a zero-spending-limit evaluation,
not an API version. First verify upstream management/credential/metering contracts and internal
resource allocation. Anonymous public provisioning needs separate abuse controls, capacity
reservation, expiration, reclamation, and account claim. The local guest owner server is not
that implementation and must not be made public by simply changing its bind address.

Measure time to first useful request, agent onboarding success, second-session context reuse,
permission-denial reasons, revocation behavior, allowance accuracy, and safe retry outcomes.
