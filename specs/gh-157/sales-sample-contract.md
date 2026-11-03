# GH-157: durable US sales sample contract

- Status: proposed; these operations and states are not implemented.
- Task: [GH-157](https://github.com/mem9-ai/tidb.ai/issues/157); parent: [GH-150](https://github.com/mem9-ai/tidb.ai/issues/150).
- Accepted journey: [GH-150 at `5ea06a3f9edfb6dbf471c217ee2cd1b112888ee1`](https://github.com/mem9-ai/tidb.ai/blob/5ea06a3f9edfb6dbf471c217ee2cd1b112888ee1/specs/gh-150/spec.md), especially AF-02, AF-03, AF-09 and AF-A1, AF-A2, AF-A6, AF-A7.
- Source baseline: `9a766ba12573fc09a0338abade4f5b20b00f867f`.
- Machine-readable design amendment: [OpenAPI proposal](openapi-proposal.yaml). It is not the
  generated or published service contract.

## Outcome and boundary

An explicit request prepares one file containing the separately reviewed `us-sales-v1`
fixture in a default File System. This is a real workspace file, not browser state or a
simulation. Creating a sample never creates a database. Opening or refreshing a page does not
start an attempt. Existing tutorials and their resource-scoped bookmarks remain independent.

Region owns these resources. Agent and Portal endpoints below invoke the same domain operations,
with their existing, mutually exclusive Region Token and session authentication. API roots and
relative `Location` handling follow ADR 0043 and the REST standard. This amendment does not
alter Global identity or give a Key owner authority.

## Proposed representations

Paths below omit `/api/v1/workspaces/{workspaceId}` for Agent and
`/api/portal/v1/workspaces/{workspaceId}` for Portal. Both surfaces expose the same JSON shapes.
The generated Agent OpenAPI, Portal contract, generated clients and implementation must change
together only when the implementation lands; this document is not an advertised live API.

`SalesSampleAttempt` is an object with exactly these fields:

| Field                    | Type             | Meaning                                                                   |
| ------------------------ | ---------------- | ------------------------------------------------------------------------- |
| `id`                     | string           | Server-generated canonical lowercase UUID, stable across observations.    |
| `fixture`                | string           | Exactly `us-sales-v1`; this is a versioned dataset identity.              |
| `status`                 | enum             | `preparing`, `ready`, `failed`, or `outcome_unknown`.                     |
| `resourceId`             | string or null   | Selected File System ID, once durably recorded.                           |
| `path`                   | string or null   | Exact absolute workspace path, once durably recorded.                     |
| `fileVersion`            | string or null   | Provider-confirmed opaque conditional-write version for the created file. |
| `errorCode`              | string or null   | Stable safe failure code; never a provider credential or file content.    |
| `createdAt`, `updatedAt` | RFC 3339 strings | Server timestamps.                                                        |

`ready` requires non-null resource, path and confirmed version. A resource or path in any other
state is an observation, not a claim that the file exists. A later user edit does not change the
recorded initial version or authorize replacement. Clients read file metadata to discover its
current version. The file path is `/us-sales.csv` in the newly created sample File System;
the response, not a display name, is authoritative.

## Create and observe

### `POST /sales-sample-attempts` — `startSalesSample`

Requires `Content-Type: application/json`, an `Idempotency-Key` containing a canonical lowercase
UUID, and exactly:

```json
{ "fixture": "us-sales-v1" }
```

An authorized Portal Guest or Owner explicitly creates the attempt. A Region Agent Token must
have `resources:write`, `files:read` and `files:write`, with `*` in its resource grants: the existing
creation rule requires the workspace-wide grant because the new resource does not yet exist.
No new Key administration or owner privilege is implied. The server checks current Workspace
identity, Guest expiry, resource and action authority before each operation. Guest authority does
not outlive its existing policy. These Agent scope requirements must be represented in OpenAPI
and tested against current Principal enforcement before shipping.

The server atomically records the workspace, fixture identity, caller, idempotency binding,
attempt and unique active sample slot before provider effects. The idempotency key binds the
authenticated caller, operation and normalized body. Same caller, key and body returns the same
attempt without initiating another effect; reuse with a different body returns `409
IDEMPOTENCY_CONFLICT`. Concurrent requests, including distinct keys, cannot create two samples
for the same workspace and fixture: an unavailable slot returns `409 SAMPLE_SLOT_UNAVAILABLE` with
no undisclosed resource information. A retry can obtain an authorized attempt by its previously
returned ID; a lost initial response is recovered by repeating its original idempotency key.

Return `201 Created`, a relative `Location` pointing to the attempt, and
`{"data": SalesSampleAttempt}` after the record is durable. An initial `preparing` response
does not promise a background worker or a completion time. Provider effects use the selected
default provider and configured placement; actual location remains in resource Details. Record
the resource identity and write intent before each external effect. Use conditional create-only
file writes, never overwrite a pre-existing path, and persist a confirmed file version before
reporting `ready`.

A same-key replay returns `200 OK` with the same relative `Location` and the current recorded
representation. It does not resume a stalled provider operation. If the process stops during
`preparing`, the UI must treat progress as unconfirmed and provide an inspection path; it must not
show an indefinitely advancing animation as evidence that work is still running.

Malformed body returns `400 INVALID_INPUT`; missing idempotency key returns `400
IDEMPOTENCY_KEY_REQUIRED` and a malformed key returns `400 INVALID_IDEMPOTENCY_KEY`;
unauthenticated requests return `401 UNAUTHENTICATED`; missing
authority returns `403 FORBIDDEN`; expired Guest policy returns the existing session/token error;
unavailable durable metadata returns `503 SERVICE_UNAVAILABLE`. Error envelopes follow the
existing regional contract. No response contains provider credentials or sample answers.

### `GET /sales-sample-attempts/{attemptId}` — `getSalesSampleAttempt`

An authenticated Guest or Owner for the workspace can observe the attempt. An Agent Token may
observe a `preparing` attempt without a resource only if it has `resources:write`, `files:read`,
`files:write` and the workspace-wide grant. Once the resource is recorded, an Agent Token needs `files:read`
and a grant for that exact resource. Return `200 {"data": SalesSampleAttempt}`. A missing or
unauthorized ID returns the existing non-disclosing `404 NOT_FOUND`; expired or revoked access
follows normal authentication policy. This operation does not provision, upload, retry, reconcile
or mutate state.

### `GET /sales-sample-attempts?fixture=us-sales-v1` — `listSalesSampleAttempts`

Return `200 {"data": [SalesSampleAttempt]}` with zero or one entry for the current workspace's
active fixture slot. The `fixture` query parameter is required and must equal `us-sales-v1`;
unknown or extra parameters return `400 INVALID_INPUT`. Apply the same observation authorization
as the individual GET, omitting an inaccessible entry rather than revealing its existence.
This bounded, read-only lookup allows a returning browser to find the same attempt without
relying on local storage or creating another one. It does not include old tutorial records.

## Recovery, safety and implementation gate

`failed` means a confirmed failure and `outcome_unknown` means an external effect might have
occurred without acknowledgement. A GET never replays either. An explicit recovery operation
must first inspect the already recorded resource and exact path, preserve customer edits and
never blindly issue another provider write. Its URI, authority, response schema and effects
require a separately reviewed contract amendment before it is exposed. Until recovery exists,
the UI must state the uncertainty and offer inspection or download where permitted; it must not
offer an unsafe retry or silently abandon a possibly created resource.

The active slot and idempotency indexes must survive process restart and concurrent requests,
use the existing workspace-scoped writer fence, and expire no earlier than their Guest policy.
Removing an expired Guest follows existing cleanup; this document does not promise immediate
physical provider deletion. Bounded Guest retention and account copying are separate contracts.
Provider location is independent of the dataset's US geography.

Before implementation, review this amendment against existing create-resource idempotency,
Guest policy propagation, metadata consistency and provider acknowledgement semantics. Resolve
any conflict by amending this design and its accepted revision, not by weakening the failure or
authorization guarantees. Native HTTP acceptance must cover exact fixture and separate expected
totals, two-Guest isolation, simultaneous starts, replay and conflicting idempotency keys, lost
responses, provider failure, uncertain writes, restart, user edits, expired/revoked access,
existing tutorials and both Agent and Portal authorities. Browser acceptance must cover explicit
start, truthful progress, return, keyboard and responsive themes. The complete aha additionally
depends on pairing and verified agent evidence; this contract alone does not establish it.
