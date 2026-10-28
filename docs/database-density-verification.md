# Database workspace density verification

Owner-requested layout correction, 2026-10-28. Source baseline: `8fcab93` (PR #33 implementation plus the later file-source design).
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
scoped to its page, leaving other destinations and default tab spacing unchanged.

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
83 tests, strict types and independent builds). The PR records the candidate and CI result.
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
