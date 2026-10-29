# Preview-first file workspace verification

- Intent: [GH-76](https://github.com/siddontang/tidb.ai/issues/76).
- Accepted specification: `specs/gh-76/spec.md` at
  `594905622630e0678b4a650b193fee0d77b75a9e` (design PR #77).
- Decision: [ADR 0017](decisions/0017-preview-first-file-workspace.md).
- Components: TiUI 2.9.1 Paper, Button, ActionIcon, Tabs, Table, SegmentedControl, Alert,
  Textarea and official icons; official SQL Editor 0.0.6, existing Workspace theme and shared
  execution/results/export adapters. No dependency, global typography or palette changes.

## User flow

Select a File System from its global list, then a file. Content/sample is primary; Analyze
with SQL/Bash expands tools above the shared content area. Run selects Query result/Command
output. Switching back to preview, hiding/reopening tools, changing CSV methods or collapsing
the browser retains the edited script and completed result. Merely opening, selecting a method
or expanding a tool never executes a user script. Existing analyze URLs expand tools on load.
Closing/navigating to another file still cancels execution and discards transient tool state.

Edit source is a secondary action. Dirty content is identified and blocks saved-file analysis;
Keep editing/Discard changes guards remain. Saving refreshes the fixed preview and capabilities
without discarding tools. An old result with a different saved-byte version gets a visible warning.
Original download remains available through the Preview header's Export dialog; unsaved text
retains Download draft and save controls in the header. Parquet has no text
source editor. Text/Markdown rendering remains bounded and isolated from renderer exceptions.

## API and bounds

`GET /api/v1/workspaces/{workspaceId}/files/tabular-preview?resourceId=ID&path=PATH` requires
`files:read` plus the selected public File System grant. It accepts no SQL/engine/limit input.
It uses the existing version-verified snapshot adapter and disposable worker, sharing the
analysis admission/deadline/credential boundaries. CSV and Parquet return columns/types/schema,
at most 20 rows/50 columns/128 KiB, `fileVersion`, and input/completion metadata. Parquet
`totalRows` is an exact integer string from metadata; CSV returns null and `typesInferred=true`.
No full CSV count/profiling runs on open. Both readers use DuckDB's existing CSV interpretation.
Analysis results add optional `fileVersion`; custom SQL/Bash still requires `files:analyze`.

The current preview still copies a whole input up to 16 MiB and has a 15-second deadline.
It is not a range reader or a large-file scanning service. Unsupported, oversized, invalid,
changing and excessive-output input retains an explanation, Retry/Download and navigation.
An older API can return preview 404 while retaining legacy analysis capability; the Console
keeps a recoverable preview fallback. No data/grant migration or cloud provisioning is needed.

## Acceptance evidence

| Requirement | Observed verification                                                                                                                                                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FW-01       | Native worker tests cover quoted/multiline CSV, inferred types, Parquet exact count/schema including zero rows, 20-row truncation, 51-column rejection and 128 KiB output rejection. Preview and SQL return identical CSV values and saved-byte digests.                                                                                                       |
| FW-02       | HTTP tests use I/O spies: missing read, wrong resource, expired/revoked/invalid Keys, another workspace, injected SQL/settings and traversal are denied before snapshots. A read-only Key previews successfully but cannot execute custom SQL. Generated contract tests exercise the new response.                                                             |
| FW-03       | Shared admission/cancellation and temporary-directory cleanup tests cover preview versus analysis. Existing snapshot tests retain ETag/size checks, growth/version rejection and bounded/canceled provider streams. Real workers reject malformed Parquet and excessive inputs/output without exposing native paths.                                           |
| FW-04       | Browser: SQL aggregate returned APAC 30/EU 20; draft/results survived preview/output, tool, CSV SQL/Bash and browser toggles. Bash grep returned the selected CSV lines. Legacy analyze links expand the tool.                                                                                                                                                 |
| FW-05       | Isolated local fixture: source edit triggered the existing Keep/Discard guard; Keep retained the draft. Save refreshed preview, showed the old-result version warning, and rerunning recovered. No real source was written. Download/export controls remain in the shared adapters.                                                                            |
| FW-06       | Light/Dark inspected at 1280×800 and 390×844. Editor is 16px, table cells retain the shared 15px table setting; controls remain 44–48px. Wide data scrolls internally. After responsive reflow settles, document width equals viewport width. Tool/browser disclosures retain labels/expanded/controls semantics and hidden editors leave keyboard navigation. |

Bounded live verification read the existing Singapore `orders.parquet` (526 bytes, 4 rows,
3 columns). Fixed preview succeeded, and explicit DuckDB aggregation returned APAC 30/EU 20.
The existing 176-byte service log returned two ERROR lines through explicit Just Bash grep.
An active SQL query disabled tool hiding and canceled in place; the editor recovered.
Credentials stayed in the API's private provider adapter; the browser/worker received no provider
key. The review API used a private local copy of existing state/vaults to avoid changing the
shared runtime during validation. No cloud resource, file or database was created or changed.
CI uses only fixtures without cloud credentials.

Screenshots show the existing live file. Narrow images capture the full page at a 390×844
viewport so preview/tool controls below the fold remain reviewable:

- [Dark preview, 1280×800](screenshots/unified-file-workspace/parquet-preview-dark-1280x800.png)
- [Light preview, 1280×800](screenshots/unified-file-workspace/parquet-preview-light-1280x800.png)
- [Dark SQL, 1280×800](screenshots/unified-file-workspace/parquet-sql-dark-1280x800.png)
- [Dark preview, 390×844](screenshots/unified-file-workspace/parquet-preview-dark-390x844.png)
- [Light preview, 390×844](screenshots/unified-file-workspace/parquet-preview-light-390x844.png)
- [Light SQL, 390×844](screenshots/unified-file-workspace/parquet-sql-light-390x844.png)

The implementation PR records the final candidate, full local check and remote CI results.
Known build warnings remain the pre-existing large bundle and transitive phone-library eval
warnings. Public compute isolation, durable query sessions, provider Exec and large remote
scans remain outside this change.

## Result navigation correction (GH-82)

Owner feedback on 2026-10-29 identified a disabled Query result tab in the initial preview
as an apparent Analyze entry that could not be clicked. This small fix follows
[GH-82](https://github.com/siddontang/tidb.ai/issues/82), reproduced against
`aa286c42b1ea5e613d4ac026f725792dcb0bcc91`. It refines the existing preview-first interaction;
there is no API, permission, provider, dependency or persisted-data change.

Initial preview and an expanded but unexecuted editor now show no result navigation. Explicit
Run reveals usable preview/result tabs and selects the running result. Completed, failed and
canceled execution retains those tabs. Hiding tools or switching methods preserves each
method's draft/result. A method with no execution shows preview; selecting a sample that clears
execution also returns to preview and its original-file actions. Preview/result panels remain
mounted; hidden navigation is absent from both the visible interface and keyboard tab order.

Browser checks used a private local copy of the existing workspace state with the same
Singapore file provider. Existing Parquet/CSV samples were read; no cloud resource, file or
table was created or changed. Observed checks:

- Initial Parquet and unexecuted SQL/Bash: no visible result tabs; preview and Download original
  remain available. Merely expanding Analyze does not execute a script.
- SQL aggregation returned APAC 30/EU 20. Result tabs are enabled; arrow keys switch preview
  and result. Hiding/reopening tools retains the query/result and result export.
- Invalid SQL retains a recoverable error tab. Run exposes result navigation while busy and
  disables hiding tools; Cancel keeps the cancellation message reachable.
- Selecting Preview rows after an error clears execution, removes result navigation, and
  restores preview/original actions rather than leaving an empty result panel selected.
- CSV Bash grep returned two APAC lines. Switching to unexecuted SQL shows preview with no
  result tabs; returning to Bash restores its command/output and Export output. Original-file
  controls remain absent from the result view. Export dialogs retain their source labels.
- Light/Dark at 1280×800 and 390×844: no initial result navigation, readable preview/actions,
  no document overflow. Narrow SQL execution also reveals usable tabs and results. Existing
  TiUI 2.9.1 Tabs, supported layout props, shared theme and SQL Editor 0.0.6 remain in use.

Screenshots are full-page captures at the named viewport, so controls below the fold are visible:

- [Initial Dark, 1280×800](screenshots/file-result-discovery/initial-dark-1280x800.png)
- [Initial Light, 1280×800](screenshots/file-result-discovery/initial-light-1280x800.png)
- [Initial Dark, 390×844](screenshots/file-result-discovery/initial-dark-390x844.png)
- [Initial Light, 390×844](screenshots/file-result-discovery/initial-light-390x844.png)
- [Completed Bash result, Dark desktop](screenshots/file-result-discovery/bash-result-dark-1280x800.png)
- [Completed SQL result, Dark narrow](screenshots/file-result-discovery/sql-result-dark-390x844.png)

The PR records its candidate SHA, final `npm run check` and current-head CI. Browser interaction
checks cover this scoped presentation correction; backend behavior remains under the existing
152-test quality gate. Revisit the rule for persistent sessions or separate analysis routes.
