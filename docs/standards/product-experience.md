# Product experience: consistency and minimum complete paths

- Status: accepted owner direction, GH-43, 2026-10-30. Applies to product design, Console
  implementation, API/agent journeys, and review by every contributor and coding agent.
- Product promise: one Workspace to store data and files, use them, and give an agent scoped
  access. The first useful result matters more than displaying implementation features.
- Current evidence and proposals: [experience audit](../product-experience-audit.md).
  Component APIs, theme and readability remain owned by the [TiUI standard](tiui-design-system.md).

## Design from the useful outcome

Start with what a person or agent wants to accomplish: query data, work with a file, or
connect an agent. For each screen identify the current context, useful next outcome and
minimum complete path to it. Remove repeated introductions, duplicate actions and intermediate
pages when context is known. A named resource opens that exact resource; a section opens
the collection.

The core journeys are Create database → run a query; Create File System → upload and
preview/analyze a file; and choose permissions → create a Key → use the provided API example.
These are design paths, not measured cloud-latency guarantees. Default safe optional inputs
such as supported regions and generated resource names. Console exploration does not require
connecting an agent first. Keep alternative resource kinds discoverable without inventing
availability or hiding provider constraints.

Minimize required decisions and navigation, not safeguards. Permission selection, write intent,
format/field/type confirmation, overwrite/discard decisions, provider limits and live/demo
information remain explicit. Never auto-run customer SQL, auto-provision a resource, broaden
a Key or discard work to save a click. Backend authorization remains authoritative.

## One interaction language

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
  Keep provider/demo, expiry and abnormal states truthful and readable. Put optional detail
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
