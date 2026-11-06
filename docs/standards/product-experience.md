# Product experience: consistency and minimum complete paths

- Status: accepted owner direction, GH-43, 2026-10-30. Applies to product design, Console
  implementation, API/agent journeys, and review by every contributor and coding agent.
- Product promise: one Workspace to store data and files, use them, and give an agent scoped
  access. The first useful result matters more than displaying implementation features.
- Current evidence and proposals: [experience audit](../product-experience-audit.md).
  Component APIs, theme and readability remain owned by the [TiUI standard](tiui-design-system.md).

## Consumer product quality

**Accepted owner direction (GH-96, 2026-11-01):** design this developer and agent Workspace
with the care of an excellent consumer product. Steve Jobs and Elon Musk are design
references: learn from focus, craftsmanship and questioning unnecessary complexity, then
apply judgment to this product's users and tasks.

- Define the useful outcome before choosing screens or exposing capabilities. Users should
  understand what they can do and why it matters without an explanation from the builder.
- Question each requirement, choice, label and step. Remove what does not serve the user's
  task before polishing what remains; preserve the explicit decisions and safeguards below.
- Treat naming, copy, defaults, examples, spacing and visual hierarchy as part of the product.
  Use natural language and realistic sample content. Keep technical terms when they help a
  developer act correctly, and make optional implementation details secondary.
- Own the complete experience: first use, a useful result, a clear next action and returning
  to continue. Creation alone does not complete a tutorial. A polished screen does not
  compensate for a dead end, lost progress or an unexplained failure.
- Treat an unavailable list as unknown, not empty: do not show a zero count or creation prompt
  before a successful load. Offer an actionable retry, and avoid exposing deployment settings or
  suggesting another sign-in when it cannot resolve the problem.
- Exercise product judgment before delivery. Fix obvious confusing names, redundant controls,
  inconsistent interactions and incomplete paths within the task's scope without waiting for
  the owner to point them out. Review both new and returning user experiences with realistic
  data. Passing automated checks does not establish clarity or product quality.

These are accepted design and review expectations, not a claim that a product-wide redesign
or automatic quality judgment is implemented. Revisit details when observed user behavior
shows that a default or simplification makes a task harder. Reference material:
[Steve Jobs, speeches to Apple employees and at Macworld, in _Make Something Wonderful_](https://book.stevejobsarchive.com/),
and [Elon Musk on questioning requirements and deleting steps before optimizing, 44:08–46:14](https://lexfridman.com/elon-musk-and-neuralink-team-transcript/).
The Workspace rules above are the project's application of these ideas.

## Design from the useful outcome

Start with what a person or agent wants to accomplish: query data, work with a file, or
connect an agent. For each screen identify the current context, useful next outcome and
minimum complete path to it. Remove repeated introductions, duplicate actions and intermediate
pages when context is known. A named resource opens that exact resource; a section opens
the collection.

**File-centered Workspace exploration (owner direction, 2026-11-02):** treat files as a
prominent Workspace entry and demonstrate how stored context, preview, SQL and Bash support
agent work. Offer concrete, reusable examples with explicit creation and safe re-entry; preserve
customer edits and make supported methods and read-only limits clear. This is a product direction
to evaluate, not a claim that all Workspace users or all file formats use the same workflow.
Verify first use, useful results and return alongside database discoverability; revisit the
emphasis as usage evidence develops.

The core journeys are Create database → run a query; Create File System → upload and
preview/analyze a file; and choose permissions → create a Key → use the provided API example.
These are design paths, not measured cloud-latency guarantees. Default safe optional inputs
such as supported regions and generated resource names. Console exploration does not require
connecting an agent first. Do not invent provider availability or hide provider constraints.

Name TiDB Cloud Zero as TiDB and describe MySQL compatibility as a capability. Local
simulation must be visibly identified and must not imply that a Zero instance was created.
Do not present simulated locations as meaningful choices. Per owner direction, the Console's
database creation flow offers PostgreSQL through db9, with unavailability clearly identified.
Existing TiDB resources remain accessible; standalone DuckDB resources are not shown in the
Console, and DuckDB file analysis remains
available. This is a Console experience decision, not removal of backend capabilities; revisit it
on owner direction.

For new and Guest Workspaces, lead the Overview with a useful file experience that offers both
agent and self-service paths; keep database creation available as a secondary action. The individual empty collections
retain their Quick Starts. Explain the Guest expiry where applicable; remove the Overview guide
once resources exist. Creation and execution remain explicit.
On the temporary-workspace entry, use “Try without an account” for the action and
“Temporary workspace” for the resulting workspace; avoid “demo” because this session can
perform real operations. Show the 24-hour access limit with the action without requiring hover.
Explain the actual consequence of signing out before ending a Guest session; do not promise
cleanup that the service has not implemented.

On the signed-out Studio page, present the two places a person can work. For the agent path,
name the human action (copy and paste the prompt) and the agent outcome (analyze the sample
and save a report). Present agent names as examples. Make the prompt usable from a fresh
project chat, including tools that open a skill by URL. Group browser actions with the browser path and distinguish account sign-in
from the two ways to try Studio.

After the first saved agent report, name the finding and offer one concrete follow-up that a
person can accept in the current chat. Reserve cross-agent handoff instructions for someone
who chooses that path. When a follow-up changes the question, lead the original report link with the new finding
and the data that explains it. Keep the earlier analysis available as context.
For a private CSV, lead with the agent uploading the explicitly selected file once and continuing from its saved remote version in the same project. Keep private results separate from public sample links. A copied sample question should yield a named finding even in an empty project. An attachment or unambiguous filename is sufficient to select private data; the agent resolves the path and explains file limits only when they affect that selection.
When the agent needs a source and the user is stuck, offer the public sample and their CSV as actionable choices in chat. Use the host’s picker or numbered replies. Honor a selection directly and resume available data without another source-selection step.
Opening files from a completed sample saves the verified public CSV and the displayed report into the reader’s own or temporary workspace, then opens the report alongside its source. Re-entry reuses identical files and conditional creation preserves edits. Further analysis starts with the existing sample; selecting private data is an optional next task.
Verify the click from a signed-out browser as well as a returning session. Viewing the report alone starts no workspace.

**People and agent onboarding (owner direction, 2026-11-03):** a Guest can explore the US sales
sample and obtain a real read-only analysis without installing an agent or creating a key. Offer a
separate agent path using the same saved sample. An agent's durable, inspectable report and a
separate session continuing its work remain the agent journey's goals, not proof supplied by the
self-service result. The self-service sales journey must also reach a durable result: compare
sales by state, examine the leading state's products, and explicitly save a report from the actual
results. Re-entry offers an existing report without overwriting it or attributing it to an agent.
Show each finding and the next action before lengthy result tables; after an explicit analysis,
bring the next action into view without moving focus away if the user has already moved elsewhere.
When returning to Overview, hide the sales guide once the manual report exists or both Agent
report files exist; never interrupt an active guide. Tutorials can reopen it explicitly without
creating or overwriting files. File existence is only a presentation signal, not proof of the
writer, execution, or report quality; an unavailable check must not hide the guide.
As of the owner correction on 2026-11-03, present the agent path first and
make self-service equally discoverable; after sample creation, let users switch paths without
discarding an in-progress or completed self-service result. On entering a new Workspace, prepare
one default File System automatically and retain the first-use guide; an explicitly selected sample
uses that File System. Show preparation and recovery honestly. Guest entry, sample creation and
execution remain explicit. Preserve
existing collection Quick Starts and database tutorial flow. This owner correction supersedes the
agent-only entry emphasis of [GH-150](../../specs/gh-150/spec.md); the specification's proposed
pairing and account features are not implied to be implemented. Revisit with observed use.

For the current sales sample, reveal the next action in sequence: review agent access,
start an agent with the task, then wait for a report. Opening the
sample must remain safe and returning must offer an existing-Key path without creating another
Key. A Key with insufficient grants does not advance the guided path; a pending grant is labeled.
Keep a downloadable task fallback if clipboard access fails. A copied task and a found report do
not prove that an agent connected or authored the report. Recheck the original sample before
offering its task, and never expose the Key in copied instructions.

Key creation separates resource selection from actions and presents plain-language permissions
grouped by the selected resource types. A file-only selection does not show database actions.
Workspace-wide access explicitly includes future resources and is distinct from the permission
to create resources. General Key creation starts with no resources selected; a contextual task
may preselect only the resource and actions it needs. Changing resource selection clears actions
that no longer apply, while selections outside the loaded resource window remain disclosed and
are not silently discarded. Review the actual grants and expiry before creation.

After creating a Key, make its next use concrete before closing the reveal-once view. For agents
that inherit a local terminal environment, provide a copyable setup command that prompts for the
Key without embedding it in the command or task; explain that a new agent session must inherit
that environment. Offer secret settings as an alternative. Plain-text key download is explicit,
states the storage risk, and does not claim the browser saved a file or connected an agent.
Confirm before dismissing an uncopied reveal-once Key. Revisit when verified pairing replaces
the manual setup; clipboard, download and Key creation are not connection evidence.

The sales launch offers Pi, Codex CLI and Claude Code without changing the scoped Key grant.
The copied command prompts for the Key and starts the selected local agent with the task; it
contains no Key and scopes the exported value to the launched process. Keep manual command and
existing-Key fallbacks. Explain that the command runs in a system terminal, not an existing
agent chat: a reported Pi session treated the launcher as a message and reused its old environment.
The launcher includes a stop instruction for agents that receive it as text; this is guidance,
not a guaranteed execution boundary. Browser assertions verify the instruction and shell tests
verify the freshly entered Key replaces an inherited value in the launched process. Revisit the
manual step when verified pairing makes it unnecessary. Reusable connection and file-operation instructions live in the portable
Workspace Skill delivered by the Console. The task points to that skill without placing the Key
in the URL or the task; the agent must fetch it without credentials and stop if it is unavailable.
This read does not install the skill into the user's environment. Report detection polls only
while the waiting view is active, slows down
over time and pauses in hidden tabs; preserve a manual retry and do not infer agent identity or
successful authorization from a file's existence. This is a manual credential handoff, not the
proposed one-time pairing flow. Revisit when a verified pairing and activity API is available.

For the follow-up after the first report, copying the task must show the next step and an
observable destination. Explain how to start a fresh authorized agent session, check the
follow-up file while waiting, offer a manual check and a download when copying fails, and restore
the waiting or found state on return. An existing file is offered for inspection, not presented
as proof that this agent ran the task. Do not overwrite an existing report or expose the Key.

**Database creation (owner direction, 2026-11-03):** the Console creates PostgreSQL through db9
without an engine choice. Existing standalone DuckDB databases are hidden from Console discovery,
direct navigation, and import destinations; existing data and backend capabilities remain intact.
File analysis continues to use DuckDB. Use the
configured location without a selector; actual location remains discoverable in Details. Creation
remains explicit, and unavailable PostgreSQL must be clearly identified.

When a persistent DuckDB database is unavailable, distinguish it from read-only DuckDB file
analysis and provide a route to Files. Do not imply that the storage-backed database was created
or enable a provider merely to remove the message.

Minimize required decisions and navigation, not safeguards. Permission selection, write intent,
format/field/type confirmation, overwrite/discard decisions, provider limits and live/demo
information remain explicit. Except for the new Workspace's default File System described above,
never auto-provision a resource. Never auto-run customer SQL, broaden a Key or discard work to
save a click. Backend authorization remains authoritative.

**Create table without a database (owner correction, 2026-11-03):** when a saved file or Bash
output has no available import destination, offer explicit database creation in the same journey
from both Create table and Export; retain the option to change export destination. Return to
the original file or output. Preserve the source and entered import state, select the exact created resource,
and distinguish a database that is still provisioning or cannot accept imports from one that is
ready. Offer status checking and a route to setup details without automatically creating or
retrying resources. Do not treat failed or incomplete destination loading as an empty list.
Parsing, schema review and the final table write remain separate explicit actions.

**Focused Overview and activity (owner correction, 2026-11-02):** a populated Overview
prioritizes compact links to actual resources and resumable work. Avoid large empty resource-type
cards and embedded API examples; keep creation and the dedicated connection guide reachable.
The standalone Activity page was removed after its audit, HTTP and legacy views proved slow or
unhelpful in the hosted experience. Existing Activity links return to Overview. The regional history
APIs and existing records remain intact; this UI change does not alter their coverage or retention.
Revisit a user-facing history experience when it can show useful, timely, clearly labeled records;
any audit or HTTP view must accurately convey its actual coverage and limitations.

**Monitoring (owner correction, 2026-11-02):** remove the standalone Monitoring page when it
only repeats existing resource lists. Keep resources accessible through Overview and their own
collections. Existing Monitoring links return to Overview.
Reintroduce a monitoring destination only when real, useful measurements support it. This
supersedes the earlier Monitoring presentation and the historical GH-98 experience audit.

## One interaction language

**Product identity and attribution (owner correction, GH-92, 2026-11-01):** use **TiDB Agent
Workspace** for the Console brand, skill, agent prompts, public discovery and document title. The skill metadata uses `tidb-agent-workspace`; its existing distribution URL and local helper paths remain compatibility identifiers. Do not label the entire Workspace
**Live resources** or use TiDB Cloud documentation as Workspace help. Remove the unrelated
help/Documentation and Cloud quota-documentation links; keep actual limits and resource-specific
provider/demo/expiry information explicit. Use one quiet footer **Powered by TiDB Cloud** link
to the [TiDB Cloud product page](https://www.pingcap.com/tidb/cloud/). Verify desktop branding,
mobile navigation, footer destination and the absence of the removed entry points in both
themes and viewport sizes. Revisit when Workspace-specific documentation is available.
Customer-facing previews and screenshots use natural Workspace names such as **My Workspace**;
keep fixture/harness terminology in internal identifiers, not the displayed Workspace name.

The shared-shell browser case verifies the removed destinations, external attribution target,
brand return and mobile navigation. Reviewed evidence: [desktop dark header](../screenshots/branding/header-desktop-dark.png),
[desktop light footer](../screenshots/branding/footer-desktop-light.png),
[narrow light navigation](../screenshots/branding/navigation-narrow-light.png), and
[narrow dark footer](../screenshots/branding/footer-narrow-dark.png), at 1280×800 and 390×844.

**Executable, resumable tutorials (owner correction 2026-10-31):** database and File System
tutorials continue beyond creation with prepared sample data and an explicit path to a useful
result. Retain a named Tutorials destination after completion,
show attempted/completed tutorials on Overview, and link back from each resource. Reopening
reuses the exact sample and resource; it must not automatically seed or execute another copy.
Keep uncertain writes inspectable without automatic replay, resource availability explicit and
file-draft guards intact. **Workspace persistence (owner correction, GH-83):** save progress with
the Workspace so another browser signed into that Workspace can find and continue the same
sample. Migrate existing browser progress create-only; Workspace state wins over old copies.
Load authoritative progress before enabling actions, acknowledge an attempt before sample
writes, and reject stale concurrent updates. Progress remains distinct from saved query results
and an execution audit. Verify both complete flows, create handoff, isolated-browser re-entry,
resource identity, unavailable persistence, conflicts and error/draft states. See
[implementation and evidence](../tutorial-verification.md) and [ADR 0033](../decisions/0033-workspace-tutorial-progress.md).

**One file example (owner correction 2026-11-03):** the File System tutorial leads to the
same US sales journey offered on Overview, with a self-service route and an Agent route. The Agent
task requests a Markdown report containing a Mermaid chart grounded in actual query results; an
existing report is never replaced just to produce a chart. Preview uses the existing isolated
Markdown and Mermaid renderers. Do not create separate Markdown and log tutorial samples as a
precondition to the journey. Preserve earlier sample files and their saved identity; direct users
to review a previous sample without replaying uncertain writes. This replaces the separate file
examples introduced on 2026-11-02; the database tutorial remains available.

**Guest Agent journey (owner correction 2026-11-03):** prioritize a concrete Agent task and
its files over resource administration on the Guest entry screen. An explicit US sales sample
creates a durable, versioned file in the default File System without a database; returning observes the same attempt and
never overwrites edits. Keep file access, Agent connection and Key management easy to find,
while retaining advanced workflows. The current manual Key instructions and an observed report
file do not prove an Agent connected, analyzed data or wrote that report. Verified pairing,
task evidence and Guest-to-account copy remain proposed in [GH-150](../../specs/gh-150/spec.md).

- Comparable screens share implemented primitives and state transitions, not independently
  copied markup. Reuse `WorkspacePageHeader`, `WorkspaceEmptyState`, `ResourceCollectionPage`
  and existing resource/browser/execution/results adapters where applicable.
- Give each task region one clear primary next action. Parallel first-use goal choices use the same treatment. An empty resource collection explains its
  value and places Create in the empty panel; omit a duplicate header button. A populated
  collection places Create in its header. Keep hierarchy, spacing, typography, icon family
  and action treatment consistent across resource types.
- Use consistent verbs: Create, Open, Connect, Run query/Run command and Export. Preserve
  meaningful differences: Upload stores file bytes; database Import confirms parsing/schema.
  Preview export operates on the original; execution export operates on its result/output.
- Identity, region, status and service information follow the same resource list pattern.
  Keep provider/demo, expiry and abnormal states truthful and readable; critical status text must not collapse into meaningless ellipses. Put optional detail
  in Details/Editor tools; keep execution intent and errors visible.
- Collection → resource → tool is the common hierarchy. Keep a labeled return to the
  collection and consistent breadcrumbs; disable the controlled return during active work
  and preserve applicable draft/discard guards. Responsive presentation can differ, but
  context and actions must remain discoverable without smaller text or hidden traps.
- Distinguish loading, empty collection, no filter matches, unavailable resource, denial and
  failure. Explain the state and appropriate recovery; an error is not an empty state.
  Successful actions retain exact identity/context.
- First use emphasizes resource actions and concrete outcomes. Do not lead with empty charts,
  repeated marketing panels, fake activity indicators or unavailable features. Returning
  users should reach their existing work directly.

## Review and verification

Before changing one area, inspect its equivalent in the other resource area and shared
components. Record intentional semantic differences instead of flattening them into misleading
identical labels. A new variation needs a user-task reason.

Verify actual paths: empty/populated collections; create/cancel; exact resource entry/return;
relevant draft/busy/error states; and the next useful action. Use the portable browser matrix
and inspect visible changes in Light/Dark at desktop/narrow sizes, with readable controls,
focus and no page-wide overflow. Follow [browser verification](browser-verification.md),
including serving-build identity at handoff.

Record which redundant step was removed and what remains required. Use timing only when
measured; a shorter interface is not evidence of faster cloud execution. Update shared
implementation and applicable canonical guidance together. Repository link checks prove
routing to this document, not product-quality compliance.

Revisit for multi-document work, durable drafts, account onboarding or new resource types.
Proposed features in an audit are not implemented capabilities.
