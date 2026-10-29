# GH-76: Preview-first file workspace

- Status: Owner-approved direction; design baseline for implementation after this PR merges.
- Intent: [GH-76](https://github.com/siddontang/tidb.ai/issues/76), contributed by Siddon Tang.
- Source baseline: `e40989f22581a3c8308994a47d758197b6bdd9a8`.
- Dependencies: ADR 0010, 0014–0016, TiUI 2.9.1 and the existing selected-file workers.
- Delivery: reviewed implementation, passing current-head CI, merged source and local preview.

## Outcome and scope

Opening a file first explains its contents. SQL/Bash expands inside the same file workspace;
switching preview/results, hiding tools, changing methods or collapsing the browser preserves
in-memory drafts and completed results. Existing preview/analyze/source URLs still work.
Source editing remains explicit and guarded. No automatic custom SQL, full profiling, writes,
provider-hosted Exec, multi-file mount or persistent analysis session is introduced.

## Observable contract

Add `GET /workspaces/{workspaceId}/files/tabular-preview?resourceId=ID&path=PATH`.
Require `files:read` and the selected public File System grant before any metadata/byte I/O.
Reject unknown query inputs; accept only CSV/Parquet and no client SQL or engine configuration.
The server runs a fixed schema/sample operation in a disposable credential-free worker.
Reuse snapshot version checks and share the analysis concurrency budget. Input remains a whole
snapshot up to 16 MiB, with a 15-second deadline, 128 MiB engine/heap budgets, no spill/network,
at most 20 sample rows, 50 columns and 128 KiB serialized preview. This is not remote streaming.

Return resource/path/format, columns/types, sample rows/count, schema, `totalRows` (Parquet
metadata integer string, null for CSV), `typesInferred`, `truncated`, `fileVersion`, input bytes
and duration. Use the same DuckDB CSV interpretation as analysis. Never count all CSV rows
just for preview. A content digest identifies the saved bytes; analysis results add optional
`fileVersion` for compatibility with older clients. Compare it with preview and warn on change.

Unsupported, oversized, invalid, changing or excessive output files return structured errors
and retain Download/navigation in the Console. No automatic retries or fallback execution.
Cancellation cleans temporary files and releases the shared worker slot. Custom analysis
still requires both `files:read` and `files:analyze` and the selected resource grant. Preview
does not grant access to custom computation, native paths, siblings or provider credentials.

## Console behavior

- Default to the content/sample, with a labeled Analyze with SQL/Bash disclosure. Use discovered
  engine availability; CSV retains explicit SQL/Bash selection and independent drafts/results.
- Opening a legacy analyze URL expands tools. Hiding/reopening tools preserves state, runs
  nothing and is disabled during execution. No script/result goes into URLs or browser storage.
- Place tools above one shared content area. Data preview and Query result/Command output
  switch that area; Run selects its output, and preview remains reachable during errors.
- CSV/Parquet use server schema/types/sample. Mark CSV types inferred and its total unknown;
  label samples separately from full-file row count. Metadata remains compact, schema expandable.
- Text/log/Markdown retain their existing rendering and source-edit/download behavior. Dirty
  source disables saved-file analysis and clearly identifies the draft. Saving refreshes preview;
  version differences remain visible until preview is refreshed. Parquet has no source editor.
- Keep actual TiUI controls/editor, 16px readable content, semantic theme tokens, 44–48px targets,
  keyboard disclosures/focus and internal table scrolling at desktop and narrow widths.

## Acceptance baseline

| ID    | Required observation                                                                                                                                    | Evidence                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| FW-01 | Parquet sample/schema/types and exact metadata count; CSV quoted/multiline data and inferred types; 20-row/50-column/128 KiB budgets                    | Real worker tests                |
| FW-02 | Missing read/resource, revoked/expired/cross-workspace Key or injected query rejected before snapshot I/O; read-only Key can preview but cannot analyze | HTTP tests and I/O spies         |
| FW-03 | Size/version/parse/worker failures, cancellation and shared concurrency recover without exposing paths/secrets or leaking temporary files               | Worker/snapshot regression suite |
| FW-04 | Preview first, explicit expansion/run, legacy links, SQL/Bash drafts/results/errors retained through preview/output/method/tool/browser toggles         | Browser workflow                 |
| FW-05 | Dirty source save/discard guards, refresh/version warning, downloads, unavailable preview and unsupported formats remain usable                         | Browser and API checks           |
| FW-06 | Light/Dark at 1280×800 and 390×844; readable editors/tables, keyboard/focus, no page-wide overflow                                                      | Screenshots and DOM checks       |

## Execution, review and recovery

Change file feature modules, shared adapters only where needed, analysis/preview service,
contract generator/client, meaningful tests and canonical docs. Use fixture data for CI and
existing authorized Singapore sample files for bounded live reads; do not provision cloud
resources. Keep all existing grants and source bytes unchanged. Follow the prototype merge
policy and DCO sign-off. Run `npm run check`, inspect the diff and latest-head CI. Record the
accepted specification SHA and requirement evidence in the implementation PR.

Rollback restores previous Console/API code; no persisted data or permission migration is
required. Older API preview 404 is recoverable in place with Download; legacy analysis URLs
and capability fields remain supported. No production deployment is included.

No material open decisions remain. Large-file range reads, automatic profiling and durable
tool preferences are future work, not claims of this implementation.
