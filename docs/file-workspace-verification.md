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
Original Download remains available; unsaved text retains Download draft. Parquet has no text
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
