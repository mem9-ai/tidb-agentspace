# Database workspace density verification

This records the earlier density/collapse corrections. The owner's later GH-48 correction
moves resource selection above both browser and working panel and gives both resource types
the same 320px browser. See [current resource workspace verification](resource-workspace-verification.md).

Owner-requested layout correction, 2026-10-28. Source baseline: `b78512d` (including the independently delivered file analysis feature).
This builds on the [unified workspace](database-workspace-verification.md) without changing
its API, provider, query budgets or draft lifecycle. The implementation PR records the exact
candidate and current CI result.

## Intended behavior

The table list, SQL Editor and initial query rows should share the first desktop screen in
normal active-database use. Keep 16px body/editor text, 32px database titles, existing 15px
result cells and 48px primary actions. Compact the header and repeated chrome instead of
shrinking text. Full expiry/region details and query limits remain available on demand;
write/demo labels and actionable errors remain visible.

Implementation uses TiUI 2.9.1 Popover, Menu, ActionIcon, Button, Table and Tabs plus the
existing official SQL Editor 0.0.6. Table row spacing uses its supported `verticalSpacing`
prop; CodeMirror height/scrolling uses the shared editor theme. Database-specific layout is
scoped to its page, leaving other destinations and default tab spacing unchanged. Editor
height/content variables retain their prior defaults for the File System analysis panel.

## Evidence

- Real Zero `workspace_notes` SELECT returned the two existing rows through both Run query
  and Cmd+Enter. No database/file writes, resource creation or new key was needed.
- At 1280×900, the editor begins around y=183 and the complete two-row result panel ends
  around y=820. At 1280×800 it ends around y=790. The prior verification screenshot had the
  editor panel starting around y=495 and results below the 900px viewport.
- Computed body/editor text: 16px; result cells: 15px; Run action: 48px. Page width matched
  both desktop widths and the 390px narrow viewport.
- Expand/Collapse changed editor height to 420px and back without changing SQL or results.
  Table inspection displayed the real columns; switching back retained the prior result.
- Details showed region, full expiry and export guidance. Limits showed query budgets and
  the execution shortcut. Escape closed the popover and returned focus to its control.
  Samples populated the editor without executing it; its shared theme preserves 16px menu
  text and 44px menu item targets. The mobile Details popover stayed
  inside the viewport; ArrowRight scrolled the result region internally.
- Light/dark desktop and 390×844 mobile layouts were inspected. Browser error logs were
  empty after the final build. Initial parallel-preview cookie interference was isolated
  in the disposable QA harness; the product authentication code is unchanged.
- Source review confirms that expired/provisioning/connection-error messages and Retry setup
  remain inline rather than hidden in Details. Live DuckDB execution is not repeated for
  this presentation-only correction; its existing provider/permission tests run in the gate.

Final validation: `npm run check` passed (runtime/policy, formatting, lint, generated API,
91 tests, strict types and independent builds). The PR records the candidate and CI result.
No new dependency or public contract change. Existing upstream `google-libphonenumber`
build warnings remain non-failing.

## Screenshots

- [1280×900 dark](screenshots/database-density/desktop-dark.png)
- [1280×800 light](screenshots/database-density/desktop-light-800.png)
- [390×844 light](screenshots/database-density/mobile-light.png)
- [390×844 dark](screenshots/database-density/mobile-dark.png)

## Limits

This is a first-screen target for ordinary desktop queries, not a promise to fit every row
or status in one viewport. Large result sets scroll inside their result region; long SQL
scrolls inside the editor and can be expanded. Narrow screens reflow vertically without
shrinking text. Long names, connection errors and expanded editing can require page scrolling.
No cloud mutation, new resource, credential or public deployment is required for this change.

## Compact table browser

Owner follow-up: [GH-46](https://github.com/siddontang/tidb.ai/issues/46), reproduced at
`3549f8248e5bbf5f8b2c45894a35f46c712ca621`. The database table navigator now shares
`src/ui/WorkspaceBrowserPanel.tsx` and `workspace-browser.css` with File System. This is
a presentation correction using the installed TiUI 2.9.1 Paper, ActionIcon, TextInput,
Typography, Group, Badge and NavLink. Existing SQL Editor 0.0.6, API and provider behavior
remain unchanged; the PR records the evaluated candidate and latest-head CI.

The desktop table browser is 280px wide, with a compact title/count/toggle row and a combined
filter/refresh row. Collapse leaves a 56px rail and returns 224px to the editor. On narrow
screens it becomes a horizontal disclosure. Browser children, editor and inspection stay
mounted; this preference lasts for the mounted workspace rather than surviving reloads.
File System retains its 320px browser and existing Back to files behavior.

Observed on the final implementation:

- At 1280×900, PostgreSQL browser/editor tops both measured y=183; table browser widths were
  280px expanded and 56px collapsed. At 1280×800/900 and 390×844, document width matched the
  viewport after responsive reflow. Inspected Light and Dark. SQL computed to 16px, filter
  height to 48px and the collapse target to 44px.
- A real PostgreSQL read (`SELECT 17 AS retained;`) retained SQL and its result through
  collapse/expand, table selection, table inspection, refresh and output-tab switching.
  Filter `agent` and the exact selected table URL survived. Keyboard Enter toggled both ways
  and focus stayed on the same button. While collapsed, Tab went directly to Database,
  skipping hidden filter, refresh and table links.
- A real DuckDB read (`SELECT 23 AS retained;`) continued while the navigator was expanded
  and collapsed during Running, then returned 23. SQL and results survived. The open source
  picker and its File System/directory selection survived a collapse; this check did not
  execute a file-source query or create a source file.
- An isolated local-demo fixture supplied 500 table entries, a long identifier without spaces,
  a view, empty and failed catalog responses. The desktop browser stayed 680px high at
  1280×900 with a 557px list viewport over 24,239px of content; horizontal list content stayed
  within 278px. At 390px, the list stayed within 356px. Keyboard ArrowDown moved list scrollTop
  to 99.5px. Truncation and view labels remained visible; filtering returned the expected ten
  matches. Failure preserved filter/collapse controls and Try again recovered to the empty
  table message. No provider was contacted for these synthetic cases.
- File System regression: an unsaved Markdown draft survived collapse/expand. The plus menu
  opened with Enter; New folder opened the existing dialog without creating a folder. Escape
  returned focus to the plus trigger. At 390×844, the preview hid the browser, Back to files
  protected the draft and Discard changes restored the flex browser with no page overflow.
  The local draft was discarded; no file contents were saved. An existing live File System
  status request reported unavailable during this session; file editing regression used the
  local demo and does not claim live File System recovery.

Validation: `npm run check` passed (118 tests, runtime/repository/format/lint/contract checks,
strict types and independent production builds). Existing upstream `google-libphonenumber`
build warnings remain non-failing. Browser tests cover the observed workflows above; no
new cloud resources, schema migration, authorization change or deployment was needed.

Screenshots:

- [1280×900 dark expanded](screenshots/database-browser/desktop-dark-expanded.jpg)
- [1280×900 dark collapsed](screenshots/database-browser/desktop-dark-collapsed.jpg)
- [1280×800 light filter empty state](screenshots/database-browser/desktop-light-empty-filter.jpg)
- [1280×900 light DuckDB collapsed](screenshots/database-browser/duckdb-light-collapsed.jpg)
- [390×844 dark collapsed](screenshots/database-browser/mobile-dark-collapsed.jpg)
- [390×844 light expanded](screenshots/database-browser/mobile-light-expanded.jpg)
- [1280×900 File System regression](screenshots/database-browser/files-dark-regression.jpg)
