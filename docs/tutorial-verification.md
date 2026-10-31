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

Selection, sample identity/readiness and verified completion are stored by workspace/resource
in this browser's local storage, with session/in-memory fallback and migration from earlier
session-only state. Reopening does not create, overwrite or execute data. Results are fetched
again only through Run. An uncertain write offers a read-only check; it is never replayed
automatically. An explicit new sample name keeps any previous sample intact.

Browser progress is not account-synced history. Clearing storage or switching browser/device
loses these convenience links; ordinary sample data remains in the selected resource until
deleted or expired. No saved query results, provider secrets or extra API privileges are stored.

## Verification and limits

Live TiDB verification on 2026-10-31 found that the original `CREATE TABLE AS SELECT` sample
failed even though ordinary SQL queries worked. TiDB documents that statement as unsupported
in its [MySQL compatibility reference](https://docs.pingcap.com/tidb/stable/mysql-compatibility/).
Tutorial loading now reuses the supported database import path instead of assuming cross-provider
DDL compatibility. `tutorial-import.test.mjs` verifies exact destination/schema, rejection of
unexpected parsing, and no replay after an uncertain commit. Preparing a CSV is read-only;
progress becomes write-attempted immediately before the commit, so preparation failures do not
incorrectly block a safe retry. Arbitrary customer imports retain the normal review dialog.

`tutorial-progress.test.mjs` covers tab/session reopen, workspace/resource isolation, migration
of an uncertain write, blocked storage and malformed identifiers. Navigation tests preserve
exact identities across encoding, reload and history.

`e2e/tutorials.spec.mjs` runs the production Console with the existing isolated API fixture:
sample load/query, expected rows, creation handoff, explicit execution, a fresh tab's Overview
re-entry, unchanged sample names/no duplicate writes, uncertain-write checking, missing links,
both resource headers, and the unsaved-file guard. It runs in Light/Dark at 1280×800 and 390×844.
The full existing browser suite checks compatibility with the other Console journeys.

These browser fixtures verify the Console's request/response behavior. They do not establish
cloud provisioning, provider compatibility or backend authorization; the unchanged native
backend's API suites own that evidence. This PR changes no API schema, provider adapter, grant,
native serving code or dependency. It does not restore the retired Node backend.

Representative current-build screenshots:

- [Overview, Desktop Light](screenshots/tutorials/resume-desktop-light.png)
- [Overview, Desktop Dark](screenshots/tutorials/resume-desktop-dark.png)
- [Overview, Narrow Light](screenshots/tutorials/resume-narrow-light.png)
- [Overview, Narrow Dark](screenshots/tutorials/resume-narrow-dark.png)

Validation commands: `npm run check` and `npm run test:browser` under the pinned runtime.
The PR records the evaluated source revision and the actual latest-head CI results.
