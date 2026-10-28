# Shared Database and File System workspaces

- Owner correction: [GH-48](https://github.com/siddontang/tidb.ai/issues/48).
- Reproduction baseline: `9aad9eb122f4ceb19678bd17f67ee12d0afc0894`.
- Scope: presentation and resource-selection hierarchy. No API, provider, authorization,
  dependency or persisted-data change. The PR records the final source revision and CI result.
- Components: TiUI 2.9.1 Paper, NativeSelect, NavLink, Typography, Badge, Button, ActionIcon,
  Menu and Popover; existing official SQL Editor 0.0.6 and the shared Workspace theme.

## Layout and state ownership

Both pages now follow section heading/actions → selected resource/context → browser and
working panel. `ResourceWorkspaceHeader` and `ResourceWorkspaceBar` own the common top
composition. The database selector is above both Tables and SQL Editor, rather than inside
the editor while controlling a sibling table navigator. Database names remain visible in
that selector; resource type/provider and live/demo mode remain visible underneath/beside it.

The shared desktop browser is 320px wide, collapsing to 56px. `WorkspaceBrowserItem` uses
TiUI NavLink for the common icon/name/secondary-information/selection layout, with separate
44px row actions for files. Long names clamp visually to two lines while retaining their full
accessible name/title and exact path/identifier. File System now uses this browser before a
file is selected, with an explicit right-hand Select a file panel. The prior full-width file
table is superseded. File/folder details remain in each item and its selected-file panel.
Browser and file-preview height budgets are shared (500px at an 800px-tall desktop viewport,
600px at 900px); long preview content scrolls inside while header/footer actions remain
reachable. Analyze retains its existing page-flow expansion rather than clipping controls.

DuckDB file sources are inside SQL Editor. They retain the same selection, explicit Add/Query,
read-only snapshot and result-invalidation rules. The editor toolbar now identifies the tool
and its Run action; resource identity belongs to the outer resource bar. Existing database,
table and file URLs, route keys, data permissions and draft lifetimes remain unchanged.

On narrow screens the work area stacks. Tables can collapse to a horizontal disclosure;
selected files retain the existing Back to files flow. A file browser/placeholder is not
shown alongside a narrow selected-file panel. Wide query/preview tables scroll internally.

## Observed verification

| Case                       | Result                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop hierarchy          | At 1280×900 and 1280×800, both resource bars began near y=190 and browser/working panels near y=285. Browser widths matched at 320px. There is no Database selector inside `.sql-panel`; DuckDB sources are inside it.                                                                                              |
| Resource switching         | The top selector changed DuckDB to PostgreSQL, updating URL, provider caption, table listing and editor together. Previous results and DuckDB sources cleared. Existing missing-resource routing was preserved.                                                                                                     |
| Active query               | A real DuckDB `SELECT 1 AS connected;` returned 1 in 7,343ms while the browser was collapsed. The outer Database selector was disabled during execution; SQL and the completed result remained after expansion. No database write was executed.                                                                     |
| Edited SQL                 | PostgreSQL retained an edited `SELECT 11 AS keep_draft;` through table selection and the existing Query table → Keep my query dialog. The same draft survived narrow/desktop changes and collapse/expand.                                                                                                           |
| File preview               | The real Singapore README rendered successfully. Its identity/content remained through browser collapse and expansion. Only existing files were read.                                                                                                                                                               |
| File operations            | An isolated local-demo store created a folder and a file inside it through the plus menu. The dialog used the selected directory; both were then deleted through the row actions and confirmations. The source draft on another file survived creation and directory navigation. No real provider/file was mutated. |
| Unsaved files              | Switching the outer File system selector with a dirty draft kept the original resource selected and showed Keep editing / Discard changes. Keep editing and collapse/expand retained the draft. Selecting another file prompted the same guard.                                                                     |
| Mobile return              | At 390×844, the selected-file browser was hidden. Back to files → Keep editing retained the source draft; Discard changes restored the browser with no page overflow.                                                                                                                                               |
| Long names and empty state | The isolated store used a long file name and a second, empty File System. Full names remained in accessible labels/titles; the list stayed 356px wide without internal horizontal overflow at 390px. Switching to the empty File System showed the existing empty state and the desktop unselected-file panel.      |
| Theme and controls         | Light/Dark inspected at actual 1280×800/900 and 390×844 viewports, with document widths matching the viewport after responsive transitions settled. Keyboard menu/dialog/collapse actions and focus return were checked. Source/SQL text remains 16px; row actions and toggles retain 44px targets.                 |

The local fixture used a separate hostname from the live preview to isolate owner cookies,
with its own data, ports and Vite cache. Its temporary files were discarded after verification.
Browser error logs were empty in the completed live and isolated flows.

An installed TiUI 2.9.1 active NavLink description initially computed to dark text against
the dark selected-row background. The shared item adapter now uses the supported description
color override to inherit the resolved row color. Both selected names and metadata were
rechecked in Light/Dark; this avoids a second palette.

## Screenshots

- [Database, 1280×900 Dark](screenshots/resource-workspaces/databases-desktop-dark.jpg)
- [File System, 1280×900 Dark](screenshots/resource-workspaces/files-desktop-dark.jpg)
- [Database, 1280×800 Light](screenshots/resource-workspaces/databases-desktop-light-800.jpg)
- [File System, 1280×800 Light](screenshots/resource-workspaces/files-desktop-light-800.jpg)
- [Database, 390×844 Dark](screenshots/resource-workspaces/databases-mobile-dark.jpg)
- [File System, 390×844 Dark](screenshots/resource-workspaces/files-mobile-dark.jpg)
- [Database, 390×844 Light](screenshots/resource-workspaces/databases-mobile-light.jpg)
- [File System, 390×844 Light](screenshots/resource-workspaces/files-mobile-light.jpg)

## Limits

This does not introduce durable SQL drafts or make resource switches preserve old query
results; existing route-scoped behavior remains. Large file previews, expanded editors,
source pickers and results can require vertical scrolling. The activity/usage demo boundary
is unchanged. SQL/provider authorization and failure cases continue to run in the normal
test suite; no new cloud resources, credentials or deployment were required.

Validation: the final `npm run check` result is recorded in the implementation PR. It covers
runtime/repository policy, formatting, lint, generated API/client alignment, behavior tests,
strict types and independent Console/API builds. Browser observations above cover the visual
and interaction checks that CI does not prove.
