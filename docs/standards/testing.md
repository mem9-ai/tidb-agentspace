# Test selection and the classic core

Status: accepted direction for the testing redesign. Existing commands and CI gates remain in
force until the corresponding implementation is reviewed and merged; this document does not
claim a new fast path is already active.

Testing time is part of delivery cost. Run the smallest set that establishes the behavior and
risk of the change. Reuse a traceable passing result while its code, inputs and environment
remain applicable. Do not rerun unrelated checks or add tests that only repeat implementation
details. A skipped case is not a pass, and uncertainty never authorizes skipping a security or
persistence boundary.

## Four categories

| Category                   | Purpose                                                                                                                                                        | Default use                                                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static and contract checks | Runtime, repository policy, formatting, lint, types and generated-contract consistency.                                                                        | Run the checks affected by a change, plus any required delivery gate. Documentation-only edits do not build or test the application.                                                         |
| Classic core               | A small, stable set proving the Workspace can be entered, a scoped Key used, data queried, files read and analyzed, and tutorials started and resumed.         | Default for recognized product changes. Run one representative backend mode and one desktop browser configuration unless the change calls for more.                                          |
| Risk-specific suites       | Authorization, tenant isolation, storage/recovery, database, File System, tutorials, accessibility, browser layout, provider, packaging and release scenarios. | Add only suites affected by the change. Security, isolation, durability and side-effect assertions are mandatory when their boundaries change.                                               |
| Full regression            | All applicable modes, providers, browser cases, scale, slow expiry/recovery tests and delivery checks.                                                         | Run for ambiguous or cross-cutting changes, baseline and gate changes, or a release when no equivalent trusted evidence exists. Offer an explicit full run; never disguise a subset as full. |

The categories overlap intentionally. A selected case runs once even if it belongs to more than
one suite. Changing a test or fixture selects the cases that depend on it; changing the selector,
workflow, dependencies, security policy or an unknown path falls back to the full relevant gate
until proven safe. Check exact renamed and deleted paths and use trusted-base selection so a PR
cannot authorize its own skip. A failed, skipped, missing, renamed or unexecuted required case
fails the selected profile. Main, deployment and protected-release requirements remain unchanged
until separately reviewed, evidence-backed changes are merged.

## Classic core acceptance

The core is a product journey, not a list chosen merely for speed. Its implementation must prove:

1. An owner can enter a Workspace, create/use a scoped Key, and cannot access another Workspace
   or an ungranted action. Invalid and revoked access is denied without exposing credentials.
2. A database has usable sample data and returns a query result. A File System can save and
   inspect representative content and run bounded SQL and Bash analysis, with unauthorized
   access rejected before provider I/O.
3. A database tutorial and File System tutorial reach a useful result; Workspace-backed progress
   can be reopened and resumed without replaying sample writes.
4. A representative durable write survives restart and the owner can read it in the right
   Workspace. The core uses isolated, disposable local services and never production data.
5. A representative Console journey works at a desktop viewport. A changed interface is also
   inspected in Light and Dark at the required desktop and narrow sizes; the additional visual
   review is selected by the change rather than run for every unrelated backend edit.

Reuse existing real behavior assertions where they satisfy these requirements. Candidate native
cases include the remote-mode data/analysis/credential journey, Workspace tutorial progress,
owner/Key contract and the two-Workspace restart case. Candidate browser cases include Guest
entry, scoped Key creation, database first query, inline file flow and cross-browser tutorial
resume. Inventory and measure them before freezing the manifest; a candidate name alone does
not prove all acceptance cases. If a journey is not covered, add a focused assertion rather
than claiming coverage or silently widening the profile.

## Risk-specific additions

| Changed boundary                                       | Additional evidence                                                                                                                                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication, sessions, Keys, grants or authority    | Valid/invalid, expired and revoked credentials; cross-Workspace and resource/action isolation; no sensitive values or upstream I/O on denial; relevant SSO/Guest and token cases.                        |
| Metadata, journal, object storage, queues or retention | Atomicity, conflict/fencing, bounded capacity and pagination, restart/recovery, tenant isolation, loss/unknown outcomes and no automatic replay. Exercise isolated RustFS where persistence is relevant. |
| Database, SQL, imports or exports                      | Appropriate database modes, read-only enforcement, type/format fidelity, provider failure and uncertain effect, scoped access and replay/confirmation semantics.                                         |
| File System, preview, SQL/Bash analysis or providers   | Relevant content types, size limits, read/analyze grants, bounded execution, conditional writes, isolation, failure and provider credential boundaries.                                                  |
| Tutorial, samples or Workspace progress                | First useful result, database and file examples as applicable, resume across browsers, idempotent sample creation and uncertain-write recovery.                                                          |
| Console UI and accessibility                           | Changed journey, keyboard/focus and responsive Light/Dark inspection; add the relevant browser suite without treating a screenshot as behavior evidence.                                                 |
| CI, build, dependency, contract or deployment policy   | Selector fallback and tamper cases, all affected contracts and applicable complete build/release checks. Do not let a partial PR profile authorize production or deployment by itself.                   |

An explicit maintainer/user request for full regression takes precedence. A critical incident or
release may require more coverage than the default; record the reason and exact source revision.
For a local or CI result, report the profile, selected cases, actual result, versions and material
limits. Do not report fixture-backed behavior as a live cloud test.

## Implementation and evidence gates

A reusable runner and CI selector must provide stable named profiles, deterministic membership,
change-to-suite mapping, de-duplication and a clear explanation of what ran or was skipped.
Test the selector against mixed paths, renames, missing inputs and changes to its own rules.
Verify each required case actually executed. Compare timings on the same kind of runner with
cold/warm cache conditions stated; local and GitHub timings are not interchangeable. Keep the
full profile available and run it at a reviewed cadence and for applicable release gates.
Cross-commit reuse must separately prove that the tested merge candidate and delivered tree,
trusted workflow, test selection and run attempt match; see [ADR 0027](../decisions/0027-single-ci-evidence.md).

The implementation acceptance cases are:

- **TEST-1 — default core:** a recognized product change runs the core with its selected cases
  listed, including Workspace access, database and File System results, and tutorial resume.
- **TEST-2 — additive risks:** a database, File System, tutorial, authorization or persistence
  change adds its relevant risk suites. A case belonging to several suites executes once.
- **TEST-3 — conservative selection:** mixed, unknown, renamed or deleted paths and changes
  to selectors, workflows, dependencies or shared boundaries select the complete relevant gate.
  Pull requests cannot replace their trusted base's selector or selected-case manifest.
- **TEST-4 — evidence:** a required case that is missing, renamed, skipped or failing makes
  the selected run fail. An explicit full run remains available and is identified as full.
- **TEST-5 — delivery:** main and release consumers retain their current exact-commit and full
  evidence requirements until a separately reviewed delivery policy changes them.
