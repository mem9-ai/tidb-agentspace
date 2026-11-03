# ADR 0046: Task-bound Agent evidence

- Status: proposed for [GH-159](https://github.com/mem9-ai/tidb.ai/issues/159); no task or evidence behavior is implemented by this decision.
- Date: 2026-11-03.
- Extends ADRs 0010, 0017, 0036, 0043 and 0044 and the accepted [GH-150 journey](../../specs/gh-150/spec.md).
- Depends on a separately reviewed and implemented GH-158 Agent connection. The pairing draft is not an accepted implementation baseline.

## Problem

A user needs to see that an Agent actually used a saved file and delivered a result, without trusting a client-reported timeline or exposing private SQL and results in generic history. Existing selected-file analysis and create-only writes work independently, but they do not bind an input version, query, output and confirmed report to one Agent task. A same-named file, copied prompt or Key creation is not evidence of an Agent's work.

## Proposed decision

Introduce explicit regional task records and bounded evidence accessible only to the matching Owner/Guest or currently authorized task principal. Derive the Agent principal and Key version from trusted regional authentication. Recheck the Workspace, resource, actions and live policy for each operation; an optional task reference is only a correlation hint and grants no authority.

For opted-in task operations, record only server-confirmed outcomes. A read receipt identifies the actual file version served. Analysis records the version of the same selected snapshot executed by the bounded read-only worker, the query and returned result. A report write records a durable intent before I/O and success only when the create-only provider write and its resulting version are confirmed. A lost response or unconfirmed provider effect remains unknown and is inspected before any recovery; never blindly repeat it. The Console distinguishes reading, analysis and report completion and never invents a vendor, model reasoning or report authorship from a filename.

User-authorized task evidence may contain query text and bounded output. Encrypt it within the existing Workspace metadata boundary, require current resource permissions, bound records and bytes, and expire it no later than Guest access. Ordinary request history, audit events, metrics and diagnostics never become content logs. Storage failure is explicit and cannot silently downgrade retention or make an unconfirmed side effect appear successful.

A fresh Agent session may reuse an authorized Key or obtain a separate one, but always creates its own task and uses existing files under its current permissions. A second Key or client assertion does not prove that the model has no prior context. The product may invite a follow-up; independent activation evidence requires an actually separate Agent conversation and its own saved result.

## Consequences and gate

This proposal introduces retained user content, optional correlation on existing public operations, task-bound state and provider acknowledgment requirements. It does not broaden Key authority, imply physical deletion of historical storage versions, infer the correctness of a report, or silently copy Guest data to an account.

The [task-evidence contract draft](../../specs/gh-159/task-evidence-contract.md) lists intended behavior and acceptance cases. Before implementation, review a machine-readable OpenAPI amendment and precise retention quotas, determine how selected snapshots and provider writes expose authoritative versions, and specify streaming-read completion and unknown outcomes. Verify cross-Workspace isolation, permissions, replay, cancellation, failure, conflicts, revocation, restart and bounded cleanup in native APIs. A separate real external Agent and isolated fresh session must be tested; browser fixtures are not that evidence.
