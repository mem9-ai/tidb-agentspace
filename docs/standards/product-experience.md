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
connecting an agent first. Keep alternative resource kinds discoverable without inventing
availability or hiding provider constraints.

For new and Guest Workspaces, offer independent database and File System Quick Starts while
each category has no resources. Explain the first useful result and the Guest expiry where
applicable; remove each guide once its resource exists. Creation and execution remain explicit.
On Guest sign-in, show the 24-hour access limit with the Guest action without requiring hover.
Explain the actual consequence of signing out before ending a Guest session; do not promise
cleanup that the service has not implemented.

Minimize required decisions and navigation, not safeguards. Permission selection, write intent,
format/field/type confirmation, overwrite/discard decisions, provider limits and live/demo
information remain explicit. Never auto-run customer SQL, auto-provision a resource, broaden
a Key or discard work to save a click. Backend authorization remains authoritative.

**Focused Overview and activity (owner correction, 2026-11-02):** a populated Overview
prioritizes compact links to actual resources and resumable work. Avoid large empty resource-type
cards and embedded API examples; keep creation and the dedicated connection guide reachable.
Put operational history on a separate Activity destination. The current event feed contains at
most 200 successful changes and is not a complete security audit or HTTP request history;
show that limitation explicitly. Both audit and HTTP histories are required, with backend design
and implementation tracked in [GH-119](https://github.com/mem9-ai/tidb.ai/issues/119). Verify
empty and populated states, exact-resource links, progress re-entry, truthful coverage and
narrow layouts. Revisit the Activity presentation when verified request and audit records ship.
On the HTTP requests view, omit the coverage, retention and recording-status text at the owner's
request. This supersedes the corresponding Console disclosure in ADR 0044; the API's coverage
and health metadata remain available.

**Monitoring (owner correction, 2026-11-02):** remove the standalone Monitoring page when it
only repeats existing resource lists. Keep resources accessible through Overview and their own
collections, and operational history under Activity. Existing Monitoring links return to Overview.
Reintroduce a monitoring destination only when real, useful measurements support it. This
supersedes the earlier Monitoring presentation and the historical GH-98 experience audit.

## One interaction language

**Product identity and attribution (owner correction, GH-92, 2026-11-01):** use **TiDB Agent
Workspace** for the Console brand and document title. Do not label the entire Workspace
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
tutorials continue beyond creation with prepared sample data, an explicit query/analysis,
expected output and a useful next action. Retain a named Tutorials destination after completion,
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

**Focused file journeys (owner correction 2026-11-02):** lead Tutorials with the File System,
and separate file examples by the outcome a user wants, such as SQL analysis, Markdown preview
and Bash. Each example must be independently accessible without first completing another one;
keep the database tutorial discoverable and retain Workspace-backed sample identity and safe
re-entry. Verify first use, switching journeys, cross-browser return and narrow layouts. Revisit
the grouping as supported file formats and real usage develop.

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
