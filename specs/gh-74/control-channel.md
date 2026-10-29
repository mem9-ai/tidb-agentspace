# GH-74: Global-initiated regional control channel

- Status: Owner-requested direction; protocol, lease and deployment details proposed for review.
- Parent: [Workspace control plane](spec.md) and [ADR 0017](../../docs/decisions/0017-workspace-kv-control-plane.md).
- Implementation: Design only; no control network, TLS, policy replication or migration is implemented here.

## 1. One caller direction

The cross-plane invocation/dependency graph is Global control -> Region control. A Region
does not call Global control or another region, directly or through a broker, shared global
metadata store, telemetry publisher, credential refresh endpoint or token introspection API.
Regional data services must not provide an indirect reverse path. Regional services may
access their authorized regional stores/providers; this does not grant access to global stores.

Global pushes desired state/policy/leases and initiates every observation, result, health,
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
| RenewAuthorizationLease                         | Validate version, coverage, source-cut freshness, expiry and signature; never extend validity locally                         |
| ReadOperations / ReadObservations               | Return requested operation states or a bounded local change page since a cursor, without callbacks                            |
| ReadPolicyState / ReadHealth / ReadCapabilities | Return applied versions, lease state and safe regional status only when queried                                               |
| ReadMetrics / ReadAuditSummary                  | Return allowlisted bounded regional summaries; raw SQL/file payloads and native secrets stay regional                         |

All commands carry installation/environment, target Region/cell/shard, operation ID,
idempotency fingerprint, desired generation, routing/ownership epoch, policy/lease refs,
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

Global can communicate its durable ingestion checkpoint in a later request. Journal GC
requires that checkpoint or an explicit expiry/resnapshot policy plus backup/read reachability;
unresolved provider identities/receipts are retained independently. Region restart/restore
changes the stream epoch rather than resetting a cursor silently. Reading health/observations
does not create another journal event for the poll itself.

At scale, Global polls indexed Region/cell/stream deltas and requested operations, not every
resource every interval. Use bounded batches, backoff/jitter, change/health-specific cadence,
tenant fairness and separate budgets. Policy/revocation traffic has priority over bulk status,
export and repair. Detailed regional logs/metrics follow the same Global-initiated rule.

## 4. Local admission from signed policy

The previous regional online Global-admission protocol is superseded. Global management
mutations still use current global canonical policy. Regional requests use a locally installed,
signed, region-scoped policy projection and bounded authorization lease; no reverse identity,
Key validation, quota, credential or session-refresh call is allowed.

Global compiles only relevant owner/membership/Key-verifier/grant-set/resource-access/region
policy into versioned manifests and immutable chunks. Include source versions/cut, checksum,
issuer, environment, audience, policy epoch/sequence, predecessor/base version, coverage and
expiry. Never distribute upstream credentials or a global signing private key. Global uploads
chunks to Region; Region must not fetch missing chunks from a Global URL/store. Missing or
out-of-order deltas leave the prior complete version active only within its lease. Staging
is unservable; signature/hash/ownership/schema/generation checks precede atomic publication.

Region checks the customer Key/session verifier, action, tenant/resource grants, policy/lease
coverage, local resource lifecycle/binding, ownership epoch and original credential expiry
before I/O. Pin a local policy read set and resource revision, then validate unchanged policy
and expected resource version at mutation/admission. Wildcards stay inside one Workspace;
hidden storage is never exposed. A direct regional request with no complete valid policy
gets an explicit unavailable response, never a callback to Global or a permissive default.

Every new customer lifecycle command/session action and external step rechecks current **local**
policy/lease. A Global-issued per-operation grant can narrow permission; it cannot outlive
the policy/credential lease, be reused for another payload, or substitute for local resource
state. Region may not mint/renew Global authorization. Long-running work has explicit bounded
admission/cancellation semantics; expiration does not undo an already completed provider effect.
Unknown effects remain recoverable and are not retried just because permission expired.

Global policy/trust installation, lease repair and safe control-status reads use a separate
infrastructure service authority. An expired customer/data lease must not prevent a correctly
authenticated Global caller from repairing policy or reading local progress. That exception
does not authorize customer SQL/files or a provider mutation without its required authority.

## 5. Lease freshness and revocation completion

Production must declare maximum policy age `L`, clock uncertainty bound `D`, in-flight
deadlines and renewal cadence. There is no implicit unlimited offline mode. Global records
issued scope/coverage/version/deadline before sending, and signs validity against the last
**proved complete source cut**, not merely the current signing or retransmission time.
Replaying or re-signing an old snapshot cannot extend its freshness. Renewal needs proof
that the relevant denial/suspension/resource-access changes through the new source cut are
included. Feed gaps, incomplete coverage or an unavailable issuer block renewal.

Batch leases for active policy coverage/streams; do not create one heartbeat/renewal per
resource or preactivate every inactive Workspace. The compiler/issuer must demonstrate
source-cut completeness, bounded point/manifest validation and load/fairness under META-45.
Missing proof fails closed rather than using an asynchronous index as current permission.

A global denial starts a revocation workflow. Persist the new canonical policy/access guard,
stop extending the superseded cut for affected coverage, and push the replacement. Global
marks it regionally effective only after querying/receiving durable applied-version evidence
for every covered target, or proving every superseded authorization has passed its recorded
deadline plus `D` with no eligible old-cut renewal. Missing issued-lease/target proof keeps
the workflow pending. Global APIs must distinguish accepted/pending from regionally effective;
they cannot claim immediate completed revocation from a global metadata commit alone.

Within a valid previous lease, an isolated Region may still admit previously permitted work;
at expiry it rejects new data operations and external lifecycle steps while retaining state.
Local clock rollback, uncertain time beyond `D`, missing lease on restart or an older epoch
cannot prolong validity. Use bounded monotonic deadlines with validated wall-clock limits;
restore must not resurrect policy/leases or forget revocation floors. Physical deletion and
unknown provider outcomes require their own evidence; time-based lease expiry proves neither.

Global/Region disconnection therefore has an explicit bounded policy window. Work admitted
before a deny/expiry may finish within its declared bounds; a new step after a locally applied
denial or lease expiry is forbidden. The actual `L`/`D` and public status shapes are review
gates before hosted implementation, not numbers selected by this documentation change.

## 6. Production encryption and identity

Require TLS 1.3 with mutual certificate authentication on every cross-plane hop, using a
maintained implementation and approved AEAD configuration. Verify certificate chain, service
identity/hostname, environment, Region/cell audience, purpose and validity. A bearer token,
private network or encrypted connection without caller authentication is insufficient. Do not
disable certificate verification, silently downgrade or allow TLS 0-RTT for control mutations.
Any approved proxy must authenticate and re-encrypt the next hop; no plaintext internal leg.
Bound connection reuse/resumption by peer identity/certificate validity and retirement policy;
an old authenticated connection cannot preserve retired authority indefinitely.

Sign persisted commands/policy/leases using vetted signing libraries and managed Global-only
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
ownership/shape, authorization, generation, replay and tenant tests. Test lease timing with
controlled clocks. No environment flag, endpoint or implementation is introduced by this spec.

## 8. Verification and references

Main-spec META-38–45 cover call-direction/egress, pulled recovery, policy publication, lease/
revocation histories, real TLS/identity negatives, local-only relaxation and scaled scheduling.
No check run in this documentation PR proves these new protocols exist or pass.

Primary references checked on 2026-10-29:

- [RFC 8446](https://www.rfc-editor.org/rfc/rfc8446.html): TLS 1.3, certificate authentication and the distinct replay considerations of 0-RTT.
- [RFC 8705](https://www.rfc-editor.org/rfc/rfc8705.html): mutual TLS identities and certificate-bound authorization; this spec does not select an OAuth deployment or permit reverse introspection.
