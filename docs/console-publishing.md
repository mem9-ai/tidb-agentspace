# Automatic Studio Console publishing

Console changes merged into `mem9-ai/tidb.ai` main are built by **Publish Studio Console**.
The workflow updates one generated-artifact PR in `mem9-ai/drive9-fe`, validates it, and
merges through normal repository rules. Netlify's existing main-branch deployment then
publishes `https://drive9.ai/studio/`. Daily changes need no manual synchronization or deploy click.
Backend-only edits continue through the independent dev API CD workflow.

## One-time setup

Create a dedicated GitHub App owned by the organization:

1. Disable its webhook. Grant repository **Contents: Read and write** and
   **Pull requests: Read and write**; Metadata read is automatic. Grant no other permissions.
2. Install it on **only `mem9-ai/drive9-fe`**. Do not grant access to the private source repository.
3. In **tidb.ai → Settings → Secrets and variables → Actions**, add repository variable
   `STUDIO_PUBLISH_APP_ID` with the App ID, and repository secret
   `STUDIO_PUBLISH_APP_PRIVATE_KEY` with its generated PEM private key. Enter the key directly
   into GitHub, never in chat, source code, or Netlify.
4. Keep the existing drive9-fe Netlify main deployment active and its Builds variable
   `STUDIO_API_ORIGIN=https://studio.drive9.ai` configured. No new Netlify credential is needed.
5. After this workflow is merged, run **Publish Studio Console → Run workflow → main** once
   to verify setup. An identical build still validates App permissions but skips creating a PR.
   For the first changed build, inspect its artifact PR and corresponding successful Netlify deploy.

The workflow mints a short-lived installation token scoped to drive9-fe, then revokes it
at job completion. It never uses a personal access token. Repository administrators retain
control of App installation, protected branches, and Actions secrets.

## What triggers a publication

The workflow lists Console source (`src/`, `console/`), its npm workspace, lockfiles, toolchain,
TypeScript/Vite configuration and publication tooling. Keep the path list and
`consoleInput()` aligned when introducing new build inputs. A main-only manual run also
supports initial setup or retry. Forks, PRs and other branches cannot publish.

One publication runs at a time; GitHub retains one pending run and coalesces further pushes.
Each run resolves latest main when it starts, including historical reruns, and pins that exact
source commit through build and publication. The running merge is not cancelled mid-flight.
Source input hashes are compared with current
main before building and immediately before merging. A later backend-only commit is harmless;
a later Console change makes the old run skip. Builds with identical public bytes produce no PR.
A commit arriving after the final comparison can briefly follow the preceding version; the
serialized newer run publishes it next. A rerun cannot publish its historical event revision: it also resolves latest main.
This makes pending-run ordering harmless for version selection.

## Checks and credential boundary

Builds run with the pinned Node/npm and `npm ci`, pass the complete `npm run check`, and
rebuild with `/studio/` as the base path in a clean environment. No publication key is exposed
to npm or Vite. Only Console output transfers between the build and publishing jobs.

The website's existing importer enforces an allowlist of public static files, rejects symlinks
and source maps, normalizes same-origin configuration, and records the exact source SHA plus
SHA-256 checksums. Additional checks reject tracked environment files and common credential
markers. This is not a general secret detector: contributors must still review any code or
literal deliberately included in the public Console. Private backend source is never copied.

Website artifact and routing tests run before minting the write token. Only `vendor/studio/`
and `vendor/studio-build.json` are committed. Before merge, the candidate's full Git tree must
match the tested tree, its parent must still be website main, and its head must match the
recorded PR head. A changed base, edited candidate, failed test or repository protection
blocks the merge. There is no `--admin`, protection bypass, or direct main push.

The publication is the fixed `automation/studio-console` branch and PR. Do not manually edit
that generated branch. The workflow can replace its contents on subsequent publications.
The normal merge command respects enforced checks/reviews; this setup does not enable or
relax branch protection. If new required checks/reviews block merging, satisfy them rather
than granting a bypass. `allow_auto_merge` is not required: the job merges its validated PR.

## Failure and recovery

Missing App configuration, denied installation access, changed source/base, failed validation,
or a failed merge is visible in the workflow. Stale inputs and identical artifacts are explicit
successful skips. An unmerged PR leaves the published website unchanged. Netlify build failure
keeps its previous successful deploy; GitHub merge success alone does not prove the site is live.

Retry transient failures with a new main workflow dispatch. For a failed Netlify build, fix the
failure and retry that deploy. To stop future automatic publication, disable **Publish Studio
Console** or revoke its App installation. To restore a known-good website urgently, restore
that Netlify deploy and pause publication while fixing the source; do not rerun an obsolete
source workflow to overwrite newer artifacts.
