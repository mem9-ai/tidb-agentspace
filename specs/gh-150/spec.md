# GH-150: Agent-first Workspace journey

- Status: proposed; no behavior in this specification is implemented by this document.
- Parent intent: [GH-150](https://github.com/mem9-ai/tidb.ai/issues/150).
- Source baseline: `f2e5bf692b8e888175716b8d4a6619554b33d489`.
- Scope: Guest onboarding, a real file-based example, explicit agent authorization,
  task evidence, durable results, return and an account handoff.
- Sensitive boundaries: Guest identity and expiry, credential issuance and revocation,
  resource grants, selected-file analysis, audit/content retention and account isolation.
- Dependencies: ADRs 0010, 0017, 0029, 0030, 0033, 0036, 0041 and 0043; OpenAPI,
  product-experience, TiUI and native/browser verification standards.

## Intent and product outcome

A first-time Guest connects an agent they already use to a small US sales sample. The agent
actually reads and analyzes the data, saves an inspectable report, and a separate agent session
continues using the same data and report. A copied instruction, a created Key, a connection, a
simulated timeline or a query alone does not complete the journey. The file and report are real
workspace resources, not a replay or mock.

The first useful result is a durable report based on a verifiable file analysis. Full activation
requires an independent session, with no previous conversation, to read the original data and
report, answer a follow-up question, and save its own result. Measure time to the first report
from the user's initial action, and separately measure time from opening the page. Sixty seconds
is a product target, not a verified guarantee or a reason to omit setup from measurement.

The new sample fixture is separate from existing tutorials: 240 synthetic orders, six US states,
USD line amounts totaling 100,000, with California 48,000, Texas 20,000, New York 12,000,
Washington 8,000, Florida 7,000 and Massachusetts 5,000. The highest California product is
Monitors at 18,000, or 37.5% of California sales. The independently versioned fixture and
expected results must be reviewed before implementation; quantities must not be multiplied
into line totals a second time. The Console must not reveal these answers before execution.

## User journey and requirements

- **AF-01 Entry.** A new visitor sees the value of a workspace and can explicitly start a
  sample Guest workspace or sign in. Sample creation is explicit. Guest expiry is visible as an
  access deadline, not a guarantee of physical provider deletion. Recover an existing Guest in
  the same browser until its original expiry; never extend it by resuming.
- **AF-02 Sample.** Create a versioned US sales CSV with order ID, date, state, product, quantity
  and line sales in USD. It has a meaningful file name, realistic sample data, and deterministic
  independent expected totals. A sample is identified by a durable workspace record and exact
  resource/path/version, never by a user's name or a hash hidden in a display label. Confirm
  creation before redirecting. Re-entry preserves user edits. A missing, changed, partially
  created or unconfirmed sample requires explicit recovery; do not silently overwrite, duplicate
  or automatically replay a potentially completed provider write. Existing tutorials, sample
  IDs, paths, progress and edits remain usable.
- **AF-03 Defaults.** The sample uses the available default file provider and placement. Do not
  ask a first-time Guest to choose a region when no choice is available. Actual provider, data
  location, expiry and limits remain accurate and discoverable in resource Details. A US sales
  sample does not imply US data residency. Do not create a database for this file journey.
- **AF-04 Authorization.** Before issuing agent credentials, show the exact selected sample
  resource, its permitted actions, expiry and revocation. Read and analyze are distinct from
  file write. If enabling file write, state that the current scope permits creation, update and
  deletion within the selected resource; do not claim path-level protection. No other resources,
  future resources, resource creation or Key administration are granted implicitly. Guest
  authority, 24-hour policy and normal server authorization apply to all operations.
- **AF-05 Connection.** Provide a documented, bounded Guest pairing flow for at least one
  actually verified external agent client. User confirmation precedes credential issuance.
  Pairing is single-use, short-lived, bound to the initiating client and exact authorization,
  resistant to replay and cross-workspace redemption, and cannot outlive Guest access. A Key,
  provider credential or bearer-equivalent secret is not embedded in URLs, task prompts, logs,
  screenshots or event history. The connecting agent uses the existing public API authorities;
  no Agent Key gains Owner or Key administration privileges. Copying instructions is not proof
  of connection. Show connection only upon an authenticated request tied to the issued principal.
- **AF-06 Task.** Present the sales question and a copyable agent task with sample identity,
  access requirements and no secrets. The agent discovers the API and permitted capabilities,
  reads the sample, requests read-only analysis, and creates `us-sales-report.md` using the
  supported create-only precondition. Results cite the saved input and actual query/output.
  Existing files must not be replaced. Unknown writes are inspected before any retry.
- **AF-07 Evidence.** The current task shows only authenticated operations with verified
  outcomes: connection, selected-file read/analysis, and confirmed report creation. Do not
  infer an agent vendor from a Key, display invented thinking or claim a write before the
  provider confirms it. Analysis completion and report persistence are separate states. A
  traceable analysis receipt binds the authorized input version, query and returned result to
  this task without leaking data across workspaces. Define retention and access for any saved
  query, result or file content; existing generic diagnostic/audit streams must not silently
  become full content logs. Task correlation from a client is untrusted and never grants access.
- **AF-08 Continue.** A separate fresh agent session reads the original CSV and report and
  answers which product contributes most to California sales. Its task creates a second report
  without reusing the original conversation. Returning to the workspace shows the exact files
  and task state without creating another sample or executing an operation automatically.
- **AF-09 Failure and recovery.** Loading, unavailable provider, expired Guest, failed pairing,
  scope denial, analysis failure, unconfirmed write and revoked/pending policy are distinct.
  Error responses provide stable codes and actionable permitted recovery without exposing
  unauthorized resource existence. Disconnecting an agent revokes that connection; it does not
  sign the Guest out. Revocation is reported applied only after the relevant Region confirms it.
- **AF-10 Own data and retention.** Users can start with their own file under an explicitly
  authorized resource. Sample grants must not silently expand to a different resource. Guest
  files can be downloaded. A proposed account-copy operation requires simultaneous proof of the
  Guest and destination Owner, explicit selected objects, conflict handling and confirmation;
  it never silently adopts resources, Keys or another account. Until that operation exists, do
  not offer a retention promise or imply sign-in preserves the Guest workspace.
- **AF-11 UI.** Use one task-centered workspace with files, selected content and current task
  status; retain reachable resources, tutorials, account, Key and database workflows. Do not
  restore an unqualified global Activity page, hide real provider limitations, or present a
  simulation as a real agent. A user without an external agent can explicitly use the existing
  browser analysis workflow, labeled as such. Show appropriate loading, keyboard, focus,
  light/dark and narrow-screen states.

## API and authority boundary

Existing regional OpenAPI operations remain the authority for resource creation, files,
selected-file analysis, Key grants and conditional writes. The new pairing, task correlation,
analysis evidence and account-copy flows in this section are **proposed**, not implemented
APIs. Complete customer business workflows through documented OpenAPI, not browser-only
actions or Portal automation. The Portal and agent use shared domain operations and backend
authorization. Owner-only Key administration remains Owner-only; Guest delegation must have
its own explicit authority. Paths below are relative to their configured Global or Region API
origin; Portal and Agent route families remain distinct under ADR 0043.

| Outcome                      | Proposed operation and actor                                                                                                                                                                                                          | Effect and recovery                                                                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start sample                 | `startSalesSample`: `POST /api/v1/workspaces/{workspaceId}/sales-sample-attempts`, Agent Token with existing resource-creation authority and required file-write grant; matching Guest/Owner Portal route; explicit `Idempotency-Key` | Persist one resource and sample intent before provisioning. Return attempt identity and observed status; the same intent resolves to the same attempt. No Agent Key may create it without the existing resource-creation authority.                                                       |
| Inspect sample               | `getSalesSampleAttempt`: `GET /api/v1/workspaces/{workspaceId}/sales-sample-attempts/{attemptId}`, same authorized workspace and resource; matching Portal route                                                                      | Return `preparing`, `ready`, `failed` or `outcome_unknown`, selected resource/path and safe recovery. Reconciliation observes existing provider state; it does not replay an uncertain write.                                                                                             |
| Start pairing                | `createAgentPairingAttempt`: `POST /v1/agent-pairing-attempts`, client with workspace ID and verifier challenge                                                                                                                       | Return opaque attempt ID, short user code and deadline; neither authorizes resource access. The stored challenge is bound to the intended Workspace.                                                                                                                                      |
| Review and approve           | `approveAgentPairingAttempt`: `POST /api/portal/v1/workspaces/{workspaceId}/agent-pairing-attempts/{attemptId}/approval`, authorized Guest or Owner browser, verified code and explicit resource/action grants                        | Create a durable approval only for that identity, attempt and exact grant. Account and Guest sessions must use the existing Origin/CSRF protections.                                                                                                                                      |
| Redeem pairing               | `redeemAgentPairingAttempt`: `POST /v1/agent-pairing-attempts/{attemptId}/redemptions`, verifier-bearing client                                                                                                                       | Issue the one-time scoped credential only after valid approval. Return a stable replay/expiry/denial error without a second credential; an unknown response requires observe/revoke and a new attempt.                                                                                    |
| Inspect or revoke connection | Existing Owner/Guest Key inspection and revocation, via the configured Global Portal                                                                                                                                                  | Return pending or applied Region policy status and preserve the existing revocation fence. Pairing does not create a new Key-management privilege for the agent.                                                                                                                          |
| Create and inspect task      | `createAgentTask`: `POST /api/v1/workspaces/{workspaceId}/agent-tasks` and `getAgentTask`: `GET /api/v1/workspaces/{workspaceId}/agent-tasks/{taskId}`, scoped Agent Token with matching Portal routes                                | Persist or inspect a versioned task bound to the authorized resource and its creating agent principal; a Guest/Owner session may explicitly select the issued principal. Duplicate creation uses the same client idempotency key. A missing or different-workspace task is not disclosed. |
| Associate actual work        | Existing `analyzeFile` and conditional `writeFile`/`uploadFile` operations accept an optional `X-Workspace-Task` task reference; no extra Agent-only Portal route                                                                     | Recheck the Key's workspace, exact resource and action for each operation. Server records only verified outcomes bound to that principal; a missing or invalid reference never widens access or invents results.                                                                          |
| Inspect evidence             | `getAgentTaskEvidence`: `GET /api/v1/workspaces/{workspaceId}/agent-tasks/{taskId}/evidence`, scoped Agent Token; matching session-only Portal route for the user                                                                     | Return bounded actual input version, analysis/result receipt and report-write status. Require current read/analyze grants on the task resource; filter or deny unauthorized content.                                                                                                      |
| Prepare account copy         | `prepareGuestCopy`: `POST /api/portal/v1/workspaces/{workspaceId}/guest-copy-preparations`, authenticated Guest, exact selected paths and versions                                                                                    | Create a short-lived, single-use, server-held preparation without exposing a bearer secret in a URL. It does not log out or transfer ownership.                                                                                                                                           |
| Copy to account              | `commitGuestCopy`: `POST /api/portal/v1/workspaces/{workspaceId}/guest-copies`, authenticated destination Owner, prepared Guest proof, reviewed destination and explicit confirmation                                                 | Copy only prepared files with create-only preconditions. Return a durable attempt ID; inspect the attempt before recovery from partial or unknown effects. Never copy credentials or overwrite existing files.                                                                            |
| Check account copy           | `getGuestCopy`: `GET /api/portal/v1/workspaces/{workspaceId}/guest-copies/{copyId}`, authorized destination Owner                                                                                                                     | Report preparing, completed, partial, denied or outcome unknown with only authorized destination identity; an incomplete result is never reported as complete.                                                                                                                            |

New business resource names, JSON schemas and exact error/status codes must be finalized in the
reviewed OpenAPI amendment before the relevant implementation task starts. The table defines
the required separation of authority and effects; it does not authorize widening any existing
Key grant or using an untrusted client-reported event as evidence.

The proposed pairing resource is created by the local agent client with a cryptographically
random verifier retained by that client; the server stores only its digest. The Guest browser
locates the short-lived attempt using a separate human-readable code and authenticates as the
owning Guest. It displays and explicitly approves the exact resource and action grants. The
attempt expires within five minutes or at Guest expiry, whichever comes first, and rejects
cross-workspace approval, reused/expired codes and verifier mismatches. Restrict attempts and
redemptions by workspace and origin/peer as appropriate. After approval, a single atomic
redemption bound to the verifier issues the minimum Guest-scoped credential. Browser approval,
issuance and consumption are durable and fenced. A lost redemption response has an unknown
outcome: observe/revoke the associated credential and start a new attempt rather than minting
another automatically. Sign-out and actual expiry revoke the Guest policy independently of
the pairing lifetime. This requires an ADR and a reviewed public OpenAPI contract.

A task is an authorized, workspace-scoped record bound to the selected resource and issued
agent principal, with a version, lifecycle state and explicit retention deadline no later than
Guest expiry. An operation is associated using a task reference, but authentication and grants
are checked independently. Record a successful input read or file analysis only after the
actual domain operation resolves the selected resource and version; record a report only after
the conditional write is acknowledged. Store the query and bounded result only with explicit
task participation, using the workspace's existing protected metadata/storage boundary, and
require current resource read/analyze grants to retrieve them. Do not put content into ordinary
audit or diagnostics. Store only the minimum needed to inspect the current task, remove it at
the task retention deadline, and report inconclusive outcomes without inventing provenance.
The authorized Workspace owner and the associated agent can inspect a task; a new scoped agent
session can independently use its saved files without inheriting the original conversation.

Customer SQL and Bash remain bounded read-only selected-file execution; provider credentials
never enter agents or workers. Browser-only behavior is limited to presentation, local clipboard
and the file chooser. Actual data location and quotas follow the active provider. No credentials
are transferred to a different client or account as part of copying files.

## Independent acceptance baseline

| ID     | Observable acceptance                                                                                                                                                                                                                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AF-A1  | Explicit Guest start creates at most one sample; opening or refreshing does not create or run anything. Two Guest workspaces remain isolated.                                                                                             |
| AF-A2  | Expected US sales totals and the California product result are checked against a separately defined fixture; no result is printed before execution.                                                                                       |
| AF-A3  | A real agent client obtains a scoped credential only after approval, reads the selected sample, executes analysis and creates a report through public APIs. Wrong resource, scope, expired/revoked Guest and replayed pairing are denied. |
| AF-A4  | The reported input/version, query/result and created report correspond to the actual operations; pending, denied, failed and unknown outcomes never appear as successful writes.                                                          |
| AF-A5  | Report acknowledgement survives service restart. A fresh independent agent session, without previous conversation, reads the exact sample and report and creates a follow-up report.                                                      |
| AF-A6  | Concurrent sample start, lost create responses, file version conflicts, failed analysis, cancellation, interrupted writes and unavailable storage preserve data and expose safe recovery without automatic replay.                        |
| AF-A7  | Existing tutorial progress, samples, user edits, existing MySQL/PG/DuckDB resources and credentials remain accessible; new defaults do not move data or broaden grants.                                                                   |
| AF-A8  | Explicit account copy cannot adopt another Guest, overwrite an existing destination, copy secrets, or claim completion after a partial/unconfirmed write. Logout and revocation preserve their documented semantics.                      |
| AF-A9  | Assertion-driven Console checks cover first entry, authorization, actual task states, return and failures in desktop/narrow and light/dark themes. Representative screenshots supplement behavior assertions.                             |
| AF-A10 | Record cold and warm times, including Guest creation, provisioning, pairing, agent execution and confirmed report; report the observed distribution without fabricating a 60-second result.                                               |

## Delivery boundaries

Follow the shared GitHub contribution workflow: review and merge this design separately,
record its immutable accepted revision, then implement bounded changes against that revision.
Separate planned contracts from implemented status. Native API acceptance covers authorization,
effects, durability and recovery; Console checks cover rendered interaction. Run `npm run check`,
`npm run backend:check` for affected Rust behavior, and the affected assertion-driven browser
suite before claiming readiness. CI uses isolated fixtures and no cloud credentials. Live
provider and real-agent evidence are separately identified, with source and deployed revisions.

Turso/SQLite integration, universal filesystem mounts, a new global Activity page, automated
cloud-agent execution, workspace-wide file/database snapshots and database provider migration
are out of scope. A mock or a local result alone cannot establish the real-agent aha.
