# TiUI design system standard

- Policy status: Accepted; applies to all frontend work.
- Implementation status: Implemented in the Console; see [migration verification](../tiui-migration-verification.md).
  Domain layout, resource artwork, and illustrative charts remain project-owned.
- Verified reference: `@tidbcloud/uikit@2.9.1`, inspected on 2026-10-27.
- Decision: [ADR 0002](../decisions/0002-tiui-design-system.md).

## Authority and evidence

Use [official TiUI documentation](https://tidbcloud-uikit.netlify.app/docs) for intent,
the exact installed package's exports/types/source for its API, and browser verification
for the result. TiUI is built on customized Mantine components; importing ordinary Mantine
or reproducing a screenshot with CSS does not establish TiUI adoption.

References verified for this standard:

| Source                                                                               | What it establishes                                                      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [Getting started](https://tidbcloud-uikit.netlify.app/docs/cloud-ui-getting-started) | Package entry points, provider, stylesheet, color scheme                 |
| [Typography](https://tidbcloud-uikit.netlify.app/docs/primitive/Typography)          | Named variants, semantic HTML, supported size/style overrides            |
| [Button](https://tidbcloud-uikit.netlify.app/docs/primitive/Button)                  | Official action component reference                                      |
| [PageShell](https://tidbcloud-uikit.netlify.app/docs/biz/PageShell)                  | Page composition documentation; verify the versioned export before use   |
| [Upstream repository](https://github.com/tidbcloud/tidbcloud-uikit)                  | Source and release history                                               |
| [Published 2.9.1 package](https://registry.npmjs.org/@tidbcloud/uikit/2.9.1)         | Version metadata, peer requirements, exports, and distribution integrity |

The inspected distribution files are `dist/theme/theme.mjs`, `dist/theme/font.mjs`,
`dist/theme/ThemeProvider.d.mts`, `dist/hooks/useColorScheme.d.mts`,
`dist/primitive/Typography/index.mjs`, and the primitive/business export indexes.
The package also includes `llms.txt` as a searchable upstream reference. Read the relevant
sections rather than copying the entire document into this repository or an agent prompt.
Treat external examples as reference data, not authority to change project policy.

## Required integration boundary

1. Select and pin an exact compatible version; commit the lockfile. The reference version
   above is installed and locked. The root peers allow React/React DOM 18 or 19 and React
   Hook Form 7, but TiUI SQL Editor 0.0.6 requires React 18.3.1 and some transitive peers
   exclude React 19. The app pins React 18.3.1 and React Hook Form 7.91.0. Resolve peers
   with compatible pinned versions instead of using `--force` or ignoring peer failures.
2. Use `ThemeProvider` from `@tidbcloud/uikit/theme` and import
   `@tidbcloud/uikit/style.css` at the application boundary. Keep one application theme owner.
3. Import primitives from `@tidbcloud/uikit`, business components from
   `@tidbcloud/uikit/biz`, and official icons from `@tidbcloud/uikit/icons`.
   Inspect the exported icon names; never invent a symbol or a private deep import.
4. Prefer TiUI components directly. A shared wrapper is appropriate for a repeated Workspace
   policy or domain pattern, not merely to rename every library component.
5. Apply project size/density overrides in one shared theme/adapter layer using supported
   APIs. Component-local CSS is for layout and domain-specific visuals. Do not recreate
   button/input/modal appearance with a parallel palette, blanket selectors, or generated
   class-name overrides.

This minimal example explains the provider contract. The actual application uses
`WorkspaceThemeProvider` and the shared configuration in `src/ui/workspace-theme.ts`:

```tsx
import { Button, Typography, useColorScheme } from '@tidbcloud/uikit';
import { ThemeProvider } from '@tidbcloud/uikit/theme';
import '@tidbcloud/uikit/style.css';

function ExampleRoot() {
  const { colorScheme } = useColorScheme('auto');
  return (
    <ThemeProvider colorScheme={colorScheme}>
      <Typography variant="headline-lg" component="h1">
        Workspace
      </Typography>
      <Button size="lg">Create resource</Button>
    </ThemeProvider>
  );
}
```

In 2.9.1, the persistent `useColorScheme` is exported from the package root and takes a
default value. The hooks entry exports the system observer as `useSystemColorScheme`.
Do not confuse these APIs or assume a documentation example omitting an argument matches
the pinned types. Read `useComputedColorScheme` inside the provider when resolved mode is
needed. One root state/context should drive the selector and provider.

## Verified defaults versus Workspace choices

These upstream values are verified facts from 2.9.1:

| Foundation     | Verified upstream default                                                             |
| -------------- | ------------------------------------------------------------------------------------- |
| Font           | Inter first, with system and language fallbacks; code font starts with Menlo/Consolas |
| Primary color  | `carbon`, primary shade 7; the filled carbon button uses shade 9                      |
| Text roles     | Typography headlines use `carbon.9`, body/labels `carbon.8`, actions `peacock.7`      |
| Palette/theme  | Separate light/dark palettes managed by the provider                                  |
| Radius         | Default radius 8px                                                                    |
| Spacing        | `xs/sm/md/lg/xl` correspond to 10/12/16/20/24px via the theme                         |
| Button heights | `xs/sm/md/lg/xl`: 28/32/40/48/56px; default size `md`, variant `filled`               |
| Input heights  | `xs/sm/md/lg/xl`: 28/32/40/44/48px; `xl` input text is 16px                           |

Keep palette references semantic so the provider resolves both modes. Do not copy light
hex colors into dark styles. The red logo does not make red the default primary action;
use TiUI's action styles, and reserve destructive styling for destructive operations.
Do not replace the official font stack with DM Sans or add a separate font service as a
stylistic preference. Verify how fonts are supplied and rendered during actual integration.

The owner requested larger text and less crowding. The following are **Workspace project
rules**, intentionally distinct from TiUI's compact defaults:

| Use                               | Upstream reference                                    | Workspace target                                                                                    |
| --------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Page heading                      | `headline-lg`: 24px / 32px, weight 700                | Prefer this variant; a larger shared page-heading override may be used where needed                 |
| Section heading                   | `headline-sm`: 18px / 28px or `title-lg`: 16px / 24px | Keep a clear heading hierarchy and semantic elements                                                |
| Body, form values, editable code  | `body-lg`: 14px / 20px; inputs have their own sizes   | 16px default; 15px only where density materially helps; use a shared supported override             |
| Labels and supporting explanation | `label-lg`: 14px / 20px                               | 14px normally, 13px only for secondary metadata                                                     |
| Minor badges/metadata             | Smaller variants exist upstream                       | Never below 12px; do not use 8–11px for workflow instructions                                       |
| Primary form actions              | Button `lg` is 48px high                              | Prefer 44–48px targets; select the corresponding TiUI size instead of shrinking controls            |
| Cards and sections                | Theme spacing tokens                                  | 24–32px section gaps and 20–24px card padding as starting values; centralize any 32px project token |

Do not change `html` font size or scale the whole UI to enlarge text: that also changes
rem-based geometry. Adjust the supported component typography and density settings. Verify
computed sizes after overriding; a named typography variant may set its own size explicitly.
Preserve browser zoom. Reflow narrow layouts rather than decreasing font size.

## Component selection for this Workspace

| Product pattern                | TiUI building blocks                                                                          | Project responsibility                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Navigation and page header     | Primitive `AppShell`, `NavLink`, `Breadcrumbs`; business page shells when appropriate         | Workspace identity, active route, mobile navigation, one clear primary action |
| Resource cards and details     | `Card`, `Paper`, `Stack`, `Group`, business `PropertyCard`                                    | MySQL/PostgreSQL/DuckDB/Files labels, region, lifecycle, preview/limit text   |
| Resource, key, activity tables | Primitive `Table`; business `ProTable` where filtering/pagination needs justify it            | Column meaning, empty/error/loading states, accessible row actions            |
| Keys and settings forms        | `TextInput`, `Select`, `Checkbox`, `Fieldset`, `PasswordInput`; business `Form` when suitable | Validation, resource/action grants, expiration, reveal-once secret behavior   |
| Dialogs and secondary panels   | `Modal`, `Drawer`, `Alert`, `Button`, `ActionIcon`                                            | Focus return, clear submit/cancel, failure recovery, pending state            |
| Status, usage, feedback        | `Badge`, `Progress`, `Skeleton`, `Loader`, notifications; business `DotBadge`                 | Text in addition to color, fresh data versus simulation, retry behavior       |
| Connection examples            | Business `CodeBlock`, `CopyText`                                                              | One Workspace Key, redacted secrets, accurate copy/download feedback          |
| SQL work                       | `@tidbcloud/tisqleditor-react` with its cache provider and CodeMirror extensions              | Query lifecycle, permissions, cancellation, and honest demo limitations       |

The documentation labels `TableBasic`/`TablePro` do not imply exports with those names:
2.9.1 exports `ProTable`. Its business `PageShell` export points to a legacy implementation;
evaluate `AppPageShell`/`PageShellBase` against current docs and types for new composition.
Cloud UI Pro is documented as work in progress, not a requirement to copy an entire page.
TiUI's separate SQL editor is not delivered by merely wrapping a textarea in a provider.

Prefer official icons consistently. A missing product-specific glyph can be a small shared
custom SVG with a documented reason; do not silently introduce a second icon library for
one screen. Preserve existing icons during a scoped migration until their replacements are
verified, and record that as a remaining gap.

## Theme, responsive behavior, and interaction

- Resource-specific tools live under their resource, with context in the URL. The owner's
  2026-10-27 navigation correction places SQL Editor inside Databases: choose a database,
  open its editor, and keep that database selected through connection links and history.
  Follow the [information architecture](../architecture.md#console-information-architecture)
  when adding tools; do not add a workspace-level SQL Editor entry. Verify valid, unavailable,
  and empty-resource paths; keep the resource context when extending the editor.
- **Database workspace (owner correction 2026-10-28):** keep the table navigator and SQL
  Editor on one database page. On desktop the table list stays beside the editor; place query
  results and table structure/data inspection below the editor. Selecting or refreshing a
  table must not unmount the editor, clear query results or replace edited SQL. Generating a
  table SELECT is explicit and requires a replace/keep choice for an edited draft; never run
  it automatically. Preserve existing table/editor URLs and exact resource/table identities.
  Reflow panels on narrow screens without shrinking text, and keep wide tables internally
  scrollable. Use TiUI navigation, Tabs, Table and shared layout primitives. Check state
  retention, keyboard behavior, both themes and sizes; see [ADR 0007](../decisions/0007-database-browser.md)
  and [unified workspace verification](../database-workspace-verification.md). Revisit for
  multiple query documents, multiple schemas or durable draft persistence.
- **Inline table columns (owner correction, GH-54):** a table row is an accessible disclosure
  for its columns, not an automatic switch to Table details. Show column names, SQL types and
  available nullable/key/default/extra attributes beneath the selected table. Keep SQL Editor,
  edited SQL and completed results in place. Query table explicitly prepares a dialect-safe
  SELECT and uses the existing Keep/Replace guard; only Run query executes it. Full inspection
  stays an explicit secondary tab. Share the selected-table metadata read between both views,
  pause new reads during active SQL/list/row operations, and clear resource-scoped data on
  database changes. Preserve URLs, keyboard expanded/controls semantics, retry, filtering and
  whole-browser collapse. See [verification](../database-workspace-verification.md#inline-table-columns).
  Use the bounded route-local metadata reuse in [ADR 0007](../decisions/0007-database-browser.md)
  when returning to a table; refresh/retry must bypass it. Preserve loading/error feedback and
  measure cold reads separately from cache hits. Revisit for multiple open tables, schema trees
  or durable metadata caching.
- **Database work area density (owner correction 2026-10-28):** prioritize the table list,
  editor and first query rows within a typical desktop viewport. Following GH-61, use one
  compact resource toolbar above both browser and editor: name/protocol in the selector,
  one live/demo/state badge and resource actions. Keep the semantic page heading visually
  hidden; the navigation already identifies the section. Put provider, region and expiry
  guidance in shared TiUI Details and SQL budgets in Limits. Keep live-write/demo labels visible and
  show expired/provisioning/connection errors inline. Collapse optional sample queries into
  a menu; let users expand the editor without losing SQL or results. Reduce repeated chrome
  and vertical whitespace, not font size or primary action targets. Use supported component
  spacing and the shared CodeMirror theme for bounded scrolling. Verify 1280×800/900 and
  390×844, both themes, keyboard access to disclosures and state retention. Narrow screens,
  expanded editors, long names and error messages may need page scrolling. See
  [density verification](../database-density-verification.md); revisit when adding query tabs
  or resizeable panes.
- **Shared browser density (owner correction 2026-10-28):** database table navigation follows
  the compact File System browser: one title/count/toggle row, a combined filter/refresh row,
  and an independently scrolling list. Reuse `src/ui/WorkspaceBrowserPanel.tsx` for this chrome
  and collapse behavior. Collapse to a 56px desktop rail without unmounting the list, inspector
  or editor, clearing filters/drafts/results, changing selection or canceling active work.
  Keep the same labeled toggle focused, expose expanded/controls state, and remove hidden
  controls from keyboard navigation. Both browsers use the same compact horizontal disclosure
  on narrow screens, before and after selection. File System also keeps Back to files and its
  unsaved-change guard; opening a file does not hide the browser. Preserve readable text and 44px controls.
  Check both themes at 1280×800/900 and 390×844, including keyboard toggling, active queries,
  filtering and File System regression. Evidence is in [density verification](../database-density-verification.md#compact-table-browser).
  Revisit for resizable navigation or multiple database documents.
- **Resource collections first (owner correction, 2026-10-29):** sidebar destinations for
  Databases and File System open their global resource lists. Never silently choose the first,
  live or only resource. Enter a resource only through an explicit resource URL/selection;
  keep a labeled All resources return action in its workspace, guarded against unsaved work
  and disabled during active resource operations. File System list rows show identity, region,
  status and provider, with open/connect/create entry points. Unknown or wrong-kind IDs show
  unavailable with a route back to the list. Preserve existing file preview/analysis links,
  and keep closing a file inside its selected File System. Use actual TiUI Table and controls,
  existing page-heading spacing, and the shared compact header inside a selected resource.
  Check zero/one/multiple resources, reload/history, direct links, creation defaults, draft
  guards and both themes/viewports. See [list verification](../filesystem-list-verification.md).
  Revisit when adding collection filters or pagination.
- **Resource workspace hierarchy (owner correction 2026-10-28):** unify Database and File
  System at the page level, not only their sidebars. Use `ResourceWorkspaceHeader` and its
  `ResourceWorkspaceBar` for one compact selector/status/actions toolbar above the entire
  work area, with an accessible section heading. Avoid a second large title, description,
  resource-icon block or duplicate active indicator. `ResourceDetails` holds supplemental
  provider/region/expiry information and File System counts/size; unusual status and connection
  errors remain visible. Reflow the same controls on narrow screens without reducing their
  text or target sizes. Tables and Files are children of that resource, beside SQL or file
  preview/edit/analysis. Do not put the database selector inside SQL Editor while Tables sits
  outside. Use the shared 320px/56px browser layout, heading/metadata spacing and
  `WorkspaceBrowserItem` (TiUI NavLink) for icons, names, secondary text, selection and row
  actions. File System keeps a desktop unselected-file panel, shared narrow disclosure and
  Back to files flow. DuckDB uses its native database workspace without a file-source picker.
  Preserve exact URLs and existing draft/resource
  lifetimes, and disable resource selection during active operations. Verify both themes at
  1280×800/900 and 390×844, resource switching, busy states, keyboard and draft guards. See
  [verification](../resource-workspace-verification.md); revisit for tabs or resizable panes.
- **Shared execution and item interactions (owner correction, GH-52):** use
  `WorkspaceExecutionPanel` for Database SQL and File System Analyze. Following GH-56,
  use one compact toolbar with a quiet SQL/Bash marker, visible execution context and the
  top-right Run query button, Play icon, 48px target and loading/disabled behavior. Put Samples,
  Limits and expansion in Editor tools; omit the repeated large tool heading and footer strip.
  Preserve an accessible named editor region. Reflow context onto its own line on narrow
  screens rather than shrinking text or hiding live-write/read-only information. Bash uses
  Run command with the same chrome; explicit cancellation retains a labeled 44px stop control.
  Keep database
  write/demo context and file read-only/table context visible; retain separate execution and
  authorization rules. Use `WorkspaceQueryResults` for result headers, counts, export, table
  scrolling, errors, empty/running states and completion metadata. Scope shared spacing so
  generic panel margins cannot add extra gaps. File rows use one overflow menu and the same
  full-width NavLink selection surface as table rows, with sibling action controls and no
  nested buttons. Keep primary text readable and menus outside the scrolling list. Check
  both themes, desktop/narrow sizes, cancel/recovery, keyboard focus and draft/result retention.
  See [interaction verification](../resource-workspace-verification.md#shared-interaction-audit).
  Revisit when adding a new execution tool or changing the installed UI packages.
- **Result export (owner correction, GH-58):** Database and File System SQL use the same
  Export entry and TiUI dialog for CSV/JSON/JSON Lines downloads and copies to public workspace
  files or new database tables. Export the completed rows without rerunning SQL. Show the
  target, row count and format semantics before the explicit action; collisions preserve the
  inputs and never overwrite or append. Lock submission/dismissal while writing, restore focus
  on close, preserve drafts/results, and refresh the target browser without resetting filters.
  Success links open the saved file/table. Follow [ADR 0013](../decisions/0013-result-snapshot-exports.md)
  for authority and partial-write handling, and [verification](../result-export-verification.md)
  for themes, narrow layouts and API limits. Revisit for larger exports or additional formats.
- **File upload feedback (owner correction, GH-99):** label the local-file entry Upload;
  reserve Import for parsing/mapping data into another resource. Keep a persistent TiUI
  progress panel with filename, destination, actual transfer percentage when known, and
  clear preparing/saving/completed/error states. Transmitted bytes are not a saved file:
  wait for the API acknowledgement before reporting success, and show unknown server work
  without an invented percentage. Keep completion/failure visible until dismissed or replaced;
  never classify an acknowledged upload as failed because list refresh failed. Preserve
  structured errors, conditional-create protection and upload limits; do not automatically
  retry a write after an uncertain network outcome. TiUI 2.9.1 Progress.Root/Section supports
  explicit indeterminate ARIA with Section `withAria={false}`. Verify the bar, busy locking,
  recovery, original-byte downloads and both themes at desktop/narrow sizes. See
  [upload verification](../drive9-verification.md#upload-progress-and-recovery-gh-99).
  Revisit for multiple concurrent, resumable or provider-reported upload stages.
- **Contextual file exports (owner correction, GH-79; implemented 2026-10-29):** Preview
  operates on the saved original. Following the GH-84 owner correction, place one Export action
  beside the Preview heading, using the same shared content-panel header as results; remove
  the separate transfer footer. Download is a destination inside that dialog, which still
  identifies Original file and labels its download Download original. Following GH-96, saved
  Preview, Database/File System SQL results and Bash output all use `WorkspaceExportButton`
  with the visible label Export, the same official icon, 48px size and theme-resolved default
  variant. Do not introduce context-specific entry labels or independent button styling.
  Keep the source explicit in the owning panel and export dialog instead; verify each button
  still opens the correct original-file, SQL-result or command-output flow without rerunning it.
  This supersedes the former Export results/Export output entry labels. Dirty preview/source headers
  instead expose Download draft and Save changes; saved-original copy/import remains blocked
  until save/discard. Keep export reachable on unavailable/oversized/failed previews, and check
  its original-file destination, focus return and draft/result transitions in both themes and
  viewport sizes. Revisit for new preview modes or destinations. Raw copies preserve original bytes or the chosen stdout/stderr
  stream, including empty/nonzero-exit output, without rerunning execution. Use shared TiUI
  destination controls for computer, public File System and new database table. Parsed imports
  require explicit format, sample, field/name/type review and a separate confirmation showing
  source and target. Keep arbitrary output as text lines until CSV is chosen. Preserve drafts,
  results and recoverable form values; invalidate review when parsing options or stream changes.
  Move focus to the parsed review, return it on close, and keep a usable download link after
  preparation. Check both themes/viewports, source/result switching, errors and busy locking.
  [ADR 0018](../decisions/0018-contextual-file-exports.md) and
  [verification](../contextual-file-export-verification.md) define the authority and evidence.
  Revisit for new destinations, formats or persistent/large exports.
- **Preview-first file workspace (owner correction, GH-76):** open a file to its content or
  bounded tabular sample. SQL/Bash expands in place, with Data preview and Query result/Command
  output sharing the content area. Following the GH-82 owner correction, initial preview and
  unexecuted Analyze show no result navigation. Reveal usable preview/result tabs only when
  explicit execution starts; retain them for running, success, error and canceled states.
  Never present a disabled result tab as an apparent Analyze entry. Clearing execution state
  returns to preview and its original-file actions; preserve existing results when merely
  switching tools/methods. Check these transitions in both themes/viewports, including keyboard
  navigation and export context. See the result-discovery evidence in the linked verification;
  revisit when introducing persistent sessions or separate analysis routes.
  Keep tools mounted through tool, content, method and browser
  toggles; retain independent in-memory drafts/results/errors and run only explicitly. Source
  editing remains a secondary action with save/discard guards; Parquet has no source editor.
  CSV/Parquet preview uses the server's fixed reader, shows types/schema and a clearly labeled
  sample; CSV types are inferred and its total is unknown, while Parquet count comes from metadata.
  Fixed preview requires read access; custom execution still requires analyze access. Keep
  original download through Preview's Export dialog, unavailable/retry states and saved-version mismatch guidance. Refresh
  preview/capabilities after saving without unmounting tools. Legacy analyze links expand tools.
  Use TiUI disclosures, Tabs, Table and the existing shared execution/results/theme adapters.
  Inspect retained state, source guards, busy/cancel/errors, 16px editors and 15px table cells,
  both themes at 1280×800 and 390×844 with internal scrolling and no page overflow. See
  [ADR 0017](../decisions/0017-preview-first-file-workspace.md) and
  [verification](../file-workspace-verification.md). This supersedes the top-level Preview/Analyze
  split in older reading/analysis evidence. Revisit for durable sessions or large-file range reads.
- **File analysis (accepted and implemented, 2026-10-28):** keep analysis in the selected
  unified file workspace with tools expanded on demand. Separate file format from analysis method: use capability options to
  offer DuckDB SQL and Just Bash for CSV; keep SQL as its default. Parquet remains SQL-only
  and recognized text remains Bash-only. Use a labeled TiUI SegmentedControl when multiple
  methods exist, explain parsed rows versus raw text, retain separate in-memory drafts/results/errors,
  and disable switching while running. Changing a method must not execute. Follow
  [ADR 0014](../decisions/0014-file-analysis-engine-options.md) for capability compatibility and
  individual availability. SQL uses the official SQL Editor with Standard SQL dialect;
  Bash uses TiUI Textarea. Fetch capabilities, but run only
  on an explicit button/shortcut. Keep file identity in the URL (never scripts/results), original Download, limit/error states,
  and cancel on unmount. Let the analysis panel expand into page flow so the editor cannot
  hide Run or results behind the fixed preview footer. For isolated interpreters, preserve
  the selected Workspace path in the virtual snapshot rather than requiring users to translate
  its visible identity to a fixed input name. Follow [ADR 0015](../decisions/0015-bash-workspace-paths.md)
  for discovered input metadata, safe shell quoting and legacy aliases. Show the actual path
  beside the editor with a copy action; explain that it names only the selected snapshot,
  not the provider or host filesystem. Keep the common path visible and put longer usage guidance
  in a disclosure. Keep everyday steps focused on selecting input, filling a command and running
  it explicitly. Put runtime limits, debugging and legacy compatibility details in a secondary
  collapsed disclosure. Explain that legacy aliases are temporary names for the selected input
  and do not create or overwrite provider files; do not present them as another customer resource.
  Preserve readable keyboard-accessible disclosure targets. Start with a generic, executable preview sample and explain that examples
  fill the editor without running. The first Bash sample must already contain the safely quoted
  absolute input path. Offer `"$FILE"` as a reusable current-file reference only when capability
  discovery reports support, and identify it as a Workspace convention rather than a Bash built-in;
  follow [ADR 0016](../decisions/0016-bash-selected-file-variable.md). Check samples against the real worker and provide recovery
  guidance for missing-file errors without changing access boundaries. This owner correction
  is implemented for Just Bash in [usage verification](../file-analysis-verification.md#workspace-path-identity),
  superseding GH-63's fixed-path-only guidance.
  Preserve 16px text and inspect Light/Dark at desktop/narrow sizes. See [verification](../file-analysis-verification.md); revisit for
  multi-file contexts or persistent analysis sessions.
- **File work area density (owner correction 2026-10-28):** keep the file browser beside the
  selected file/analysis editor on desktop. Group New file and New folder under one labeled
  TiUI plus-button Menu. Use a compact path/filter/refresh toolbar and readable rows; reduce
  repeated chrome rather than text or control targets. Allow the browser to collapse to a
  narrow inline rail and expand without unmounting the selected-file editor, resetting SQL,
  discarding source drafts/results, changing file identity or canceling active work. Keep
  hidden browser controls out of keyboard navigation, preserve focus on the toggle, and retain
  Back to files on narrow screens. Verify menu/dialog focus, both themes, 1280×800/900 and
  390×844 with no page-wide overflow. See [verification](../file-browser-density-verification.md).
  Revisit for resizable panes or multiple file/editor documents.
- **File reading (accepted and implemented, owner correction 2026-10-27):** open files in
  an inline right-hand panel, keeping the file list usable on desktop. Do not use a centered
  modal or a backdrop for routine reading. On narrow screens show the reading panel with a
  clear Back to files action. Default Markdown to rendered content and keep an explicit
  source-editing action; preserve unsaved drafts when switching files, changing file systems,
  or closing the panel. Keep save failures recoverable in place. Reuse TiUI Paper, Tabs,
  Textarea, Table, and CodeBlock; semantic document markup is appropriate for Markdown.
  Treat content as untrusted: no raw HTML execution, unsafe links, or automatic remote image
  fetches. Add new formats only when the storage contract supports them. Verify both themes,
  desktop/narrow layouts, keyboard/focus, rendering boundaries, and save/discard flows; revisit
  this policy when adding binary or streaming storage. See [verification](../file-preview-verification.md).
- **Preview fallback (accepted and implemented, owner correction 2026-10-27):** preflight
  file size, text shape, and supported type before parsing or highlighting. Preview budgets
  are independent of storage/upload limits. If a budget is exceeded or content cannot be
  rendered, explain why in the existing panel and keep Download and navigation available;
  do not force an expensive source fallback. Isolate renderer exceptions from the workspace.
  Preserve editable text drafts and label their download as Download draft. Verify boundary
  sizes (including UTF-8), complex/invalid content, recovery after correction, and downloaded
  bytes. Current budgets are documented in [file preview verification](../file-preview-verification.md);
  Live file metadata now gates bounded preview reads before content transfer; binary/oversized files disable source editing and keep authenticated Download available. See [ADR 0004](../decisions/0004-drive9-anonymous-provider.md). Revisit budgets with measured renderer performance.
- The selector offers Light, Dark, and System; map the visible System option to TiUI `auto`.
  Use the library's persistence/system support. Migrate the current `tidb-workspace-theme`
  preference once (`system` → `auto`) so integration does not reset a user's selection.
  Do not leave two independent theme controllers applying conflicting root attributes.
- Verify startup, reload, tab synchronization, system selection, overlays/portals, forms,
  tables, code, charts, disabled states, and validation errors in both modes. Do not use
  CSS inversion or only darken the outer page.
- At narrow widths stack form fields and permission choices. Keep theme/navigation controls
  reachable. Let wide data tables scroll inside their container; avoid page-wide overflow.
- Preserve focus visibility, labels, semantic headings, keyboard navigation, Escape/focus
  return in dialogs, reduced motion, and sufficient contrast. Inspect the rendered result;
  using a library alone does not prove accessibility.
- Keep business rules and authorization in domain/backend code. TiUI changes presentation,
  not the Workspace Key permission model. Include loading, empty, denied, failure, and
  success states in the feature design.

## Migration status and completion evidence

The Console now imports TiUI controls throughout its nine destinations and database-scoped
SQL editor. The original global control styling, Lucide dependency, and independent theme
controller have been removed. The only native input is the hidden browser file chooser;
standard semantic HTML remains appropriate for page/domain composition.

| Area                                 | Implementation                                                                        | Evidence                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Package, peers, stylesheet, provider | TiUI 2.9.1; compatible React 18; strict npm peers                                     | Lockfile, `src/main.tsx`, WorkspaceThemeProvider, clean install/build |
| Typography and density               | Self-hosted Inter; 16px body, 32px page titles, 48px actions/inputs                   | Shared theme/heading adapters; computed browser sizes                 |
| Controls and dialogs                 | TiUI Buttons, inputs, Checkbox, Fieldset, Modal, Drawer, Alerts                       | Resource/Key/file workflows and keyboard verification                 |
| Navigation and data views            | TiUI AppShell, NavLink, Breadcrumbs, Tabs, Table, Card, Paper                         | Desktop/narrow screenshots and route checks                           |
| Theme                                | One persisted TiUI preference and resolved provider mode                              | Legacy migration tests; Light/Dark/System, reload and tab checks      |
| Icons and SQL                        | Official icons; TiUI SQL Editor 0.0.6 with MySQL/PostgreSQL/standard SQL highlighting | Query, sample, error, route, theme, and shortcut verification         |

See the [verification record](../tiui-migration-verification.md) for screenshots, checked
viewports, exact workflows, and limitations. Backend/cloud integration remains unchanged.

## Verified integration findings

- **Style composition (2.9.1):** upstream component `styles` values are functions. Mantine's
  deep merge of a plain object into such a function produces an empty object: even the
  override disappears. Use TiUI's public `mergeStylesList([baseStyles, overrides])`, as in
  `useWorkspaceThemeOverrides`, preserving upstream variants, colors, and pseudo selectors.
  Style functions receive the final resolved theme; do not capture a light-only palette.
  Check actual computed styles and both modes after any theme extension or TiUI upgrade.
- **Fonts:** the upstream stack names Inter but does not supply its font file. The application
  self-hosts the pinned Fontsource Latin variable face; other scripts use the upstream
  language/system fallbacks. No external font service is required.
- **Theme storage:** `useColorScheme` stores JSON. The shared migration maps legacy plain
  `system` to `auto`, preserves Light/Dark, and removes the old key only after a successful
  write. Keep only this root hook; use context for the selector and `useComputedColorScheme`
  for resolved editor mode. Storage failures must still allow rendering.
- **Dialog lifetime:** TiUI returns focus on an `opened` transition. Workspace dialogs are
  conditionally mounted, so the shared modal adapter also captures/restores the connected
  trigger on unmount. For a Menu item opening such a dialog, focus the stable menu trigger
  before mounting it and suppress the menu's delayed return-focus handoff; ordinary menu Escape
  should still return focus. The file browser verifies both paths. Preserve focus trapping,
  Escape, labels, and keyboard verification.
- **Portal Escape (2.9.1):** a Popover closes on Escape without marking the React event
  handled; portal keyboard events can bubble through their React parent. The inline file
  panel handles its own Escape only when the event target belongs to its physical DOM.
  This keeps Limits/Samples Escape from closing the file or canceling work. Recheck nested
  popup focus return and direct-panel Escape when changing TiUI or shared tool components.
- **Browser item contrast (2.9.1):** the active NavLink description used a dark text color
  against the dark selected-row background during browser inspection. The shared browser
  item uses the supported `styles.description.color = 'inherit'` override so metadata follows
  the resolved row text color in both themes. Keep this in the shared adapter and recheck on
  upgrades; do not compensate with a separate hard-coded palette.
- **NavLink action spacing (2.9.1):** upstream default props set logical `px=8` and `py=4`.
  These override a shorthand `p` and can override a styles-API physical `paddingRight`.
  The shared item uses explicit `px`/`py` and `pe` to reserve space for sibling actions.
  Keep the existing compact vertical padding; check that disclosure and query/menu icons do not
  overlap in either theme or at 390px. Revisit when upgrading TiUI or changing row actions.
- **SQL extensions (0.0.6):** scope the editor cache to the database route, synchronize sample
  changes through the editor view, and keep callbacks current. CodeMirror's default
  `Mod-Enter` inserts a blank line: use `Prec.high(keymap.of(...))` for Run query. Put density
  overrides before the official syntax theme so extension precedence preserves readable
  type. Recheck shortcuts, selection, dialect switching, disposal, and theme changes on upgrades.
  SQL Editor 0.0.6 consumes `extraExts` only when creating its cached editor; changing that prop
  does not reconfigure an existing instance. Use a CodeMirror `Compartment` and editor-view
  dispatch for dynamic editability, and verify `contenteditable` during and after execution.
- **Compatibility:** pin React/React DOM/types to 18 while the official SQL Editor and
  transitive dependencies require it. Group updates, keep the scoped Dependabot hold and
  strict peer installation, and revisit them together when upgrading the editor. Do not
  infer React 19 compatibility from the UIKit root peer range alone.

For each UI PR: cite the TiUI version/component reference; identify shared overrides and
remaining gaps; run `npm run check`; inspect light/dark desktop and narrow layouts (including
at least 1280px and 390px widths); inspect keyboard and relevant async/error states; attach
screenshots. Claim TiUI adoption only for components actually migrated. CI currently checks
document routing and application health, not visual fidelity.

DuckDB is a customer database type with internal storage. Its create form, database pages and Key targets show DuckDB only; do not add its backing File System to Console navigation or permissions. Native worker/runtime configuration belongs in operator docs, not customer workflows. See [ADR 0008](../decisions/0008-duckdb-private-storage.md).

Following the owner's native-database correction in [GH-50](https://github.com/siddontang/tidb.ai/issues/50),
DuckDB uses the ordinary database workspace: Tables, SQL Editor and results. Do not present
selected-file snapshots as the database model or add a file-source picker/counter to its SQL
Editor. The retained query-source API is an optional analysis capability; Console file analysis
belongs under File System Analyze. This supersedes the earlier Console picker guidance in
[ADR 0009](../decisions/0009-duckdb-file-sources.md). Revisit when explicitly designing native
file import/access with its own authorization boundary; a UI shortcut cannot imply that support.

For db9 PostgreSQL resources, use the existing database page and PostgreSQL dialect. Show the
actual db9 provider, anonymous availability and its NUMERIC precision boundary in Details.
Do not label it TiDB Cloud PG Starter or expose native connection credentials. Creation and Key
resource selection follow the capability response; see [verification](../db9-verification.md).
