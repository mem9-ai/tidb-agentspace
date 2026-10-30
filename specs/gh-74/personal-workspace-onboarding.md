# Personal Workspace onboarding with TiDB Account

- Status: proposed implementation contract; no production onboarding is implemented here.
- Parent: [multi-tenant control plane](https://github.com/mem9-ai/tidb.ai/issues/22).
- Direction: every verified TiDB Account gets its own persistent personal Workspace; Guest
  users experience the product in an independently isolated tenant and Workspace.
- Existing topology and regional independence: [GH-74](spec.md), [control channel](control-channel.md), and [regional authorization](regional-api-auth.md).

## Outcome and boundary

Alice and Bob may both sign in at Studio. Alice sees only her own Workspace and its
resources; Bob sees only his. Repeated login, API restart, and recovery preserve their
Workspace IDs and ownership. A first login creates an empty personal Workspace without
creating upstream databases or file systems. This is a personal default, not a restriction
against shared Organizations or additional Workspaces in a later release.

A Guest gets the same logical tenant/Workspace isolation as an authenticated account, with
an independently generated Guest principal and a private high-entropy browser credential.
Guest identity is not a shared hard-coded account or the existing loopback demo owner.
Guest Workspaces expire 24 hours after creation. Expiry initiates automatic deletion of that
Guest's Workspace and its cloud databases and file systems. The named account login is the
existing TiDB Cloud login, not a separate Teleport provider. Account linking remains a separate
product decision. A lost Guest credential must not be recovered by guessing an ID or matching
email. Require rate limits, quota and abuse controls for Guest creation.

Current code does not provide this: a configured API instance owns one Workspace, the
SSO allowlist grants access to that shared Workspace, and the Console and generated contract
assume `ws_agentlab`. Existing Meta Scope primitives alone do not establish authorization.

## Identity and control-plane records

- Identify the person by the exact validated OIDC issuer and immutable scalar subject
  (`iss`, `sub`), after the existing signature, audience, nonce, expiry and PKCE checks.
  Email, display name, organization claim, and browser input are not account identities.
  Issuer and subject are case-sensitive. An identity-provider change requires an explicit,
  authenticated linking procedure; matching emails must not merge accounts.
- Provision a Guest through a separate cryptographically random principal and secret, not by
  fabricating a verified OIDC subject. Persist only an appropriate credential verifier and
  protect the browser secret with the existing secure cookie and origin protections. A Guest
  can only access its own Workspace. Cross-device recovery and upgrading a Guest to an account
  require a separately authorized ownership-linking protocol; never transfer ownership solely
  because an account signs in in the same browser.
- Global owns a durable identity directory and the canonical personal Organization,
  Workspace, owner membership, placement and initialization intent. Keys use a
  collision-safe encoding or length-delimited cryptographic digest of the issuer and subject;
  values hold the full identity for collision verification. IDs are random opaque identifiers,
  not email addresses or exposed subject hashes. Logs must not contain tokens or subjects.
- A single scope-atomic conditional commit creates the identity mapping, organization,
  Workspace ID, owner membership and intent, or returns the already committed mapping.
  An indeterminate commit is resolved using its stable mutation receipt; it is never treated
  as proof that no record exists. Regional initialization is a separate idempotent operation
  with a stable operation ID, expected owner, region and generation. Resume a pending operation
  after crashes or concurrent logins; never adopt a mismatched Workspace. A Workspace becomes
  ready only after Region's durable acknowledgement has been observed by Global.
- Global initiates policy installation and readiness reads over the existing authenticated
  channel. Region never calls Global or opens its SlateDB. The regional Meta stores the
  Workspace's records, bindings, credentials and the complete installed authorization state;
  its S3 root and encryption are independent of Global. Direct Region APIs authenticate and
  authorize locally, including during a Global outage. Global loss may block a first signup,
  new placement or unpropagated changes, but not an already established regional Workspace.
  Real credential expiry and already received revocations remain effective. A revocation
  issued while Region is unreachable cannot have a guaranteed immediate regional effect.
- Implement local, durable owner authorization and regional renewal as specified by the
  regional authorization contract before claiming regional availability through arbitrary
  Global outages. A short-lived Global-issued token that must be renewed from Global is not
  sufficient. External identity-provider, regional storage and key-management failures have
  their own availability limits.

## Requests and isolation

- Login creates a session bound to the verified identity and its authorized Workspace;
  the Workspace ID from an HTTP path, request body, browser state or Key prefix is a selector,
  never proof of access. Check the authenticated principal, current installed policy, exact
  Workspace, requested action and resource before provider or data-plane I/O. A session for
  Alice must not gain Bob's owner privileges by supplying Bob's Workspace ID.
- Preserve the existing action/resource grants, expiration and revocation for Workspace Keys.
  A Key must resolve to and authenticate against its own Workspace; choosing another path
  cannot broaden its authority. Keep provider credentials and private DuckDB storage within
  their owning Workspace and out of the client. Do not expose metadata service credentials.
- `GET /workspaces` returns the caller's authorized Workspace(s). Console startup discovers
  the Workspace from that response instead of a compiled constant; typed OpenAPI path
  parameters allow opaque Workspace IDs. Preserve existing response and error contracts
  wherever possible and regenerate clients. Test direct regional APIs as well as Console.
- A single server must serve multiple accounts without a process, API listener or S3 bucket
  per user. Bound workspace caches, in-flight requests, provisioning, memory and session state;
  eviction and shutdown must safely release writer ownership. The existing Workspace writer
  guard and process-local provider coordination do not constitute distributed claiming or HA.
  An implementation must fence concurrent ownership and recover unknown provider effects
  before increasing replicas. Millions of Workspaces require independently measured cell,
  shard, discovery, pagination and fairness designs, not an unbounded in-memory map.
- Untrusted public analysis or shell workloads require the OS/container isolation and aggregate
  resource controls called for by ADR 0010. Until those controls are validated, disable the
  affected capability for open self-service tenants. Control onboarding and provider budgets
  using explicit admission, rate and quota policies without changing tenant ownership.

## Rollout and existing state

Ship behind an explicit default-off configuration. Preserve the existing shared Workspace,
its resources, Keys and provider credentials; do not infer ownership from an email or hand
the Workspace to the first person to sign in. The product owner must determine its authorized
owner or disposition before any reassignment. No cloud resource deletion is implied.
Existing users receive a new empty personal Workspace unless an explicit, separately
authorized and verified migration assigns an existing Workspace to them.

Guest expiry is a durable lifecycle operation, not a browser timer: at creation persist an
expiry exactly 24 hours later, disable access at expiry even if cleanup is delayed, fence
in-flight work and reconcile each effect. Automatically delete only upstream databases and
file systems verified to belong to that expired Guest Workspace, then remove its Workspace
records under the retention and audit policy. Preserve the operation and provider
binding/credential evidence until cleanup is confirmed; never blindly repeat an uncertain
cloud deletion. Do not delete the pre-existing shared Workspace or another account's resources.

Enabling open self-service on the hosted site requires a reviewed runtime configuration,
durable Global and regional stores, operator recovery procedures, identity-provider access,
isolated execution, quotas and the acceptance evidence below. A source merge, simulated SSO
test or image deployment alone does not prove the hosted website was switched.

## Acceptance cases

1. Two independently signed provider subjects can each sign up and return after restart;
   each keeps one stable Workspace and neither can list, read, mutate, query, export or use
   Keys or provider credentials belonging to the other, including by changing the URL.
2. Repeated and concurrent first logins, dropped replies, crashed initializers and replayed
   regional commands produce one durable identity mapping and one personal Workspace;
   unresolved side effects are reconciled, not silently repeated.
3. Same email with different subject or issuer does not confer ownership. Invalid, expired,
   replayed or wrong-audience/issuer tokens cannot provision or select a Workspace.
4. A valid Workspace Key is scoped to the correct Workspace, resources and actions; expired,
   revoked and cross-Workspace uses fail before provider I/O. Missing policy fails closed.
5. Existing shared Workspace data remains untouched and cannot be claimed by a new signup.
   Console and generated API clients discover distinct opaque IDs without hard-coded values.
6. After policy installation, regional requests, locally authorized renewal and regional
   restart continue through a simulated Global outage; first signup may remain pending.
   Test recovery, policy ordering, delayed revocation and rejection of Region-to-Global calls.
7. Exercise provider bindings, file/database operations and execution isolation with two
   tenants and local fixtures; verify bounded overload, cleanup and writer recovery. CI uses
   isolated object storage and a signed fake provider, without cloud credentials. Real hosted
   login, rollout, production isolation and scale require separate observed evidence.
8. Independent Guest browsers get distinct principals and Workspaces; a Guest cannot select
   another Guest or signed-in account's resources or Keys. At 24 hours expiry blocks access
   independently of cleanup, which deletes only the Guest's own cloud resources and survives
   restart without claiming existing data. Test uncertain deletion and retry reconciliation.
   Reuse, session loss and upgrading follow explicit product decisions.
