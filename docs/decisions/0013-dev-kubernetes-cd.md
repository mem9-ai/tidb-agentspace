# ADR 0013: Dev Kubernetes CD for the API server

- Status: accepted in PR; dev-only continuous deployment, 2026-10-28.
- Workflow: [.github/workflows/dev-cd.yml](../../.github/workflows/dev-cd.yml). See also [ADR 0005](0005-independent-console-and-api.md) (Console and API are independent).

The owner asked for the API server to deploy to the dev Kubernetes environment the
same way `tidbcloud/fs` does. Reuse that project's mature dev-CD shape — build a
multi-arch image, push it to the registry, roll the existing in-cluster Deployment to
the new image and wait for the rollout, undoing it on failure — without copying any of
its project secrets, cluster identifiers or extra regions.

Only the **API server** is deployed here (`node server/index.mjs`, port `WORKSPACE_API_PORT`
default `4318`, health `GET /api/health`). The Console is static and is shipped by the
website pipeline (it mounts under `/studio`), so it is intentionally not in this image.

The `Dockerfile` is a two-stage build: stage one installs the full dependency set and runs
`npm run build`, which produces `dist/api` — a self-contained runtime root carrying its own
`package.json`, the server sources, `public/openapi.json` and a pruned `node_modules` that
holds only the runtime closure (mysql2, pg, the `@duckdb/node-api` native binding, jose, ...).
Stage two copies just `dist/api` and runs as the non-root `node` user. Because the DuckDB
binding is a native addon, amd64 and arm64 are built as separate images (no cross-compilation)
and joined into one multi-arch manifest. The rollout pins the image by immutable digest, not
the floating tag, so a later restart runs the exact image that was built.

The Deployment, Service, volumes and every runtime Secret/ConfigMap already exist in the
cluster and are managed out-of-band. The workflow only updates the running image; it creates
or templates no Kubernetes object. Consequently **no namespace, cluster endpoint, registry
account, role ARN or secret value appears in this repository** — all are injected from GitHub
Actions secrets at run time, and runtime configuration is injected into the Pod by the
out-of-band Secret/ConfigMap.

The requested ref is resolved to a single immutable commit SHA up front (the `resolve` job);
the quality gate, the pre-merge image build and the deployed image are all bound to that same
SHA, so the commit that passes `npm run check` is exactly the commit that is built and shipped
(no branch-advances-between-jobs race). Dispatch inputs are read from the environment as data
and validated against a character allowlist — never interpolated into a `run:` script — so a
crafted ref cannot inject shell commands. The deployment secrets are scoped to the `deploy` job
behind the protected `dev` environment, so the quality gate and any repository script that runs
earlier never see them.

## Required GitHub Actions secrets (names only)

Set these on the protected `dev` environment (not at repository scope) before the first run:

- `AWS_REGION` — dev region.
- `AWS_ASSUME_ARN` — OIDC role the workflow assumes (ECR push + EKS access). No static keys.
- `ECR_REGISTRY` — registry host (e.g. the `*.dkr.ecr.*.amazonaws.com` account endpoint).
- `ECR_REPOSITORY` — image repository name.
- `DEV_EKS_CLUSTER` — dev EKS cluster name.
- `DEV_DEPLOY_NAMESPACE` — namespace of the API Deployment.
- `DEV_API_DEPLOYMENT` — name of the API Deployment.
- `DEV_API_CONTAINER` — container name within the Deployment, **only if** it differs from the
  Deployment name (defaults to `DEV_API_DEPLOYMENT`).

## Required in-cluster runtime configuration (out-of-band, not in this repo)

The API Deployment must already provide, via Secret/ConfigMap/volume:

- `WORKSPACE_DATA_FILE` — absolute path on a persistent volume for the workspace data file.
- `TIDB_PUBLIC_ORIGIN` / `WORKSPACE_TRUSTED_ORIGINS` — public origin(s) when served behind the
  reverse proxy (loopback-only by default).
- `TIDB_TRUSTED_PROXY_IPS` — trusted reverse-proxy source IPs/CIDRs for client-source resolution.
- TiDB Cloud SSO configuration when SSO is enabled: `TIDB_SSO_ISSUER`, `TIDB_SSO_CLIENT_ID`,
  `TIDB_SSO_CLIENT_SECRET` (secret only), `TIDB_SSO_REDIRECT_URI`, `TIDB_SSO_OWNER_SUBJECTS`,
  and the optional `TIDB_SSO_*` fields documented in `.env.example`. Leave unset to keep SSO
  disabled. The redirect URI must match the public path (e.g. `/studio`) and callback route.

## Before the first real rollout

The workflow only updates an image, so the cluster objects must already exist and must be
proven out-of-band before the dev rollout is considered ready: the Deployment (with its
container name matching `DEV_API_DEPLOYMENT`/`DEV_API_CONTAINER`), Service, the persistent
volume backing `WORKSPACE_DATA_FILE`, the Pod `securityContext` (non-root, read-only root
filesystem, dropped capabilities), resource requests/limits, liveness/readiness probes on
`GET /api/health`, the runtime Secret/ConfigMap, and any NetworkPolicy. Capture a server-side
dry-run / render of those objects and a rollback check against the actual Deployment as
deployment evidence. On pull requests the workflow runs only the `verify` job — the quality
gate plus a no-push amd64/arm64 image build — and never reaches `deploy`, so packaging
failures surface on the PR itself; the deploy job is gated off pull-request events.

Concurrency is split by whether a run can deploy. Pull-request runs use a per-PR group with
`cancel-in-progress: true`, so a newer commit on the same PR supersedes the older verify run.
Push-to-main and manual dispatch — the deploy-capable events — share one constant group with
`cancel-in-progress: false`, so they queue behind one another and are never cancelled at the
workflow level mid-rollout/rollback; the `deploy` job carries the same constant-group invariant.
Event matrix: a new PR commit supersedes the old PR verify (good); back-to-back main pushes
serialize (the second waits, the first's rollout completes); main + manual, and two manual runs
on different refs, all share the deploy group and serialize the same way.

## Not in scope

Single dev region (AWS EKS). The multi-region Tencent/GCP fan-out, production CD and any
in-repo Kubernetes manifests are out of scope; revisit if dev needs additional regions or the
cluster objects should become repository-managed.
