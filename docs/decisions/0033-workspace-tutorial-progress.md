# ADR 0033: Workspace-owned tutorial progress

- Status: Accepted owner correction, [GH-83](https://github.com/mem9-ai/tidb.ai/issues/83).
- Date: 2026-10-31.
- Baseline: `453ffc1`; extends the executable tutorials from PRs #79 and #80.

Tutorials must follow the Workspace across browsers and sessions. Browser storage cannot be
the authority for sample identity, uncertain writes, readiness or completion. These are
navigation bookmarks reported by the Owner, not saved query results or an execution audit.

Store one current bookmark per public resource in the existing encrypted regional Workspace
record repository, outside the bounded bootstrap projection. GET `/tutorials` uses resource-ID
ordering and cursor pagination (100 records per page maximum); GET/PUT `/tutorials/{resourceId}`
observes or replaces a bookmark. Paths are relative to `/api/v1/workspaces/{workspaceId}`.
They require the existing authenticated Owner mode, including its Workspace, expiry,
revocation and managed-policy checks. Workspace Keys gain no permission. Writes validate
public resource membership without provider I/O; no backing filesystem becomes a resource.

A bookmark records `resourceId`, a validated 32-character hexadecimal `sampleId`, the state
`pending`, `attempted`, `ready` or `completed`, `updatedAt` and an opaque strong `version` ETag.
PUT requires `If-None-Match: *` for creation or the last version in `If-Match` for replacement.
Missing conditions return 428; malformed conditions return 400; stale conditions return 412
without a mutation. The writer fence, repository queue and native expected-version commit
preserve compare-and-replace semantics. No stale browser silently replaces a newer sample.
An explicit new sample replaces the bookmark while keeping previous sample data intact.

The Console loads Workspace state before enabling tutorial actions. It waits for a durable
`attempted` acknowledgement before issuing any sample-data write, then acknowledges readiness
and verified completion separately. Failure after a sample write leaves an inspectable attempt.
Missing/unknown progress acknowledgements observe current state but never replay a mutation or
sample write automatically. Reads, resumes and migrations do not query or seed sample data.
Unavailable progress has explicit retry UI; browser-only fallback cannot authorize a write.

Migrate valid previous browser records only for current Workspace resources and only when the
Workspace has no bookmark, using create-only PUT. Existing Workspace state wins, including a
concurrent migration conflict. Preserve the exact sample ID and uncertain state. Retain the
old browser copy for recovery if migration fails; it is never the ongoing authority. Old
unscoped session keys apply only to their original `ws_agentlab` Workspace. Selection/theme
preferences and unsaved query drafts remain presentation state.

Native acceptance covers two Workspaces with colliding resource IDs, owner-only denials,
malformed inputs/conditions, stale/concurrent writes, pagination, crash/restart durability
through embedded and remote Meta, and absence of provider I/O. Browser acceptance uses a
second isolated context with empty browser storage, retains both original samples and reruns
queries explicitly; it also covers migration and failed/unknown persistence acknowledgements.
See [tutorial verification](../tutorial-verification.md). No dependency, credential, data reset,
saved-result service or new background worker is introduced.

Deliver the additive native API before the new Console. A Console against an older API shows
the recoverable progress error and never silently falls back to browser authority. Old Console
progress can migrate on its next visit after upgrade. Rollback does not delete bookmarks or
sample data. Revisit for collaborative tutorial history, account export or shared saved results.
