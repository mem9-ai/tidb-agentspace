# 0014: Automatically publish Console artifacts to the website

- Status: Accepted direction; implementation requires App setup and first live verification.
- Context: Console source changes frequently in private tidb.ai, while public drive9-fe owns
  the Netlify site and already imports a checksummed static Console. Manual cross-repository
  synchronization interrupts every frontend deployment.
- Decision: Use a main-only GitHub Actions workflow to build with the pinned toolchain,
  validate public files, update one artifact-only PR through a dedicated GitHub App, and merge
  only after an independent required website check enforced for everyone passes. Existing Netlify CD publishes it.
  API deployment, runtime configuration, SSO and customer authorization are unchanged.
- Credential boundary: Build jobs have no publication key. The App is installed only on the
  public target with Contents/PR write and Checks read; private source access uses the source repository's
  read-only Actions token. Netlify receives no source credential. Short-lived installation
  tokens are revoked after publication.
- Consequences: No new service or frontend hosting platform. The generated artifact remains
  reviewable and has source/hash evidence. The target runs its own required validation;
  pending/failed checks prevent merge, and no publisher bypass is granted. Serial publication and source input checks prevent
  historical builds from replacing newer frontend revisions. A last-moment source commit is
  picked up by its next run; publication is not an atomic transaction across GitHub and Netlify.
- Migration: Configure the App once, merge the workflow, and dispatch main. Do not declare
  automation operational until a real artifact merge and successful Netlify deploy are verified.
  Existing manual imports remain available for recovery with automation paused.
- Verification: Regression tests cover stale inputs, backend-only commits, incomplete trees,
  environment/symlink/submodule rejection, tampered PR trees, changed website bases, credential
  markers and redacted CLI failures. Reuse the website importer/routing tests and full source CI.

See [Console publishing](../console-publishing.md) for setup, trigger coverage, permissions,
concurrency limits and recovery.
