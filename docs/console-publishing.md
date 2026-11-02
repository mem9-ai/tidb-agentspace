# Automatic Studio Console publishing

Console changes merged into `mem9-ai/tidb.ai` main are built by **Publish Studio Console**.
The workflow updates one generated-artifact PR in `mem9-ai/drive9-fe`, validates it, and
waits for the independent required website check, then merges. Netlify's existing main-branch deployment then
publishes `https://drive9.ai/studio/`. Daily changes need no manual synchronization or deploy click.
Backend-only edits continue through the independent dev API CD workflow.

## One-time setup

First merge the independent **Studio artifact** validation workflow in drive9-fe. Configure
main to require that check specifically from GitHub Actions, require an up-to-date branch
and a PR (zero mandatory human approvals), enforce checks for administrators, and give the
publisher no bypass. These settings must be verified
on GitHub; adding workflow YAML alone does not protect the branch.

Create a dedicated GitHub App owned by the organization:

1. Disable its webhook. Grant repository **Contents: Read and write** and
   **Pull requests: Read and write**, plus **Checks: Read-only** to wait for validation.
   Metadata read is automatic. Grant no other permissions.
2. Install it on **only `mem9-ai/drive9-fe`**. Do not grant access to the private source repository.
3. In **tidb.ai → Settings → Secrets and variables → Actions**, add repository variable
   `STUDIO_PUBLISH_APP_ID` with the App ID, and repository secret
   `STUDIO_PUBLISH_APP_PRIVATE_KEY` with its generated PEM private key. Enter the key directly
   into GitHub, never in chat, source code, or Netlify.
4. Keep the existing drive9-fe Netlify main deployment active and its Builds variable
   `STUDIO_API_ORIGIN=https://studio.drive9.ai` configured. No new Netlify credential is needed.
   Separately grant the **Netlify GitHub App** access to `drive9-fe` in its installation's
   repository selection. The publisher App's access does not grant Netlify access to push
   events. If manual deployment works but commits produce no automatic deploy records,
   verify this selection using [Netlify's repository access guidance](https://docs.netlify.com/build/git-workflows/repo-permissions-linking/).
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

The pinned Node/npm and `npm ci` build the distinct `/studio/` base-path variant in a
main-only, read-only job while CI runs. Before uploading that artifact, the job verifies the
same resolved source SHA passed Quality and Browser smoke in the trusted main CI run. It does
not repeat `npm run check`. No publication key is exposed to npm or Vite. Only a gated Console
output transfers between the build and publishing jobs.

The website's existing importer enforces an allowlist of public static files, rejects symlinks
and source maps, normalizes same-origin configuration, and records the exact source SHA plus
SHA-256 checksums. Source checks reject tracked environment files; the website verifier rejects common
credential markers. This is not a general secret detector: contributors must still review any code or
literal deliberately included in the public Console. Private backend source is never copied.

Website artifact and routing tests run before minting the write token. Only `vendor/studio/`
and `vendor/studio-build.json` are committed. Before merge, the candidate's full Git tree must
match the tested tree, its parent must still be website main, and its head must match the
recorded PR head. A changed base, edited candidate, failed test or repository protection
blocks the merge. There is no `--admin`, protection bypass, or direct main push.

### Website checkout and release files

Publication uses a shallow, non-cone sparse checkout of the website, including everything
except `site/releases/`. Keep all other website files, scripts, tests and artifact inputs
available to the existing validation. The excluded directory contains downloadable product
binaries, not Console publication inputs. Netlify's separate website build still receives
and publishes those downloads normally.

The pinned checkout action selects `blob:none` when sparse patterns are supplied, then
applies the patterns before checkout ([verified implementation](https://github.com/actions/checkout/blob/3d3c42e5aac5ba805825da76410c181273ba90b1/src/git-source-provider.ts#L178)).
Keep the complete Git index and tree metadata; do not delete excluded paths, disable sparse
checkout or replace it with a full fetch during PR preparation. Artifact commits must retain
the exact release subtree while changing only the existing artifact allowlist. Revisit this
boundary if website validation begins reading release binaries or either pinned Git action
changes its fetch/branch behavior.

`console-publish.mjs checkout` verifies the partial-clone filter, absent release worktree,
retained release index entries and absent exclusive release blobs in the local object database.
It enumerates local objects instead of looking up missing blobs, which would lazily fetch
them. The guard runs before import and after changed-artifact PR preparation. The isolated
Git regression exercises changed/unchanged trees, artifact additions/deletions, branch fetch
and reset, and rejects missing index entries or hidden-but-downloaded blobs. Existing
source/checksum/origin tests and protected independent website checks remain required.

For timing comparisons, record the exact run/attempt and source SHA, website checkout step,
publish job, build/evidence-wait stages, queue time and total elapsed time. Compare equivalent
changed or unchanged artifact outcomes and distinguish waiting from validation work. The
[pre-optimization run](https://github.com/mem9-ai/tidb.ai/actions/runs/41057309793) took 241s
overall, including a 110s CI-evidence wait, 62s website checkout and 85s publish job. These
overlapping/stage times must not be added or treated as a controlled benchmark. Record
post-change observed timings in the task/PR; GitHub publication does not establish Netlify
live status when that separate verification is deferred.

The publication is the fixed `automation/studio-console` branch and PR. Do not manually edit
that generated branch. The workflow can replace its contents on subsequent publications.
Before waiting or merging, the publisher checks that main is protected and the independent
GitHub Actions **Studio artifact** check is required for everyone. It fails closed if these
are absent. It waits up to ten minutes for that check on the exact candidate head, including
initial check registration. Only success passes: failed, cancelled, skipped or timed-out
checks stop publication. It then rechecks source freshness, candidate tree and website base,
and requests a normal merge. There is no queued auto-merge left behind for a stale PR.
No human click is needed after successful checks, and repository `allow_auto_merge` need not
change. If additional required reviews/checks block merging, satisfy them without a bypass.

## Failure and recovery

Missing App configuration, denied installation access, changed source/base, failed validation,
or a failed merge is visible in the workflow. Pending/failed independent checks remain
visible on the artifact PR. Stale inputs and identical artifacts are explicit
successful skips. An unmerged PR leaves the published website unchanged. Netlify build failure
keeps its previous successful deploy; GitHub merge success alone does not prove the site is live.

Retry transient failures with a new main workflow dispatch. For a failed Netlify build, fix the
failure and retry that deploy. To stop future automatic publication, disable **Publish Studio
Console** or revoke its App installation. To restore a known-good website urgently, restore
that Netlify deploy and pause publication while fixing the source; do not rerun an obsolete
source workflow to overwrite newer artifacts.

Gate ownership and manual recovery follow [ADR 0027](decisions/0027-single-ci-evidence.md).
Missing, failed or untrusted evidence blocks publication; run CI on that main revision
before retrying. The publisher continues to resolve current main and checks its source
fingerprint before merging; CI success for another commit is insufficient.
