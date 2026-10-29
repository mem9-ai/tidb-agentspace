# GH-79: Contextual original-file and output export

- Status: Owner-approved direction; implementation follows the merged design revision.
- Intent: [GH-79](https://github.com/siddontang/tidb.ai/issues/79), Siddon Tang.
- Source: `d09b278f4eca2cb392bd48be0d37a1834cbeab52`; depends on ADR 0010, 0013 and 0017.
- Endpoint: evaluated source, green CI, merged implementation and refreshed local preview.

## Outcome and scope

Preview operates on the saved original file; execution results operate on the completed SQL
result or selected Bash stdout/stderr. Label Download original explicitly and remove the
original-file footer from result views. Source drafts retain Download draft and disable
saved-original copy/import until saved/discarded. Switching contexts never reruns a script.
SQL retains its existing snapshot export destinations. Add the same three destinations for
originals and Bash output: computer download, public Workspace File System and new database table.

Original downloads reuse the authenticated content endpoint (local text uses the existing
download adapter). Original File System copies preserve every byte. Bash raw downloads and
saved files preserve the selected stream exactly. Treat stdout/stderr as independent outputs;
show exit status and the selected stream, including empty/nonzero-exit results. Do not infer
CSV merely because output resembles a table. Parsed database import is explicit and previewed.

## API and confirmation contract

Add `POST /workspaces/{workspaceId}/file-exports/prepare` and `/file-exports`.
Sources are `{kind:"original",resourceId,path}` or
`{kind:"output",resourceId,stream:"stdout"|"stderr",text}`. Output is a bounded client-supplied
snapshot with authorization context, not attested command lineage; never accept a script.

Prepare accepts a source and explicit parsing options: CSV (header flag and comma/tab/semicolon/
pipe separator), Parquet (original files only), or text lines (one TEXT field per logical line).
No JSON record reader, arbitrary SQL, custom native types or provider/host paths are added.
CSV begins as strings, preserving leading zeros/precision; unquoted empty cells are NULL and
quoted empty strings stay empty. Offer conservative BIGINT/BOOLEAN suggestions only for exact,
canonical values; decimals/mixed/nested values default to TEXT. Parquet native schema supplies
suggestions with a conservative TEXT fallback. Users review column selection/names and one of
TEXT/BIGINT/DOUBLE/BOOLEAN. Conversion failure identifies the field/row without writing a table.

Prepare never writes. It returns at most 20 sample rows, exact bounded row count, suggested
fields and an opaque preparation ID. Keep the full parsed snapshot server-side for five minutes,
bound to the exact owner session/Key and source. Retain at most eight preparations per process,
with finite parsed-data memory; expire/evict explicitly. No persistence, secrets or audit values.
Parsing uses credential-free disposable workers, the shared two-worker budget, 16 MiB original
input/1 MiB output text, 1,000 rows/100 columns/1 MiB parsed result and 15-second deadline.
Reject excess rows instead of silently importing a sample. CSV/Parquet and line preparation
must be bounded before the complete result is materialized/serialized beyond its budget.

Raw export accepts source and download/File System target. Original download stays on the
existing content API; output download returns UTF-8 content. File targets create only. For
binary original copies, live targets preserve bytes; local text-only targets reject invalid
UTF-8 instead of replacing bytes. Existing upload/provider limits remain authoritative.

Database export accepts preparation ID, `confirmed:true`, reviewed field mapping and target
resource/table. The preparation supplies the rows; clients cannot substitute them at commit.
Check field selection, names, types, conversions and both CREATE/INSERT budgets before writes.
For originals, reject changed saved bytes since prepare. Consume a preparation when writing
starts, including uncertain outcomes; concurrent/repeated commits cannot create another table.
Validation/conflict before effects keeps the form recoverable; require a new preparation after
an uncertain database write. Reuse create-only/partial-write/no-retry semantics from ADR 0013.

## Authority, compatibility and UI

Authorize before source metadata/bytes/worker I/O. Original download/copy needs files:read and
its resource; preparation/import additionally needs files:analyze. Output operations need read
plus analyze on the source File System. File targets need files:write and their grant; active
live database targets need queries:execute and their grant. Recheck current expiration,
revocation, source/target grants before each write. Hidden DuckDB backing storage is never a
source or target. Provider keys remain in adapters; no user worker receives them.

Only new routes accept an 8 MiB JSON envelope (to encode at most 1 MiB output text); existing
request limits remain unchanged. Reject unknown fields/options and forged/expired/foreign
preparations with structured errors. Disconnect cancels preparation; source/target writes have
the existing explicit uncertain-outcome guidance. No overwrite/append/compensating DROP.

Use shared TiUI destination controls and the existing theme/modal/execution/result adapters.
Every dialog identifies Original file, SQL result or Bash stream; database import separates
Parse and review from explicit Confirm and create table. Changing format invalidates a prior
preparation, and changing stream cannot accidentally export another stream's reviewed rows.
Keep drafts/results, retryable form inputs, busy locking, focus return, readable text, both
themes and internal scrolling. No automatic export on parsing or switching destinations.

## Acceptance

| ID    | Observable requirement                                                                                                                                                                         | Evidence                                  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| FE-01 | Preview original actions and result-only export labels follow current content/method; no original Download appears beneath output; drafts protected                                            | Browser/interaction checks                |
| FE-02 | Raw output bytes and binary original copies round-trip; local binary rejection; empty/stderr/nonzero-exit output; conflicts preserve destinations                                              | API/adapter tests                         |
| FE-03 | Quoted/multiline CSV/header/separators, leading zeros, exact BIGINT, Parquet and explicit text lines; mapping/types reviewed; invalid casts and row/column/output budgets reject before writes | Native parsing/planning tests             |
| FE-04 | Missing grants/scopes, cross-workspace/foreign/expired/revoked handles, injected options and hidden storage denied before I/O; revocation rechecked before CREATE/INSERT/PUT                   | HTTP spies/failure injection              |
| FE-05 | Preview creates nothing; file version changes, duplicate commit, TTL/eviction, cancellation and shared admission are safe; partial writes remain explicit without retries                      | Service/API tests                         |
| FE-06 | Original/output/SQL workflows across all targets, no rerun, success navigation, keyboard/focus/busy/error recovery; Light/Dark 1280×800 and 390×844, no page overflow                          | Browser screenshots and regression checks |

## Delivery and recovery

Limit changes to exports, file context, shared destination adapters, fixed workers, API contract,
tests and canonical docs. Reuse pinned dependencies; no Ti CLI. Run targeted checks and full
`npm run check`, review the candidate and DCO, then current-head CI before authorized merge.
CI uses isolated fixtures/native DuckDB with no cloud credentials. Live validation may read
existing Singapore samples; write verification uses isolated fixtures, without provisioning
or altering real customer sources. Preserve other contributors' local Portal edits.

No stored resource/grant migration or production deployment. Restart loses preparations and
asks users to parse again; completed writes survive rollback. Existing SQL export API and file
download links remain compatible. Larger imports, append/overwrite, persistent jobs, external
connections and additional record formats require a later scoped design.
