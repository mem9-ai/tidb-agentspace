# Console product experience audit

- Scope: GH-43, owner direction on 2026-10-30. Baseline `ef9b1ff75828d0c1a67181b384af3aa9c8232383`.
- Goal: consistent Database/File System experiences and fewer required steps to useful work.
- Authority: [product experience](standards/product-experience.md),
  [TiUI](standards/tiui-design-system.md) and existing resource/security decisions.
- This record separates implemented changes, verified existing patterns and proposals.
  It does not establish production identity, payments, telemetry or new provider capabilities.

## Product direction

The useful promise is **store data, do something useful with it, and give an agent access**.
Organize the experience around those outcomes. A first-time user should see an actionable
choice and a result, rather than first learning the infrastructure or reading a marketing
page. A returning user should open the exact resource whose name they selected.

Consistency is a transferable interaction model: the next resource type should feel familiar.
Minimalism removes redundant presentation, navigation and decisions. It does not remove
permission choices, data parsing, live-write warnings, expiry or protection for valuable work.
Both principles are shared project rules, not private memory for a particular coding tool.

## Live review and repairs (GH-98, 2026-11-01)

The owner requested a hands-on review of the deployed product, followed by implementation.
Source baseline: `c6fd53e` on main. The following repairs implement the accepted
[consumer product standard](standards/product-experience.md#consumer-product-quality);
merged source and a verified live publication remain separate delivery states.

| Reproduced experience problem                                                                                                                       | Repair in this revision                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Empty database tables offered only manual SQL creation; empty files had no direct sample action.                                                    | Both empty workspaces offer **Try sample data** for that exact resource. Existing creation/import/upload actions remain explicit.                                                                                                                |
| A resource's Tutorial entry displayed both complete workflows. On a phone, File System entry could still lead with the database tutorial.           | Resource/category links show one focused workflow, with **All tutorials** to return to the shared page.                                                                                                                                          |
| An in-flight sample save was described as an unconfirmed outcome, with the unrelated query action also showing activity.                            | Only the active step shows loading. Pending saves explain that work is in progress; uncertain-save recovery appears after the operation settles. No automatic replay was added.                                                                  |
| Generated sample identifiers and combined name/type/status options dominated the tutorial.                                                          | **Sample location** exposes exact names and Copy on demand. Resource names lead the selector; type and status remain readable below it. Existing table/file identities are preserved.                                                            |
| New files closed the dialog without opening an editor; file summary refresh could unmount the workspace and lose the current editor state.          | New files open directly in Edit source with keyboard focus. Existing loaded workspaces remain mounted during resource revalidation. Every operation still uses the authorized API.                                                               |
| File creation left name/cancel/close controls available during a pending write, and refresh failure could turn an acknowledged save into a failure. | Creation locks its controls, respects existing file draft guards, and keeps an acknowledged save successful if refreshing the summary fails.                                                                                                     |
| Hosted pages showed illustrative charts and local-only API instructions.                                                                            | Illustrative charts and their time filters are limited to explicit local demos. Hosted monitoring shows recorded counts/status, counts active resources accurately, and explains unavailable telemetry. API and billing copy matches hosted use. |
| The System theme label was clipped on narrow screens.                                                                                               | Keep the supported theme control at its desktop width, preserving readable text rather than shrinking it.                                                                                                                                        |

### Observed live paths

- Existing MySQL: reopened its original tutorial, reran the regional totals, then opened the
  exact sample table in SQL Editor and fetched all six rows.
- New DuckDB **sales-demo** and PostgreSQL **notes-demo**: created each, loaded the included
  six-order dataset, ran the tutorial query and returned through Overview. All three database
  engines returned **AMER 90, APAC 240, EMEA 180**. An initial DuckDB resource-index migration
  response explicitly created nothing; one later explicit retry succeeded.
- Existing File System: its trial region was occupied, and creation correctly offered a link
  to the existing resource. Reopened the original completed file tutorial without reseeding.
- Independent **/sales-demo.csv**: created, edited, checked the Tutorial departure guard,
  kept the draft, saved and previewed six rows. SQL returned the same regional totals;
  Just Bash returned the complete CSV with Exit 0 and left the original unchanged.
- Overview, Connect, Keys, API explorer, Monitoring, Usage & billing and Settings were
  inspected. No credentials were created, existing customer data was not deleted, and the
  dedicated demo resources/files remain available for continued exploration.

### Verification approach and evidence

Use semantic browser actions in batches for known flows and inspect results at meaningful
checkpoints. Keep independent provider work in separate tabs; use the waiting time for
implementation and local checks. Run focused assertions while diagnosing a change, then the
complete portable matrix once stable. Screenshots assess visual quality; fixture assertions
and live provider observations establish different boundaries.

The browser matrix covers pending saves in both tutorials, exact-resource entry and return,
file creation locking/focus/draft retention, acknowledged saves with failed summary refresh,
hosted versus local-demo presentation, the owner API explorer, and the existing isolated-browser
Workspace resume/no-duplicate-write cases. TiUI remains pinned at 2.9.1; no public API,
authorization or provider adapter changes. The PR records final check results and live
publication evidence; screenshots below use clearly labeled synthetic/local data.

| State                  | Desktop Light                                                     | Desktop Dark                                                     | Narrow Light                                                     | Narrow Dark                                                     |
| ---------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| Focused tutorial       | [Image](screenshots/product-review/focused-desktop-light.png)     | [Image](screenshots/product-review/focused-desktop-dark.png)     | [Image](screenshots/product-review/focused-narrow-light.png)     | [Image](screenshots/product-review/focused-narrow-dark.png)     |
| File editor after save | [Image](screenshots/product-review/file-editor-desktop-light.png) | [Image](screenshots/product-review/file-editor-desktop-dark.png) | [Image](screenshots/product-review/file-editor-narrow-light.png) | [Image](screenshots/product-review/file-editor-narrow-dark.png) |
| Hosted monitoring      | [Image](screenshots/product-review/monitoring-desktop-light.png)  | [Image](screenshots/product-review/monitoring-desktop-dark.png)  | [Image](screenshots/product-review/monitoring-narrow-light.png)  | [Image](screenshots/product-review/monitoring-narrow-dark.png)  |

## Cross-page findings and decisions

| Area                            | Baseline finding                                                                                                   | Result in this change                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collection empty states         | Database had two Create buttons; File System's empty panel had none.                                               | Both use one shared collection and empty-state implementation, with one filled in-context Create action. The header action appears once resources exist.                                                                                                                                                   |
| Collection headers              | File System copied its own header while other pages used an App-local helper.                                      | `WorkspacePageHeader` owns the same hierarchy and action placement across destinations.                                                                                                                                                                                                                    |
| Populated lists                 | Name controls, columns, service/status treatment and Open/Connect actions differed.                                | Both use `ResourceCollectionPage`: Name, Region, Status, Service, Actions; type/ID in the identity row; TiUI links and consistent Open/Connect controls. Provider/demo, expiry and connection errors remain visible. Status/service badges retain their full text instead of being squeezed into ellipses. |
| Resource return/context         | File System lacked the Database breadcrumb; return controls were icon-only and Database's was enabled during work. | Shared labeled collection-return buttons, disabled during controlled active work, plus collection breadcrumbs and exact resource names. Narrow screens retain the collection link and show identity in the resource selector.                                                                              |
| First-use Overview              | Repeated marketing, non-actionable empty activity/usage and a live dot on absent resources competed with creation. | Two starting choices, Query your data and Work with files, open contextual creation. Engines are chosen inside database creation. No activity/billing dashboard appears before resources exist; capability availability is retained.                                                                       |
| Existing-resource Overview      | Clicking a displayed resource name opened the collection, requiring another selection.                             | Named resource links open the exact workspace; the sidebar still opens collections.                                                                                                                                                                                                                        |
| Agent setup                     | Create Key required opening the Keys page before its creation form.                                                | Connect has a direct primary Create API key action using the existing scoped form. Manage API keys remains available. Repeated hero content was removed.                                                                                                                                                   |
| Keys empty state                | Header and empty panel repeated Create API key.                                                                    | One empty-state action; the populated page retains its header action. Scope, expiry, one-time secret and revocation semantics are unchanged.                                                                                                                                                               |
| Database/File editors           | Existing shared browser, execution and result adapters already aligned chrome.                                     | Retained: `WorkspaceBrowserPanel`, `WorkspaceBrowserItem`, `WorkspaceExecutionPanel`, `WorkspaceQueryResults` and `WorkspaceExportButton`. No duplicate replacement editor was introduced.                                                                                                                 |
| Upload/Import                   | Both move data but confirmation semantics differ.                                                                  | Upload remains the File System action; database Import retains parsing/field/type confirmation. Existing upload progress and import flow are preserved.                                                                                                                                                    |
| Export                          | Preview and execution have different source identities.                                                            | Shared Export treatment remains; original-file and result/output dialogs retain identity and destinations.                                                                                                                                                                                                 |
| Monitoring/Billing/Settings/API | Each has a different purpose; some service capabilities are unconnected.                                           | Shared page/empty primitives apply where relevant. Existing demo/not-connected labels remain; no invented activity, quota or payment state was added.                                                                                                                                                      |

## Important intentional differences

- Native database SQL can write data. File analysis is bounded and read-only. Shared Run
  controls do not change those permissions or make execution contexts interchangeable.
- Upload stores bytes; database Import maps structured data into fields/types. Removing
  confirmation sacrifices correctness rather than simplifying the product.
- A section opens a collection, a resource name opens the exact resource, and an explicit
  file link preserves its resource/path/view. These are different user intents.
- File-source draft protection and query replacement guards remain. This change does not
  claim durable SQL drafts or a complete cross-resource/history leave-guard system.
- Preview/export limits, native auth, provider credentials and billing semantics remain
  backend concerns. Frontend defaults and disabled controls do not replace enforcement.

## Next product experiments, not implemented promises

1. Add durable query drafts/history and coherent leave protection across resource changes
   and reload. Current file/query-replacement guards are not complete durable-work support.
2. Surface capability-aware CSV/Parquet SQL and log/text Bash examples so a new user can
   obtain one useful result, then explicitly export it. Keep execution/parsing consent.
3. Instrument real time-to-first-result and recovery/drop-off with a defined privacy/telemetry
   implementation before claiming conversion or cloud-latency improvements.

## Verification

Portable browser checks cover empty-state action count/style/readability and creation context;
common populated columns, service labels, exact Open/Connect/return; direct Overview resource
entry; direct scoped Connect-to-Key creation; and existing history/file draft/export flows.
The matrix uses Light/Dark at 1280×800 and 390×844. Synthetic API fixtures validate Console
behavior, not provider auth or cloud provisioning. Current normal checks, final browser counts
and visible screenshots are recorded in the implementation PR. Visual review is separate
from functional assertions.

The stable local Console is updated from the reviewed build while retaining the existing
Rust API, metadata and credentials. Other contributors' working copies/services are preserved.
Netlify live verification remains deferred by owner direction.

## Reviewed evidence

Local `npm run check` passed (75 tooling/contract tests passed, 22 guarded native cases
skipped; native integration is owned by the required Rust CI gate). The final portable
browser matrix passed all 48 cases without retries. Additional temporary fixture captures
were inspected for populated collections and resource headers in both themes/sizes; they
are visual review aids, not additional permanent journeys or proof of live cloud services.

The stable native preview supplied the empty workspace screenshots below. Each page was
inspected at 1280×800 and 390×844 in Light/Dark. Narrow Overview/Connect captures include the
full scrollable page; controls and text retain their existing readability settings.

| Page               | Light desktop                                                           | Dark desktop                                                           | Light narrow                                                           | Dark narrow                                                           |
| ------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Databases          | [Image](screenshots/experience-consistency/databases-light-desktop.jpg) | [Image](screenshots/experience-consistency/databases-dark-desktop.jpg) | [Image](screenshots/experience-consistency/databases-light-narrow.jpg) | [Image](screenshots/experience-consistency/databases-dark-narrow.jpg) |
| File Systems       | [Image](screenshots/experience-consistency/files-light-desktop.jpg)     | [Image](screenshots/experience-consistency/files-dark-desktop.jpg)     | [Image](screenshots/experience-consistency/files-light-narrow.jpg)     | [Image](screenshots/experience-consistency/files-dark-narrow.jpg)     |
| First-use Overview | [Image](screenshots/experience-consistency/overview-light-desktop.jpg)  | [Image](screenshots/experience-consistency/overview-dark-desktop.jpg)  | [Image](screenshots/experience-consistency/overview-light-narrow.jpg)  | [Image](screenshots/experience-consistency/overview-dark-narrow.jpg)  |
| Connect            | [Image](screenshots/experience-consistency/connect-light-desktop.jpg)   | [Image](screenshots/experience-consistency/connect-dark-desktop.jpg)   | [Image](screenshots/experience-consistency/connect-light-narrow.jpg)   | [Image](screenshots/experience-consistency/connect-dark-narrow.jpg)   |

Concrete path reductions: a named Overview resource now opens its workspace in one selection
instead of two; creating a Key from Connect takes one selection instead of visiting Keys first.
Empty collections have one contextual Create action. These are navigation changes, not measured
improvements to provider provisioning or execution latency.
