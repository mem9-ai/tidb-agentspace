# GH-159: Agent sales task and verified evidence

- Status: draft for review; the task, correlation and evidence APIs below are not implemented.
- Task: [GH-159](https://github.com/mem9-ai/tidb.ai/issues/159); parent: [GH-150](https://github.com/mem9-ai/tidb.ai/issues/150).
- Accepted journey: [GH-150 at `5ea06a3f9edfb6dbf471c217ee2cd1b112888ee1`](https://github.com/mem9-ai/tidb.ai/blob/5ea06a3f9edfb6dbf471c217ee2cd1b112888ee1/specs/gh-150/spec.md), especially AF-06 through AF-09 and AF-A3 through AF-A6.
- Source baseline: `10b9d68`. Depends on the durable sample in GH-171 and on a separately reviewed and implemented scoped Agent connection in GH-158. This draft cannot by itself establish the Aha.

## Outcome

A user asks an actually connected Agent to analyze a saved US sales file. The Workspace shows only operations authenticated as the selected Agent: a completed input read, the actual selected-file query and bounded result, and an acknowledged create-only report write. The user opens the saved report and can invite a new Agent session to continue using both files. The first useful result is a durable, inspectable report backed by an actual analysis. Full activation additionally requires a separately verified fresh Agent session to read the original data and report and save its follow-up answer.

A copied prompt, a prefilled result, an invented timeline, a file with the expected name, an unacknowledged write or a successful SQL query alone is not the outcome. The UI does not show fixture answers before execution and does not claim that the report's reasoning is correct merely because the file exists. A receipt proves the operation and returned data; the user can inspect the query, result and report.

## Current capabilities and dependencies

- The Guest can explicitly create and return to a durable, versioned `us-sales-v1` file. The first version is recorded separately from later edits. GH-171 does not attribute a report to an Agent.
- Global Keys and regional read-only selected-file analysis exist. A Key's resource and action grants are enforced by Region; a Key does not grant Owner or Key-administration authority.
- GH-158 pairing, its verified connection receipt and the concrete external Agent adapter remain proposed. Their final authority and Key-version contract must be accepted before implementation here.
- Generic audit and request history are not a task receipt. Do not silently put query text, result rows, file contents or prompts into either stream.

## Proposed task lifecycle

An explicitly authorized Agent creates a workspace-scoped task bound to the exact File System ID, sample path, original file version, task kind and its authenticated Key ID, Key version and principal. The server verifies the requested resource, path and version against the durable sample record and the current file metadata; it never trusts the client-supplied version as proof. The user can inspect that task through an Owner/Guest regional Portal route. Agent and Portal operations share domain rules but do not share credentials. The Agent must currently have the resource grant and `files:read`, `files:analyze` and `files:write`; the file-write scope permits create, update and deletion within the selected File System and is not a path-level restriction. The Owner's approval and Region policy remain independent of a task reference.

Task creation is explicit, uses a caller-scoped idempotency key and commits its identity before effects. Same-key replay returns the same task without executing a query or writing a file. A different body under the same key conflicts. Bound the number of tasks, pending writes and evidence bytes per Workspace; an exhausted or unavailable metadata store fails before an external write. A missing, edited, deleted or unverifiable sample requires inspection and explicit recovery; do not silently restore it or use another file as though it were the original sample.

A task proceeds through independently evidenced stages: `waiting`, `input_read`, `analysis_completed` and `report_saved`. A denial, failure or unknown result is represented explicitly and cannot be promoted to a successful later stage. A server must not infer an Agent vendor, thought process or authorship from a file name. The Portal does not initiate data operations merely by opening or refreshing the page.

## Operation and authority map

All paths below are proposals, not published APIs. A separately reviewed machine-readable OpenAPI amendment and any required ADR must precede implementation.

| Outcome            | Proposed operation                                                                                                               | Authority and effect                                                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create a task      | `createAgentTask`, `POST /api/v1/workspaces/{workspaceId}/agent-tasks`                                                           | Scoped Region Token with current read, analyze and write grants on the exact sample File System. Create a durable principal-bound task; no query or file write.                                                   |
| Inspect a task     | `getAgentTask`, `GET /api/v1/workspaces/{workspaceId}/agent-tasks/{taskId}` and matching Owner/Guest Portal GET                  | Current authorized Agent or matching regional Owner/Guest; cross-Workspace and unauthorized tasks are not disclosed.                                                                                              |
| Associate a read   | Existing selected-file read accepts optional `X-Workspace-Task`                                                                  | Authenticate and authorize independently. Only the task's bound principal, resource and path may produce a read receipt.                                                                                          |
| Associate analysis | Existing `analyzeFile` accepts optional `X-Workspace-Task`                                                                       | Recheck current `files:read`, `files:analyze` and the task binding. Record only after the actual bounded read-only computation returns.                                                                           |
| Associate report   | Existing conditional `writeFile` or upload accepts optional `X-Workspace-Task`                                                   | Recheck `files:write`, exact task/principal and allowed report path. Create-only precondition is mandatory. Record success only after the provider acknowledges the write and its resulting version is confirmed. |
| Inspect evidence   | `getAgentTaskEvidence`, `GET /api/v1/workspaces/{workspaceId}/agent-tasks/{taskId}/evidence` and matching Owner/Guest Portal GET | Require current read and analyze access on the resource; return only the bounded evidence authorized for that task.                                                                                               |
| Continue           | A new task in a fresh Agent session with an authorized scoped connection and an explicitly selected saved report                 | The new Agent reads the saved CSV and report, performs its own analysis and creates `/us-sales-follow-up.md` without overwriting an existing file.                                                                |

A task header is only an untrusted correlation hint. It does not authenticate an Agent, select another Workspace, grant access, override a resource check or authorize content capture. Invalid, expired, revoked, mismatched or unauthorized references fail before recording any receipt or performing an otherwise unauthorized effect. Normal non-task APIs preserve their current behavior and permissions.

## Evidence fidelity

A completed input-read receipt must identify the actual resource, path and version served under the authenticated principal. Server-side completion cannot prove the model understood or reasoned over the bytes; use wording such as **Read request completed**, not invented thinking. A disconnected response, an unverified version or a client assertion is not a completed read. Any streaming completion semantics must be specified before shipping.

Analysis records the actual selected-file snapshot version, engine, query, bounded result and completion time, after the existing read-only worker and current authorization succeed. The selected-file snapshot must expose its version from the same verified snapshot that the worker executed, not a later metadata lookup that can race an edit. Store the exact returned result or a clearly labeled bounded subset with a truncation indicator; never display a subset as the complete result. A task-correlated analysis that cannot retain the required receipt must return a truthful failure or unknown state, not a fabricated completion. A replay, timeout or failed computation does not create another successful analysis receipt automatically.

Before report I/O, record a durable intent with task, principal, target path and content digest. Use the existing create-only precondition. Record a completed write only after the provider confirms the effect and the implementation can bind the observed file version to that acknowledged write. A later file with the same name, a client-reported success or a metadata lookup after an intervening edit is insufficient. An unknown result remains unknown; inspect the recorded target and preserve edits rather than reissuing a write. A conflict never overwrites the prior report.

The receipt establishes who made an authenticated operation under which grant, what input version and query were used, what result was returned, and which report write was confirmed. It does not prove the report accurately summarizes the result, that a vendor name is true, or that the model's internal reasoning is known.

## Retention and confidentiality

Task participation is explicit because the task receipt contains the user's query and bounded result. Store it only in the existing protected Workspace metadata boundary with a documented byte and record quota, current authorization checks and a retention deadline no later than Guest access expiry. Exclude SQL, result rows, prompts, file bytes, credentials and raw provider errors from ordinary audit, request history and diagnostics. Return a typed redacted error on unavailable retention; do not silently fall back to a less protected store. Expired tasks are inaccessible and cleaned in bounded batches; do not promise immediate deletion of historical object-store versions.

A report file remains a normal Workspace file under its existing policy. Sign-in does not automatically preserve a Guest file; explicit download is available and account copy is a separate GH-160 capability. No task, evidence record or Agent Key crosses into another Workspace or account without a separately reviewed operation.

## Fresh-session boundary

The follow-up asks which product contributes most to California sales. It must be answered using the saved input and report, with its own analysis and create-only `/us-sales-follow-up.md`. The fresh session starts its own task and uses an authorized scoped connection rather than inheriting a previous task's authority. It may reuse an unexpired Key that the user already authorized or connect a new one; neither a second Key nor a second connection proves that an LLM has forgotten a prior conversation. Full acceptance must use an independently started Agent session with an isolated conversation and record the client, source/deployed revisions and actual outcome. The Console may offer a follow-up task; it must not claim fresh-session success solely from a filename or self-reported client state.

## Required acceptance

1. Guest and Agent use the exact original sample. Wrong Workspace, resource, principal, version, scope, expired Guest and revoked Key are denied without cross-Workspace disclosure or upstream effects.
2. An actual external Agent reads the sample, executes a read-only query and conditionally creates the report through documented APIs. The visible receipt equals the actual input version, query and result; the user can inspect the saved report. No answer is printed beforehand.
3. Simultaneous requests, changed input, failed analysis, client cancellation, output limits, unavailable metadata, file conflict, provider timeout and lost write acknowledgment remain distinct and do not invent completed writes or replay uncertain effects.
4. Restart preserves acknowledged task and receipt. A truly fresh isolated Agent session reads both original files and saves a separate follow-up. The verification does not treat a second token alone as proof of an independent conversation.
5. Evidence is bounded, protected, unavailable after Guest expiry and absent from generic logs/history. Denied principals cannot obtain query, result or other Workspace existence. Cleanup and object-store version limitations are documented.
6. Browser assertions cover first entry, real operation states, revoke/pending, errors, return, keyboard and desktop/narrow light/dark. Timings include Guest creation, provisioning, authorization, Agent work and confirmed write; a 60-second target is not a claim without measured evidence.

## Open implementation gates

The exact receipt schemas, byte/record quotas, version-bearing snapshot and acknowledged provider-write result, streaming-read completion semantics, Guest policy fencing and agent/client handoff require a reviewed OpenAPI amendment and ADR before implementation. GH-158's final pairing contract and real-client adapter must be stable first. Until then, preserve the honest current manual-Key journey and report-file observation; neither establishes this feature.
