# GH-263: Federated identities, exact resource access and Raft login

Status: owner-approved implementation direction, being implemented. This file records the
accepted external design; it is not evidence that the implementation or hosted integration
has passed acceptance. Source baseline: `c36afccb332e3b0a9aeac4094de0f63710bd47eb`.

Sources:

- [Parent issue](https://github.com/mem9-ai/tidb-agentspace/issues/263).
- [Full product design, version 3](https://app.raft.build/artifacts/HRh6Cz2yrF55aLukns3B29),
  updated 17 November 2026; English design also appears in the parent issue.
- [Raft integration design, version 4](https://app.raft.build/artifacts/JQWm8KSKhn65LkivFkJWN7),
  updated 17 November 2026, including its public-contract appendix.
- Owner approved Workspace → Resource with organizational tags on 17 November and assigned
  implementation and delivery afterward. Existing Global/Region service responsibilities
  remain; this work adds identity, admission and precise resource authorization to them.

## User outcome and scope

A Human signs into AgentSpace with Raft, explicitly creates or joins a Workspace and approves
an Agent's admission. Login and admission create no provider resource and confer no data
rights. Authorized Humans grant access to exact resources. Admitted Agents discover only
resources they can use, read a bounded file, execute permitted SQL and recover query results
without repeating an uncertain write. The Human can remove access without deleting data.

The first useful delivery includes real native resource operations, not only identity
metadata. New Cloud delegation, inventory, creation and application credentials remain
separate capabilities of the full design; their unresolved provider contracts cannot be
represented as working by the initial Raft integration.

Existing Guest, TiDB Cloud owner and Workspace Key behavior stays in its legacy mode.
Federated Workspaces are explicit and separate. There is no implicit tenant conversion,
resource recreation, credential rotation, migration or provider mutation on login.

## Requirements

| ID  | Required behavior                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F01 | Identity is a trusted provider configuration, verified Server and stable subject. Kind is immutable; names/email/roles never merge identities or grant access.                                                                                                                                               |
| F02 | Human login uses OIDC code, S256 PKCE, one-use state/cookie and nonce, with signature/issuer/audience/expiry validation. One registered callback also supports no-state Agent codes, with `code_verifier` omitted entirely. Invalid Human state never falls back to Agent login.                             |
| F03 | Callback validates current userinfo, expected client, Server, kind, subject and scopes. It issues a Secure, HttpOnly, SameSite=Lax, host-only service cookie covering every action, in the callback response itself. No token appears in its body or URL.                                                    |
| F04 | Local sessions expire no later than upstream credentials, persist encrypted in server Meta, and support durable logout. Every protected operation checks current external identity; temporary upstream errors fail closed without inventing permanent revocation.                                            |
| F05 | Human Workspace creation is explicit, idempotent metadata/placement initialization. Agent admission requires an explicit Human decision. Admission alone grants neither existing data nor creation authority.                                                                                                |
| F06 | Resources have one immutable Workspace, with precise active grants. Agent A's write grant on D1 must never combine with a read grant on D2 to allow D2 writes. Default isolation covers inventory, guessed IDs, files, SQL and results.                                                                      |
| F07 | Only authorized Humans broaden membership, resource sharing, Cloud delegation or application access. A Raft admin Agent remains an Agent. Removing the last Human owner is rejected.                                                                                                                         |
| F08 | Tags organize/filter resources only. Tag edits use a dedicated permission and version precondition. Matching tags, retagging, resource names and createdBy never confer rights. Batch sharing freezes exact resource IDs and excludes later resources.                                                       |
| F09 | Global manages identities and governance; Region performs native data operations and enforces actor, Workspace, resource, scope and current policy. Neither side impersonates an Owner. Legacy broad credentials cannot access new private resources.                                                        |
| F10 | Disconnected regional admission stops within 60 seconds. Policy updates drain admitted request leases before acknowledging application. Expiry, restart, clock faults and stale restored policy cannot resurrect revoked access.                                                                             |
| F11 | Publish five actions: context, list-resources, read-file, query, query-status. Public manifest contains contracts only. Actions return JSON/appropriate statuses, never login HTML. Authenticate and authorize every call independently of manifest metadata.                                                |
| F12 | Query requires a caller-retained requestId before first submission. Bind the key to actor, Server identity, Workspace, resource and canonical request. Persist intent before SQL; same key/content never executes twice; changed content is 409. Recheck access before effects and before returning results. |
| F13 | Lost response/crash after provider submission is outcomeUnknown unless independently proven. Query status uses the original key. A missing, expired or compacted record never grants replay permission. No exactly-once cross-provider claim.                                                                |
| F14 | Read-only SQL is enforced by the real execution/provider boundary. SQL, results and file reads have declared limits. Relative file paths reject traversal. Report only revisions actually supported by the provider.                                                                                         |
| F15 | Console supports the complete Human admission/sharing/resource journey, with useful empty, pending, denied and partial-error states. APIs and generated contracts document equivalent business operations. Existing UI and native clients remain compatible.                                                 |
| F16 | Raft is an external service. Depend only on public OIDC/userinfo/App/actions contracts and released CLI. No Raft source imports, private Computer files or undocumented protocol assumptions.                                                                                                                |

## First action contract

Paths are relative to the configured Global API mount; registered callback and manifest URLs
must use the exact configured public HTTPS origin and mount. Deployment configuration owns
those fixed URLs, never incoming Host or return parameters.

| Action         | Input                                         | Outcome                                                                                           |
| -------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| context        | none                                          | Verified actor/Server, session expiry, own Workspaces and enrollment state; truthful readiness.   |
| list-resources | Workspace, optional exact tag filters, cursor | Authorized resources only, effective per-resource actions, bounded next cursor, no hidden totals. |
| read-file      | Workspace, resource, relative path            | Bounded content and encoding; provider-supported revision when available.                         |
| query          | Workspace, resource, requestId, SQL           | Bounded result and durable state; write grant required for mutations.                             |
| query-status   | Workspace, resource, original requestId       | Own operation's running/succeeded/failed/outcomeUnknown state, subject to current access.         |

No initial action supplies credentials, actor, Server overrides, Region URLs, provider
endpoints, resource provisioning, deletion, permission management or arbitrary commands.
Human governance is a separate authenticated business API, not an Agent admin action.

## Native implementation and verification reach

The affected boundary includes identity directory/session records, Global callback and
management APIs, trusted Global→Region control, regional authorization, shared product
operations, encrypted metadata, public OpenAPI/generated clients, Console and Agent docs.
Preserve the native writer, clock, policy-fencing, provider credential and legacy compatibility
boundaries. Reuse existing provider operations and native OIDC signature validation.

Required evidence includes:

1. Concurrent stable identity creation, kind/Server collisions and unknown commit recovery.
2. Real HTTP Human/Agent code exchange against a public-contract provider fixture, browser
   state failures, replay, wrong client/Server/type/scope, upstream refusal/outage, cookies,
   logout and restart. Fixture success is not proof of live Raft compatibility.
3. A/B default isolation and exact sharing through native HTTP, including cross-resource
   scope union, grants/tags/creator non-escalation, membership removal and legacy bypass.
4. Regional disconnected lease expiry, update/effect races, clock faults and restored floors.
5. SQL request concurrency, conflicting reuse, restart, lost provider response and denied
   result access, asserting actual provider call counts and retained metadata.
6. Actual native file/SQL results and read-only/path/size boundaries, with provider fixtures
   distinguished from real cloud credentials and live resources.
7. Current OpenAPI/generated clients, required native and repository gates, changed Console
   journey in the shared browser/theme/viewport matrix, and latest-head CI before delivery.
8. Fresh released Raft CLI and Human browser acceptance against the registered HTTPS App;
   installation, current identity, resource use and revocation verified through public paths.

Full design acceptance remains A01–A40; Raft acceptance remains R01–R20 in the pinned source
versions. A partial inactive implementation is not completion of those acceptance baselines.

## Delivery authority and external dependencies

Implement, test and publish task-scoped source through the repository's existing PR workflow.
Its current merge policy still applies. Deployment, live tenant conversion, App registration,
real provider provisioning and release use their respective configured targets and authority;
implementation approval does not silently authorize unrelated external effects.

Prepare a concrete registration/deployment package before requesting any required Human
approval. Never ask anyone to paste credentials into chat. Runtime secrets remain private to
the service. Cloud grant/audience compatibility, deployed FS gateway, restricted PG credential
handoff, membership-loss bounds and application secret delivery must be independently proven
before enabling those provider capabilities. Do not rotate an existing database's root key or
fall back to anonymous provisioning to make an unverified capability appear ready.
