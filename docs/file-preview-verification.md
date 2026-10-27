# File preview verification

Verified on 2026-10-27 with TiUI 2.9.1 and React 18.3.1.

## Implemented behavior

The file reader is an inline TiUI Paper aside, with TiUI Tabs, Textarea, Buttons,
ActionIcon, Badge, Alert, Table and business CodeBlock. Desktop keeps the file list
available; narrow layouts show a Back to files action. There is no preview dialog,
backdrop, or focus trap. Opening focuses the file title; closing returns focus to the
selected file. Escape requests close, respecting unsaved changes.

Markdown uses pinned [react-markdown 10.1.0](https://github.com/remarkjs/react-markdown)
and [remark-gfm 4.0.1](https://github.com/remarkjs/remark-gfm) for headings, lists, tables,
tasks, links and code blocks. Raw HTML is skipped, unsafe/relative URLs are not active,
and embedded images display their alternative text without loading a remote resource.
JSON formatting preserves original number tokens, including IDs beyond JavaScript's safe
integer range. CSV handles quoted commas, escaped quotes, multiline fields and CRLF;
preview is bounded to 200 rows and 50 columns. Invalid JSON/CSV falls back to source text.
Common code files use TiUI syntax highlighting; other UTF-8 files remain readable as text.
Preview formatting never rewrites the stored source. The preview module is loaded on demand.

## Validation

- Added six regression tests covering format selection, lossless JSON formatting, CSV
  parsing/bounds/malformed input, Markdown document rendering, and HTML/URL/image safety.
- Browser checked at 1280 × 900 and 390 × 844, in light and dark modes. Markdown body
  computed to 16px; document width matched the viewport, with wide content scrolling inside
  the preview. Desktop action buttons remain visible while long content scrolls.
- Checked Markdown headings, emphasis, table, task list and fenced code; formatted JSON;
  CSV table; invalid JSON; empty file; switching files; source/preview tabs; saving while
  keeping the panel open; Keep editing and Discard changes; Escape and focus return;
  narrow-screen Back to files and opening at the panel header.
- Submitted a 256 KiB + 1 draft: the API rejected it, the error stayed visible and the draft
  remained intact. The original file remained unchanged. Successful edits updated the list
  and persisted through the existing API.
- Tests and browser mutations used an isolated temporary workspace. No cloud resources,
  customer keys, or personal workspace data were used.

The repository quality gate and latest-head GitHub CI results are recorded in the PR.

## Screenshots

| Viewport   | Light                                               | Dark                                               |
| ---------- | --------------------------------------------------- | -------------------------------------------------- |
| 1280 × 900 | [Desktop](screenshots/files-sidebar-light-1280.png) | [Desktop](screenshots/files-sidebar-dark-1280.png) |
| 390 × 844  | [Narrow](screenshots/files-sidebar-light-390.png)   | [Narrow](screenshots/files-sidebar-dark-390.png)   |

## Boundaries

The backend contract, authorization and storage limit are unchanged. The local demo accepts
UTF-8 text only; binary image/PDF/media previews and real cloud storage are not implemented.
Creation and deletion still use their existing dialogs. The file-level draft guard covers
switching files/systems, closing the panel and browser unload; it does not add application-wide
SPA navigation blocking. Save before leaving File System for another workspace destination.
