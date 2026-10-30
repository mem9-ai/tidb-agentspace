# Browser verification

Status: accepted owner direction, GH-37 (2026-10-30). Applies to every contributor and
coding agent. Functional success is established by assertions; screenshots support visual
review and failure diagnosis. See [CI/CD](../ci-cd.md) for delivery gates.

## Choose the right layer

| Layer                   | Verify                                                                                | Command                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Unit and contract tools | Pure state, parsing, generated contracts, workflow/evidence policy                    | `npm run check`                                                                 |
| Native integration      | Actual Rust authorization, records/restart, S3, providers and compute boundaries      | `npm run backend:check`                                                         |
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

The initial four journeys run in Light/Dark at 1280×800 and 390×844 (16 cases):

- Four contextual creation forms, type-prefixed names, readable fields and focus return.
- Automatic/manual name transitions, empty-name submission, explicit conflict retry and
  exact returned-resource navigation.
- Explicit Key resource/action grants, creation payload and one-time synthetic secret display.
- File System collection entry, inline Markdown, unsaved-draft protection and original-file
  download identity/bytes.

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
CI downloads the exact build from its successful Quality job, installs only Chromium and
runs two workers. CI allows one diagnostic retry and fails on flaky tests: a retry cannot
turn an initial failure into an accepted change. No retries are enabled locally by default.

## Diagnose failures and inspect changes

Use `npm run test:browser:ui` to step through a local test. CI records a trace on the first
retry; local failures retain a trace. Open one with
`npm run test:browser:trace -- /absolute/path/to/trace.zip`. The trace includes the action
timeline, DOM snapshots and network activity, making it more useful than a screenshot alone.
Screenshots are captured on failure only; video is off. CI uploads failed-run diagnostics
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

Batch deterministic browser actions and collect the smallest useful state before the next
decision. Do not repeatedly dump a full page or capture every step. Follow the selected
tool's browser-access rules for interactive review; repository Playwright tests remain
portable automated software tests. Prefer failed job logs, DOM context and traces before
replaying the entire flow. Let CI run while completing independent review/documentation;
poll at meaningful intervals, then verify the exact latest head before merging.

References: [Playwright best practices](https://playwright.dev/docs/best-practices),
[assertions](https://playwright.dev/docs/test-assertions),
[trace viewer](https://playwright.dev/docs/trace-viewer).
