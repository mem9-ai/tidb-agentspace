# Database and File System tutorials

The owner's 2026-10-31 correction requires onboarding to continue beyond resource creation,
with supplied data, an executable operation, expected output, and a way to return later.
The canonical rule is in [product experience](standards/product-experience.md).

## Implemented behavior

Tutorials is a permanent navigation destination (`#tutorials`). Existing first-use guides link
to the corresponding tutorial through **Try with sample data**. Tutorials can select an existing
resource or open the existing contextual create dialog. Creation returns to the tutorial with
the actual returned resource selected. Normal resource creation and Connect an agent retain
their existing flows.

- Live MySQL, db9 PostgreSQL and DuckDB tutorials import the fixed six-order CSV into a
  uniquely named table through the existing destination-bound, create-only database import
  operations. The Load action confirms this visible dataset and its schema: `id BIGINT`,
  `region TEXT`, `amount BIGINT`. The parsed six rows and fields must match before committing. PostgreSQL
  uses `workspace`; DuckDB uses `main`. Local database demos use the three preloaded `agent_events`
  instead of unsupported writes and remain visibly labeled.
- The File System tutorial explicitly saves the same six-row CSV at a unique root path, checks
  SQL analysis availability and analyzes the saved snapshot as table `file`. Live uploads use
  the existing create-only upload operation; local files use the UTF-8 files operation.
- Regional sales are **AMER 90, APAC 240, EMEA 180**, totaling **510**. The actual results,
  expected totals and shared Export action appear in the tutorial. Mismatches remain explicit.
- Open sample continues to the exact table's SQL editor or file Preview/Analyze. The resource
  header's Tutorial button returns to its resource-specific tutorial. File navigation preserves
  the existing Keep editing / Discard changes guard.
- Overview's **Your tutorials** lists attempted samples, including completed tutorials. Continue
  tutorial and Revisit tutorial retain the exact sample through `#tutorials?resourceId=…` links.
  Missing linked resources show an unavailable state rather than selecting another resource.

Sample identity, loading state and completion are saved with the Workspace in encrypted regional
metadata, independently of browser storage and API process lifetime. Another browser signed into
the same Workspace can find the same tutorials on Overview and continue with the original table
or file. Refresh tutorials reads current Workspace state. Reopening does not create, overwrite
or execute data; results are fetched again only through Run. An uncertain write offers a read-only
check and is never replayed automatically. An explicit new sample name keeps previous data intact.

Valid older browser records migrate create-only for current resources. Existing Workspace state
wins over stale copies, including concurrent migrations. Migration retains the exact sample and
uncertain state without provider/data I/O. A failed migration is recoverable; the old browser copy
is retained but cannot authorize operations as a fallback. Loading or unavailable Workspace progress
blocks tutorial actions, with an explicit retry. Attempted progress must be acknowledged before
sample writes. Unknown save responses cause observation, never automatic write retries.

Progress is an Owner-reported bookmark, separate from persisted results or an execution audit.
Ordinary sample data remains in its resource until deleted or expired; a saved completed bookmark
does not extend resource lifetime or prove that data is unchanged. No provider secrets or additional
Workspace Key privileges are stored. The persistence decision and rollout boundary are in
[ADR 0033](decisions/0033-workspace-tutorial-progress.md).

## Workspace progress API

All paths below are relative to `/api/v1/workspaces/{workspaceId}` and require an authenticated
Workspace Owner session (Account, Guest or explicit local mode). Workspace Keys cannot use them.

| Operation                                             | Outcome                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /tutorials?limit=100&cursor=…` (`listTutorials`) | Resource-ID-ordered page and `nextCursor`; at most 100 records per page |
| `GET /tutorials/{resourceId}` (`getTutorial`)         | Exact bookmark with strong ETag; no sample query                        |
| `PUT /tutorials/{resourceId}` (`replaceTutorial`)     | Create with `If-None-Match: *` (201), or replace using `If-Match` (200) |

PUT accepts `{sampleId, state}` with a 32-character lowercase hex ID and state `pending`,
`attempted`, `ready` or `completed`. The response adds resource identity, update time and `version`
(including quotes), equal to the ETag header. A version condition is required (428); malformed
conditions fail with 400 and stale conditions with 412 before changes. Observe after an unknown
acknowledgement. No API call here loads or runs a sample. Progress is not exposed in the public file
API or the bootstrap projection, and never broadens database/file permissions.

## Verification and limits

Live TiDB verification on 2026-10-31 found that the original `CREATE TABLE AS SELECT` sample
failed even though ordinary SQL queries worked. TiDB documents that statement as unsupported
in its [MySQL compatibility reference](https://docs.pingcap.com/tidb/stable/mysql-compatibility/).
Tutorial loading now reuses the supported database import path instead of assuming cross-provider
DDL compatibility. `tutorial-import.test.mjs` verifies exact destination/schema, rejection of
unexpected parsing, and no replay after an uncertain commit. Preparing a CSV is read-only;
progress becomes write-attempted immediately before the commit, so preparation failures do not
incorrectly block a safe retry. Arbitrary customer imports retain the normal review dialog.

`tutorial-progress.test.mjs` covers independent browser stores sharing Workspace progress,
Workspace/resource isolation, legacy migration with uncertain writes, stale-browser conflicts,
unknown save acknowledgements and unavailable API/blocked browser storage. Navigation tests
preserve exact identities across encoding, reload and history.

`e2e/tutorials.spec.mjs` runs the production Console with the existing isolated API fixture:
sample load/query, expected rows, creation handoff, explicit execution, an isolated browser's Overview
re-entry, unchanged sample names/no duplicate writes, uncertain-write checking, missing links,
both resource headers, legacy migration, unavailable/unknown progress and the unsaved-file guard.
The second context has empty browser progress and still explicitly reruns both original samples.
It runs in Light/Dark at 1280×800 and 390×844.
The full existing browser suite checks compatibility with the other Console journeys.

These browser fixtures verify the Console's request/response behavior. They do not establish
cloud provisioning or provider compatibility. Native `tutorial-cases.mjs` scenarios through
remote and embedded Meta prove owner-only authorization, two-Workspace/resource isolation,
input/precondition validation, concurrent conflict handling, pagination, crash/restart durability
and no provider I/O. `contract.test.mjs` validates the new public operations and response schemas.
No provider adapter, grant, credential or dependency changes; the retired Node backend stays retired.

`server/test-support/tutorial-sample-cases.mjs` also exercises the reviewed six-order CSV through the Rust
import and file analysis APIs, checks the expected aggregate, denied analysis, duplicate
import prevention and crash recovery. Its SQL provider is a fixture; it does not establish
live database-provider compatibility.

Representative current-build screenshots:

- [Overview, Desktop Light](screenshots/tutorials/resume-desktop-light.png)
- [Overview, Desktop Dark](screenshots/tutorials/resume-desktop-dark.png)
- [Overview, Narrow Light](screenshots/tutorials/resume-narrow-light.png)
- [Overview, Narrow Dark](screenshots/tutorials/resume-narrow-dark.png)

Validation commands: `npm run check`, `npm run backend:check` and `npm run test:browser` under the pinned runtime.
The PR records the evaluated source revision and the actual latest-head CI results.

The GH-76 transport update uses POST `/database-import-preparations` with a 201 review entity (`id`), then POST `/database-imports` with that `preparationId`. It preserves this tutorial's fixed dataset confirmation and uncertain-write boundary; rendered steps are unchanged.
