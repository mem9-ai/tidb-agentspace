# ADR 0013: Dev Kubernetes CD for the API server

- Status: dev-only continuous deployment. The historical Node runtime contract below is superseded by [ADR 0026](0026-native-hosted-studio.md) and [native deployment](../native-studio-deployment.md). The image update policy below applies after a native target is explicitly bootstrapped. The owner removed automatic dev rollback on 2026-10-30.
- Workflow: [.github/workflows/dev-cd.yml](../../.github/workflows/dev-cd.yml).
- Related: [ADR 0005](0005-independent-console-and-api.md), [independent delivery](../independent-delivery.md).

The owner requested the `tidbcloud/fs` deployment pattern for the API. The initial
private instance is now installed, so continuous delivery only updates its image.
First-installation and diagnostic automation are not part of the recurring pipeline.

## Release path

Pushes to `main` changing API/runtime, build or delivery inputs release an API image.
Documentation and Console-only changes retain ordinary CI and their independent publication
without an API release. Manual dispatch is restricted to `main`; there is no arbitrary
source-ref input. Manual runs default to deployment; read-only `inspect` must be selected
explicitly. CD has no build/cache-only manual mode.
Pull requests validate without deployment credentials.

1. Both jobs check out the event commit `github.sha`, so verification and deployment
   use the same immutable source even if `main` advances between jobs.
2. Run `npm run check` and the required native checks. PRs also build the verified Linux
   amd64 image without pushing it; no unverified architecture is advertised.
3. After tests pass on a release, build and push the native image **once**.
   Read the immutable digest from Buildx's output metadata, not by resolving a mutable
   tag later. The tag includes the full source SHA for traceability.
4. Read the existing Deployment and target container image.
   Require its HTTP readiness probe to check `/api/health`. Update only that container's
   image with atomic UID/resource-version/image preconditions, then wait up to 300 seconds
   for rollout/readiness. Verify the Deployment identity and new image after readiness.
5. If the update or readiness check fails, fail the Action for operator handling.
   Do not restore an earlier image, retry the write or change any other resources.
   This also applies when an update commits but its response is lost; inspect the live
   Deployment before retrying manually.

[`scripts/deploy-dev.mjs`](../../scripts/deploy-dev.mjs) implements the image update and
readiness check. Redeploying the current digest checks readiness without a mutation.
A manually bootstrapped image tag can be replaced, but every new release must use an
immutable digest. A missing Deployment/container, missing HTTP readiness probe or missing
native bootstrap marker fails before writing anything. Missing infrastructure is never
created automatically.

Push and manual releases share a non-cancelling concurrency group.
PR verification uses its own cancellable group. The protected `dev` Environment is the
credential boundary and **must allow only the `main` branch** in GitHub deployment branch
rules. The workflow also checks the branch, but a branch-local check cannot protect secrets
against a modified workflow on another branch. PRs cannot enter the deploy job. All Actions are pinned and AWS credentials use OIDC, not static keys.

## Existing runtime contract

The image runs only the API (`node server/index.mjs`); it does not serve the Console.
Its multi-stage Docker build packages the runtime dependency closure in `dist/api` and
runs as the non-root `node` user. The Console and public `/studio` gateway are separate.

The installed instance uses a ClusterIP Service, port 4318, one replica with `Recreate`
updates, and a Bound 10 GiB `ReadWriteOncePod` PVC. The container has a read-only root,
resource limits, bounded scratch space, no service-account token and no added capabilities.
Workspace state and credential files are on `/data`. Releases preserve these settings;
this workflow does not provision or reconcile infrastructure. Pod replacement may briefly
interrupt this single-instance dev API. Image rollback does not roll back stored data;
changes must remain compatible with the previous image.

`WORKSPACE_API_HOST=0.0.0.0` enables Pod networking; the application default remains
`127.0.0.1`. HTTP probes connect to the Pod IP with `Host: 127.0.0.1`. Host/origin checks,
backend authorization and SSO remain effective. Anonymous demo owner sessions require
an actual loopback socket peer, ignoring spoofed Host and forwarded headers.

**Inter-Pod connectivity is intended.** A ClusterIP Service does not mean that only its
own Pod may access it. Authorization belongs in the API: untrusted peers must not obtain
an owner session or protected data. No deny-all NetworkPolicy or cluster-wide network
plugin change is required by this CD contract. A deny-all policy from the first installation
must be removed separately after checking its ownership; deleting a source template does
not remove a live object. Do not combine that one-time cleanup with every image release.

## Required GitHub Environment secrets (names only)

Configure these in the protected `dev` Environment:

- `AWS_REGION` — dev region.
- `AWS_ASSUME_ARN` — OIDC role for ECR push and EKS access.
- `ECR_REGISTRY` — registry host.
- `ECR_REPOSITORY` — image repository name.
- `DEV_EKS_CLUSTER` — EKS cluster name, not an ARN.
- `DEV_DEPLOY_NAMESPACE` — namespace containing the existing Deployment.
- `DEV_API_DEPLOYMENT` — existing Deployment name.
- `DEV_API_CONTAINER` — target container name if different from the Deployment name.

No account identifiers, resource names, registry addresses or credentials are committed.

## Public gateway configuration

Public delivery remains separate from this private dev API. Inject runtime configuration
through Secret/ConfigMap/volume, never through source code:

- `WORKSPACE_DATA_FILE` — absolute path on persistent storage.
- `TIDB_PUBLIC_ORIGIN` / `WORKSPACE_TRUSTED_ORIGINS` — reviewed public origins.
- `TIDB_TRUSTED_PROXY_IPS` — the actual trusted proxy source addresses.
- `WORKSPACE_PUBLIC_PATH=/studio` when mounted under that gateway prefix.
- `TIDB_SSO_ISSUER`, `TIDB_SSO_CLIENT_ID`,
  `TIDB_SSO_REDIRECT_URI`, `TIDB_SSO_OWNER_SUBJECTS`, and optional SSO fields
  documented in `.env.example`. SSO uses public-client code + PKCE without an
  OAuth client secret; see [ADR 0015](0015-public-client-sso.md) for registration
  requirements and migration.

Validate the gateway/SSO flow and unauthorized access separately before public exposure.
A successful image rollout proves API readiness; it does not prove public `/studio`
availability, SSO integration, backup recovery or persisted data compatibility.
