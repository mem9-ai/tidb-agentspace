# Browser verification

Status: accepted owner direction, GH-37 (2026-10-30). Applies to every contributor and
coding agent. Functional success is established by assertions; screenshots support visual
review and failure diagnosis. See [CI/CD](../ci-cd.md) for delivery gates.

## Choose the right layer

For internal backend changes preserving public HTTP behavior and the Console contract, use
[OpenAPI verification](openapi-verification.md). Native API tests are the acceptance boundary;
do not run frontend/browser tests or manually retest the Portal for that change. Console/client
or intentional public-contract changes retain browser checks, as do uncertain mixed CI scopes.
The trusted classifier and explicit native-backed applicability evidence are described in
[CI/CD](../ci-cd.md); a skipped browser job is not a passing browser test.

| Layer                   | Verify                                                                                | Command                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Unit and contract tools | Pure state, parsing, generated contracts, workflow/evidence policy                    | `npm run check`                                                                 |
| Native integration      | Actual Rust authorization, records/restart, S3, providers and compute boundaries      | [Native build and acceptance](../../CONTRIBUTING.md#rust-backend-modules)       |
| Browser smoke           | Rendered Console flows, URLs, form values, request payloads, focus and download bytes | `npm run test:browser` after building the Console                               |
| Visual review           | Changed typography, colors, spacing, clipping and overall composition                 | Inspect the affected states/themes/viewports and attach representative evidence |

An API mock verifies the Console's interaction contract, not backend authorization, provider
compatibility or cloud connectivity. Keep native coverage authoritative for those claims.
Native browser end-to-end provider coverage is future work; the current smoke suite does
not provision real cloud resources or start a second business backend.

## Current portable smoke suite

Playwright Test 1.64.1 is pinned in the npm lockfile. It drives an isolated Chromium process,
without depending on Codex/Claude/browser extensions. Tests serve the existing production
Console build on a dedicated loopback port and use a fresh browser context and synthetic
API state per test. Unexpected routes, page errors and external requests fail the fixture.
No persisted user session, personal data or provider credentials are loaded.

Every journey runs at 1280×800 in light mode and 390×844 in dark mode. Cases tagged
`@visual` also run at 1280×800 in dark mode and 390×844 in light mode. Tag representative
cases for screens, previews and states whose layout or rendering needs all four combinations;
behavioral, permission and security assertions remain in both default viewports. For a
change whose risk requires the entire matrix, set `BROWSER_FULL_MATRIX=1` when running the
suite. The covered journeys include:

- Actual sidebar entry from Databases and a selected File System, with zero/one/multiple
  resources, collection reload/history and unavailable resource links; never auto-select.
- Four contextual creation forms, readable File System suggestions, type-prefixed database names,
  readable fields and focus return.
- Automatic/manual name transitions, empty-name submission, explicit conflict retry and
  exact returned-resource navigation.
- Explicit Key resource/action grants, creation payload and one-time synthetic secret display.
- File System collection entry, inline Markdown, unsaved-draft protection and original-file
  download identity/bytes.
- Matching collection empty states and creation actions, populated metadata/Open/Connect/return,
  direct named-resource Overview entry and direct scoped Key creation from Connect.
- Independent first-use guides for missing resource categories, Guest expiry, explicit creation,
  and a first query result using synthetic data.

Use semantic roles and labels, scoped to a dialog/region when names repeat. Use web-first
assertions (`toBeVisible`, `toHaveValue`, `toHaveURL`, `toBeDisabled`) and request/download
events. Do not use coordinates, fixed sleeps, DOM order guesses or screenshots as functional
pass conditions. Small DOM measurements can assert overflow and control sizes; they do not
establish visual fidelity. Keep assertions about observable behavior, not implementation details.

```sh
npm ci
npx playwright install chromium
npm run build:console
npm run test:browser
```

The suite reuses a built artifact; it does not rebuild or connect to a user's active preview.
CI builds the same candidate independently of Quality, installs only Chromium and runs two
workers. This small duplicate build lets both gates run in parallel. CI allows one diagnostic retry and fails on flaky tests: a retry cannot
turn an initial failure into an accepted change. No retries are enabled locally by default.

## Diagnose failures and inspect changes

Use `npm run test:browser:ui` to step through a local test. CI records a trace on the first
retry; local failures retain a trace. Open one with
`npm run test:browser:trace -- /absolute/path/to/trace.zip`. The trace includes the action
timeline, DOM snapshots and network activity, making it more useful than a screenshot alone.
Screenshots are captured on failure only; set `VISUAL_SCREENSHOTS=1` for optional preview
captures (and `OVERVIEW_SCREENSHOTS=1` for Overview evidence). Video is off. CI uploads failed-run diagnostics
for seven days. Use synthetic data so traces do not capture real credentials or content.

For behavior-only changes, the focused assertions plus shared smoke matrix are the default.
For visual changes, also inspect the changed UI in the required themes/viewports and attach
representative screenshots. Do not repeat every unrelated user journey manually or claim
that passing functional tests proves the design is correct. Chromium coverage does not
claim Firefox/WebKit compatibility.

## Efficient agent workflow

Read applicable rules once. During development run focused checks; run the final shared
gate once the diff is stable, repeating only after a relevant change or unresolved failure.
Reuse a stable local preview and tab, with one current source/API manifest. Do not restart
an unchanged backend or replace a user's session for frontend-only work.

When a reported page disagrees with reviewed source, first compare the browser's actual URL
and loaded build, the preview manifest and the serving process's checkout/artifact. A merged
fix does not update an already loaded page or another working copy's dev server. Verify
collection navigation by clicking the sidebar from detail, not only by opening its URL.
Refresh or open the intended stable preview after preserving unsaved work, then leave that
verified page available at handoff. Preserve other contributors' services and uncommitted
changes. Console and API can have different compatible revisions: record both and compare
the serving Console's actual asset hashes before claiming it matches the reviewed build.

Batch deterministic browser actions and collect the smallest useful state before the next
decision. Do not repeatedly dump a full page or capture every step. Follow the selected
tool's browser-access rules for interactive review; repository Playwright tests remain
portable automated software tests. Prefer failed job logs, DOM context and traces before
replaying the entire flow. Let CI run while completing independent review/documentation;
poll at meaningful intervals, then verify the exact latest head before merging.

The GH-98 live review pairs this with one risk-based manual pass across creation, useful
results, return/re-entry and draft/error recovery. While independent provider calls run,
continue review or implementation rather than polling the same loading screen. Use targeted
browser cases to diagnose a repair, then the shared matrix for final regression. Inspect
screenshots at the affected themes/viewports; do not replay the full manual tour after every
edit. [Review evidence](../product-experience-audit.md#live-review-and-repairs-gh-98-2026-11-01)
distinguishes live provider observations from synthetic browser coverage.

References: [Playwright best practices](https://playwright.dev/docs/best-practices),
[assertions](https://playwright.dev/docs/test-assertions),
[trace viewer](https://playwright.dev/docs/trace-viewer).
