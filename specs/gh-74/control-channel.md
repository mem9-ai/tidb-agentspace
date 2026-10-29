# GH-74: Global-initiated regional control channel

- Status: Owner-requested direction; regional autonomy, protocol and deployment details proposed for review.
- Parent: [Workspace control plane](spec.md) and [ADR 0017](../../docs/decisions/0017-workspace-kv-control-plane.md).
- Implementation: Design only; no control network, TLS, policy replication or migration is implemented here.

## 1. One caller direction

The cross-plane invocation/dependency graph is Global control -> Region control. A Region
does not call Global control or another region, directly or through a broker, shared global
metadata store, telemetry publisher, credential refresh endpoint or token introspection API.
Regional data services must not provide an indirect reverse path. Regional services may
access their authorized regional stores/providers; this does not grant access to global stores.

Global pushes desired state/policy and initiates every observation, result, health,
capability and metrics read. Region returns a bounded response to that exact request. Reply
bytes and mTLS authentication are required parts of that exchange, not a Region-initiated
RPC or a physical data-diode guarantee. No unsolicited server push, reverse RPC, subscription
or callback is permitted, including inside a Global-opened bidirectional stream.

Make the constraint enforceable: Region has no Global client credentials, SDK/callback URL
or reverse-service role, and network policy denies Region-initiated Global connections.
Regional credentials are server identities for the caller-initiated channel and local service
access. Deployment trust/certificates are bootstrapped out of band; renewal cannot introduce
a Region -> Global enrollment dependency. Global can request a CSR/rotation state and push
the replacement, or trusted deployment automation can install it.

Desired state is owned globally; observed state is owned regionally. Pulling an observation
updates a global projection, not the desired state or a new generation automatically. A new
command requires an explicit authorized user/policy workflow; retry delivers the same identity
and generation. Polling is read-only and must not itself append an observation that triggers
more control work. These rules prevent response/command echo loops as well as call cycles.

## 2. Commands and Global-owned reads

Illustrative internal operations, not public API endpoints:

| Global-initiated operation                      | Region behavior                                                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| ApplyDesiredBatch                               | Validate signed intent, audience, generation and authority; persist inbox before effects; return a durable acceptance receipt |
| StagePolicyChunks / CommitPolicy                | Receive bounded signed snapshot/delta chunks, then atomically activate a complete verified policy version                     |
| ReadOperations / ReadObservations               | Return requested operation states or a bounded local change page since a cursor, without callbacks                            |
| ReadPolicyState / ReadHealth / ReadCapabilities | Return applied versions, synchronization lag and safe regional status only when queried                                       |
| ReadMetrics / ReadAuditSummary                  | Return allowlisted bounded regional summaries; raw SQL/file payloads and native secrets stay regional                         |

All commands carry installation/environment, target Region/cell/shard, operation ID,
idempotency fingerprint, desired generation, routing/ownership epoch, policy-version refs,
issuer/key identity and validity. Region rejects mismatches before secret/provider/data I/O.
Duplicate delivery returns the original receipt; a changed payload under the same identity
conflicts. Missing prerequisites leave pending/unavailable state, never a reverse lookup.
Local provider-effect claims, receipts and unknown markers retain the main spec's semantics.

A command acknowledgement proves durable acceptance/application only to its declared stage;
it is not proof that an asynchronous provider create completed. Global asks for completion
later. A lost response does not authorize a second create or a new operation identity.

## 3. Regional observation journal, pulled by Global

Replace the regional result-publisher role with a region-local, indexed observation journal.
Regional state and its journal/result record commit together in a bounded resource group.
The regional ChangeSource builds a durable replayable read index; it never ships data to
Global autonomously. Global owns per-stream ingestion cursors and ingestion workers.

Global reads `(Region, cell, stream, epoch, after, limit)` pages with sequence/high-watermark,
resource/operation identity, generation, safe observed state and freshness. It persists the
projection and replay receipt before advancing its cursor. Lost/duplicated pages replay
idempotently. Reject stale generation/wrong-region observations without changing desired
state. Sequence gaps/expired retention require an explicit Global-requested bounded snapshot;
an empty page is not proof that a resource disappeared or a provider effect failed.

Global can communicate its ingestion checkpoint in a later request, but that acknowledgement
is not a regional availability/retention prerequisite. Region compacts resolved journal
history under a declared local snapshot/archive and cursor-expiry policy; unresolved provider
identities/receipts are retained independently. Global resnapshots explicitly when needed.
Region restore changes stream epoch rather than resetting a cursor silently. Reading health/
observations does not create another journal event for the poll itself.

At scale, Global polls indexed Region/cell/stream deltas and requested operations, not every
resource every interval. Use bounded batches, backoff/jitter, change/health-specific cadence,
tenant fairness and separate budgets. Policy/revocation traffic has priority over bulk status,
export and repair. Detailed regional logs/metrics follow the same Global-initiated rule.

## 4. Durable local admission from signed policy

The [regional API/auth contract](regional-api-auth.md) specifies separate API origins,
local exchange/refresh/reauthentication and explicit continuity grants. Short access-token,
bootstrap-credential and actual authorization-end times are separate; existing expiring Keys
cannot silently acquire indefinite regional renewal. Public API client flows never add a
Region -> Global call or data proxy through Global.

Regional independence is a hard availability requirement. The previous online Global
admission and policy-lease-expiry shutdown proposals are superseded. Global unavailability,
failed synchronization and elapsed policy age must not deny work already authorized by a
complete installed policy version. There is no Global heartbeat, policy-renewal deadline
or control-plane lease that can stop established regional service.

Global compiles relevant owner/membership/Key-verifier/grant-set/resource-access policy into
signed, versioned manifests/chunks with issuer, environment, audience, source versions,
epoch/sequence, predecessor and checksums. Global uploads every required chunk; Region does
not fetch missing material from a Global URL/store. Stage replacements without changing the
active root. After signature/hash/schema/ownership/completeness checks, atomically publish and
retain an activation/provenance record plus monotonic applied/denial floors in regional storage.
An incomplete, gapped or invalid update leaves the last complete version active without a TTL.
A Region with no valid established policy cannot invent a permissive tenant catalog.

Evaluate local **P1 -> R -> P2**: pin the installed policy/Key/session/grant read set and
regional resource group, then check unchanged policy, ownership/region, action, generation,
binding and original customer-credential constraints. Mutations validate the expected resource
revision. The policy's synchronization timestamp/source watermark is freshness information,
not a permission timeout. A locally applied denial, expired customer Key or missing grant
still denies access. Wildcards never cross Workspace/private-storage boundaries.

Separate time-dependent objects explicitly:

- Installed policy remains effective until a complete authorized replacement or local deny;
  signer/control-certificate expiration does not expire an already verified activation.
- Customer Keys/session credentials keep their declared expiry. Region verifies them locally,
  and issues/renews regional sessions from locally verifiable credentials/refresh state and
  installed policy, using regional signing keys. It never extends an expired customer Key or
  mints new Global privileges. Regional renewal must not depend on Global login/introspection.
- A command delivery deadline limits accepting a new message. Once durably accepted, intent
  executes under explicit regional operation/service authority and current local policy;
  expiry of the original delivery envelope is not a Global-connectivity kill switch. New
  customer requests remain subject to their original credential validity.
- Worker claim leases, request replay windows and native-resource expiry keep their separate
  meanings. Their expiry cannot be confused with loss of policy freshness or used to repeat
  an unknown provider effect.

Each regional data action/queued step uses the current local policy and durable claim/service
context. Observed local cancellation/revocation stops prohibited new steps; admitted effects
have bounded cancellation/recovery semantics. A local operator with previously delegated
regional authority may apply an audited deny-only overlay during isolation; it cannot grant
new Global roles. Keep that overlay/floor through resynchronization until explicitly resolved,
so an old Global snapshot cannot silently re-enable locally denied access.

Offline restart verifies the installed policy bytes, retained trusted signer/provenance and
activation/denial floors from regional replicas/backups. It does not require Global discovery,
current Global signing services or certificate introspection to reapprove established policy.
New incoming updates still require currently valid authorized control identity/signatures;
this rule does not accept an unknown/expired signer for a new policy installation. Missing or
corrupt established state fails closed only for its affected scope, never seeds replacement
resources, and is a regional recovery failure rather than a policy-age decision.

## 5. Availability, revocation and resynchronization

The regional serving path has no dependency on Global liveness. Global owns coordination and
synchronization; Region durably owns the material needed to keep serving its existing scope.

| While Global is unavailable                                               | Required behavior                                                                                                 |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Known regional SQL/files and new valid requests                           | Continue under installed policy, regional resource state and actual local/provider budgets                        |
| Existing regional session reconnect/renewal                               | Use local verifiers/refresh state and regional signing; enforce genuine credential expiry                         |
| Accepted lifecycle work, repair and scheduling                            | Continue under installed regional authority; retain unknown effects and original identities                       |
| Regional process/node restart                                             | Recover policy, bindings, routing and credentials from regional storage/replicas, without a Global bootstrap call |
| New Global Organization/Workspace/placement or additional shared capacity | Pending/unavailable for that Global-dependent change; existing regional work continues                            |
| Global policy change/revocation not delivered                             | Report accepted/pending for that Region; do not claim regional effectiveness                                      |
| Health/observations/metrics no longer collected                           | Mark Global views stale; regional service and bounded local retention continue                                    |

Deploy regional entry points, routing/discovery views (including installed legacy Key-digest
hints), authentication/session signing, metadata/indexes, provider credentials, Vault/KMS,
regional leadership/fencing, data workers and needed DNS/PKI/time services independently of
Global control. Regional coordination/claim leases cannot require a Global keepalive. A client/SDK must be able to
connect/reconnect using a known regional endpoint without going through a Global gateway,
login redirect or per-request discovery. Regional bootstrap/listing serves only its installed
Workspace/resource scope and does not claim a complete Global inventory. Unknown assignments
need synchronization; they do not invalidate already known regional resources.

Hosted independence requires separate Global and regional processes/failure domains and
independent regional stores/secrets. Same-process packaging is a local functional-test profile
only; killing that process is not evidence of this availability requirement. Regional token,
TLS and provider-credential renewal use authorized regional infrastructure/providers rather
than a Global issuer/KMS or shared Global secret broker. Do not weaken cryptographic identity
or ignore genuine credential/certificate expiration to simulate availability. Expired Global
control-channel identity blocks synchronization, not already established regional data work.

Global-issued quota/capacity rights already delegated to Region remain valid on disconnect;
no renewal timer recalls/reissues them. Region consumes/returns rights only within its owned
allocation and proof rules. Exhaustion blocks work needing additional rights, not unrelated
existing requests. Never obtain new shared capacity by assuming an unreachable Global ledger
has no allocations or by bypassing provider limits. Global-coordinated names/placement still
follow their confirmed reservations; offline operation does not fabricate a new global claim.

A Global denial becomes effective immediately for new Global admissions. Regional effectiveness
requires Global to push/query and obtain durable applied-policy/deny evidence for each target.
There is no fixed propagation/revocation deadline while a Region is unreachable, and no policy
lease expiry from which Global can infer that the Region stopped serving. Expose per-target
accepted/pending/effective state and the last applied version. Delivery-lag alerts are not a
serving veto. Locally delivered revocation, credential expiry and authorized local denies
continue to take effect without Global connectivity.

Region must not wait for a Global ingestion acknowledgement before compacting resolved
observation/telemetry history under its regional retention/archive policy. Keep canonical
current state, local snapshots, unresolved provider receipts and minimal operation/tombstone
replay evidence even when detailed observations are compacted; never let an
uncollected Global export queue grow until it blocks data I/O. An expired ingestion cursor
returns an explicit resnapshot requirement. Audit retention/storage remains a regional budget,
not an unbounded in-memory queue or an excuse to discard unresolved ownership evidence.

On recovery, Global initiates version/progress reads, pulls journal deltas or a bounded
snapshot and reconciles pending work before pushing changes. Resume from regional applied
floors and original resource/operation identities; do not reset Region from stale Global
projections, replay creates, drop a local deny overlay, or label unchanged resources missing.
A restored older Global installation must recover those floors before issuing a new epoch;
an epoch bump alone is not proof that old grants/descriptors are safe to restore.

## 6. Production encryption and identity

Require TLS 1.3 with mutual certificate authentication on every cross-plane hop, using a
maintained implementation and approved AEAD configuration. Verify certificate chain, service
identity/hostname, environment, Region/cell audience, purpose and validity. A bearer token,
private network or encrypted connection without caller authentication is insufficient. Do not
disable certificate verification, silently downgrade or allow TLS 0-RTT for control mutations.
Any approved proxy must authenticate and re-encrypt the next hop; no plaintext internal leg.
Bound connection reuse/resumption by peer identity/certificate validity and retirement policy;
an old authenticated connection cannot preserve retired authority indefinitely.

Sign persisted commands/policy using vetted signing libraries and managed Global-only
keys, so replayed queued payloads remain attributable after transport termination. Bind request
and response to operation/request identity and audience; validate structured responses rather
than following instructions/URLs in them. Encrypt persisted sensitive payloads through the
declared managed storage/vault profile; native credentials do not travel on this channel.

Provision CA/trust roots and initial identities out of band. Scope and rotate certificates/
signing keys with bounded overlap, pushed trust bundles and explicit retirement. Region can
return rotation/CSR state to a Global-initiated request; it cannot enroll or fetch Global keys
by calling upstream. A wrong environment/Region certificate, expired trust, signature mismatch
or unavailable required key makes the channel unavailable and cannot trigger insecure fallback.
Region validates provisioned chain/trust/revocation material locally; online certificate or
key discovery must not introduce a hidden Region -> Global dependency.

## 7. Explicit local test profile

Same-process tests may inject a fixed service identity. An explicitly selected `local-insecure`
profile may use loopback HTTP for disposable development fixtures, visibly labeled and
rejected for non-loopback addresses or hosted/production mode. There is no failure-triggered
downgrade. Prefer a disposable test CA when testing the real TLS path; trusting that CA is
different from disabling verification.

Local relaxation changes transport setup only: preserve one caller direction, message
ownership/shape, authorization, generation, replay and tenant tests. Test credential/command
expiry with controlled clocks; policy synchronization age must not disable Region service. No environment flag, endpoint or implementation is introduced by this spec.

## 8. Verification and references

Main-spec META-38–50 cover call direction, pulled recovery, durable policy/revocation, real
TLS identity negatives, local-only relaxation, scale and independent regional outage/restart
behavior. Global blackhole tests must outlast the superseded lease/heartbeat deadlines.
No check run in this documentation PR proves these new protocols exist or pass.

Primary references checked on 2026-10-29:

- [RFC 8446](https://www.rfc-editor.org/rfc/rfc8446.html): TLS 1.3, certificate authentication and the distinct replay considerations of 0-RTT.
- [RFC 8705](https://www.rfc-editor.org/rfc/rfc8705.html): mutual TLS identities and certificate-bound authorization; this spec does not select an OAuth deployment or permit reverse introspection.
