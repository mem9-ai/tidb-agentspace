# ADR 0062: Federated Raft identity and exact resource access

Accepted direction: 2026-11-17, [GH-263](https://github.com/mem9-ai/tidb-agentspace/issues/263).
Implementation contract: [specification](../../specs/gh-263/spec.md).
This records the optional native Raft mode. It does not assert deployment, live Raft
acceptance, Cloud delegation, application credentials or tenant conversion.

## Identity and governance

A verified provider configuration, Server UUID and subject bind one immutable Human/Agent
Principal. Names, email, external roles and issuer-path aliases never merge identities or
confer Workspace rights. A principal index supports exact Human-reviewed admission; it is
not a public directory. An interrupted index write is repaired from the immutable binding.
Login creates only identity/session records.

Workspaces contain resources directly. Tags organize resources and never authorize them.
Human-created Workspaces start empty with one Human governor. Admission and data access
are separate. A Human can review the identity ID from an Agent's protected context and admit
it without giving the Agent a membership-management action. Self-service requests remain
available through the ordinary API. Neither path grants data or resource creation rights.
Removed memberships are not reactivated by replaying an invitation or approval. This initial
flow has no reinstatement operation. It never deletes or reassigns resources on removal.

Only current Human governors broaden membership or exact resource grants. Such changes
require a Human sign-in within ten minutes and the reviewed Workspace generation in a strong
`If-Match` header. Immutable successful retries resolve their original intent; they cannot
expand it. The last Human governor cannot be removed.

Grants name one principal, one resource and explicit actions. Shared grants expire within
90 days; the initial creator grant is valid until revoked. A grant ID cannot change targets,
actions or expiry, or become active after revocation. Grant unions remain local to the exact
resource. Tag edits require both discovery and `tags:write`, bounded key/value inputs and the
current tag version. Batch sharing first persists the reviewed exact IDs, recipient, actions
and expiry. Each edge reports application or failure separately; later tag matches are excluded.
Governance intents and their security audit events commit atomically. Denied/uncertain
verified governance attempts are recorded separately and cannot authorize an effect.

## External login and sessions

Raft is an external service. The adapter uses its published OIDC, userinfo and v0 App/actions
contracts. Human login uses S256 PKCE, state and nonce. The same registered callback redeems
no-state Agent codes with `code_verifier` absent and requires verified `type=agent`. An invalid
Human transaction never selects that branch. Client, Server, subject, kind and `openid profile`
are checked independently of manifest declarations.

The callback sets the host-only HttpOnly/Secure/SameSite=Lax session cookie itself. Upstream
credentials live in encrypted server Meta, never in the body or URL. Sessions expire no later
than the upstream token (at most one hour), survive restart and support durable local logout.
There is no assumed refresh-token or upstream browser-logout propagation. Every protected
operation checks current userinfo; upstream outages fail closed as temporary failures.

## Global and Region

The existing Rust service split remains. Global resolves identities, handles governance and
provides the same-origin Raft adapter. Region executes the existing product operations.
Global never forwards browser cookies or impersonates a legacy Owner.

A backend-only native signed proof binds the verified actor, Server identity stamp, Workspace,
Region, generation, exact resource and action ceiling. A proof uses a 50-second window from
the policy observation, reserving two declared five-second clock errors within a 60-second
real-time admission bound. It is also capped by session and supporting grant expiry. Region independently
checks current Raft userinfo, the identity stamp and its durable generation floor. Human-only
metadata/creation proofs have separate fixed purposes and routes; their wildcard is never a
data grant. The data path issues one exact-resource proof and cannot combine rights across IDs.

Policy installation drains native request leases, persists the generation and rollback
checkpoint, then acknowledges. Same-generation delivery is idempotent. A stale, conflicting,
expired or unverifiable proof fails closed. Already submitted writes can remain uncertain;
revocation does not imply cancellation, rollback or recall of previously read data. A failed
policy acknowledgement is reported as failure/unknown, never as applied.

Federated Workspace initialization asserts an empty tenant and writes its explicit ownership
marker. It cannot adopt a legacy tenant. Native writer observations borrow the current writer
guard without claiming or replacing it. Legacy Owner/Key authorization requires legacy
ownership and cannot establish federated authority.

## API, storage and compatibility

The opt-in contract is `/auth/raft/*` and `/api/raft/*` under the configured Global mount,
plus its public manifest. The Console uses `/raft`. These separate routes satisfy the opt-in
version boundary without changing the frozen v1 contract or moving old tenants. The API and
Console stay independently deployable. Raft actions are context, list-resources, read-file,
query and query-status; ordinary Human governance is not an Agent admin action.

Durable SQL uses a new native `/query-requests` resource; legacy `/queries` keeps its existing
response. Before provider I/O, retain an encrypted intent keyed by verified actor, Workspace,
resource and caller request UUID. Bind it to canonical SQL and execution mode. Same-key retries
observe it, changed reuse conflicts, and a crash/lost provider response never grants replay.
The original key remains usable for status subject to current rights. Results are limited to
1 MiB/1,000 rows. Request identities and results currently have no expiration or compaction;
introducing retention must preserve replay-denying identities. There is no cross-provider
exactly-once guarantee. Nonempty bound-parameter arrays are currently unavailable.

No live tenant conversion, broad-key narrowing, root-password rotation, provider credential
export or application credential issuance is authorized by enabling this mode. Cloud delegated
connections, canonical attachment, provider provisioning authority and application secret-store
delivery need their own verified contracts before enablement. Existing local/native provider
operations are reused where supported; their success is not proof of those new Cloud capabilities.

See [Raft usage and operator setup](../raft-agents.md) for limits, configuration and acceptance.
