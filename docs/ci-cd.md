# CI/CD and review policy

## What is implemented

- `.github/workflows/ci.yml`: clean installation and `npm run check` on PRs, pushes to
  `main`, merge-queue candidates, and manual requests. Introduced commits are also checked
  for a DCO sign-off. A successful quality job uploads the built frontend for review.
- `.github/workflows/release.yml`: a manual, main-branch-only internal artifact build. It
  runs the same quality gate, checks commit sign-off, and packages the runtime, frontend,
  API contract, source SHA, and checksums. It does not deploy to a cloud provider.
- Exact npm dependency versions, a committed lockfile, fixed Node/npm versions, editor
  settings, Prettier, ESLint, strict TypeScript, and a generated-contract drift check.
- `scripts/check-repo.mjs` checks instruction entry points, toolchain consistency,
  dependency pins, and baseline workflow properties. It supplements CI review; it is not
  a sandbox or a comprehensive workflow security scanner.

This folder currently has no Git remote. The workflow files have been validated locally;
no remote run, repository ruleset, deployment environment, or hosting integration is implied.

## Required repository settings

After creating the repository and running CI once, a repository maintainer should configure:

1. Protect `main` with a ruleset: require PRs, an independent human approval, resolution of
   review conversations, and the `Quality` and `Commit sign-off` status checks.
2. Dismiss stale approvals after new commits; require approval of the latest reviewable
   push. Block force pushes/deletion, and apply the policy to administrators where supported.
3. If a merge queue is enabled, keep the `merge_group` event so required checks run on the
   actual candidate. Require sign-off on the final squash commit if squash merging is used.
4. Limit Actions to approved sources and read-only default token permissions. Use hosted
   disposable runners for untrusted PRs. Review changes to workflows, agent rules,
   authorization, contracts, and billing as sensitive engineering changes.
5. Once actual maintainer identities are known, add `CODEOWNERS` for those areas and require
   their reviews. Do not insert invented handles or assign responsibility without agreement.
6. Set fork-workflow approval policies appropriate to the repository. Keep cloud integration
   credentials in environment secrets or workload identity, never in PR workflows.

Only repository-side protection can prevent a contributor from merging a failed PR. Agent
instructions and workflow YAML do not enable these settings. Availability depends on the
hosting plan and repository configuration.

## CI contract

Local and remote validation both use `npm run check`. It checks runtime versions, repository
configuration, formatting, lint, API generation, tests, strict types, and a production build.
Checks run without cloud credentials. The test suite uses temporary directories and ephemeral
ports; it never reads a contributor's persisted workspace data.

The default job runs on Linux with the exact Node/npm versions. When adding OS-sensitive
behavior, add a focused macOS/Windows matrix rather than claiming all-platform coverage from
the Linux result. Contributors can use different editors and coding agents on the same
versioned codebase. Prettier/ESLint/TypeScript determine the mechanically enforced style.

Workflow actions are pinned to reviewed full commit SHAs. Dependency updates use reviewed
PRs and run the same checks. No `pull_request_target` workflow executes PR code, no PR job
receives deployment credentials, and checkout credentials are not persisted. Avoid injecting
PR titles, branch names, or other untrusted event text into shell code; pass needed values
through environment variables and validate them.

DCO validation checks the actual Git trailer block for an author-or-committer-name/email sign-off on each
introduced non-merge commit. It is an attestation convention, not a cryptographic signature or
identity verification. Automated dependency updates are intentionally subject to the same
rule; a maintainer must resolve missing attestations without falsely signing for a bot.

## Internal artifact delivery

Use the manual `Internal artifact` workflow on `main`. Each artifact contains:

- `dist/`, the runtime server modules, and `public/openapi.json`;
- `build-info.json` with source SHA, runtime, and package version;
- an internal runtime README;
- a compressed archive and a SHA-256 checksum file.

Packaging requires no cloud secrets and performs no external deployment. The local guest
owner endpoint grants local administrative access, so this artifact is only suitable for a
trusted local evaluation. Do not place it behind a public proxy and call it production-ready.

## Actual deployment policy for the next phase

A real deployment integration must define the target and identity boundary before it is
turned on. Follow this sequence:

1. Merge reviewed source after required CI passes. Build an immutable artifact associated
   with that exact source SHA; promote the same artifact across environments.
2. Deploy to an isolated staging environment with its own data, credentials, free-tier
   allocation, and integration checks. Run end-to-end authorization and cross-resource tests.
3. Promote through a protected `production` environment with required reviewers, allowed
   source branches, short-lived deployment identity, and a per-environment concurrency group.
4. Verify readiness, resource/provider connectivity, an authorized read, and denial of an
   unauthorized component request. Declare success only after the checks pass.
5. Record the deployed version, artifact checksum, environment, operator, and verification
   outcome. Roll back to the previous known-good artifact on failed health checks. Keep
   schema migrations backward compatible; destructive migrations need a separate rollout.

Automatic staging and protected production deployment are policies for the future integration,
not commands hidden inside the current artifact workflow. Add a target-specific runbook and
exercise rollback before enabling production delivery.

GitHub references: [deployment environments and concurrency](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)
and [secure use of Actions](https://docs.github.com/en/actions/reference/security/secure-use).
