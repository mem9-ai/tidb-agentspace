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

Every push to `main` runs this workflow, without a path filter. Pull requests only
validate. Normal releases update an existing Deployment's image. First installation
is an explicit manual operation; it is never inferred from a missing Deployment.
Environment names, registry addresses and cloud identifiers are runtime inputs.
No real account identifier, namespace, role ARN or secret value is committed.

The manual `deployment_mode` is `deploy` (default), `bootstrap-preview`, or `bootstrap`.
Both bootstrap modes run the same quality/image gates and render
[`scripts/bootstrap-dev.mjs`](../../scripts/bootstrap-dev.mjs) from the resolved SHA.
They require an existing namespace and an explicit `storage_class` input. The class
must use the EBS CSI driver; there is no fallback to a default class or ephemeral data.
`bootstrap-preview` performs Kubernetes server-side dry-run only, then ends without
rollout or rollback. `bootstrap` first repeats that validation and then **creates**
an API-scoped deny-ingress NetworkPolicy, PVC, private Service and Deployment. It refuses existing objects rather than
adopting or overwriting them. Errors are surfaced; a partial creation or readiness
failure leaves resources and the PVC for inspection, never deletes persisted data,
and never pretends there is a previous release to roll back to.

The initial API has one replica, `Recreate` updates and a 10 GiB `ReadWriteOncePod`
PVC. Unlike node-scoped RWO, RWOP prevents a second Pod from mounting the same claim,
including on the same node. This requires a compatible CSI driver/sidecars; a dry-run
does not prove provisioning or mount success. The container cannot start until its
claim binds and mounts. An unbound claim leaves the Pod Pending, the Service without
ready endpoints, and rollout times out as a failed deployment. No ephemeral fallback
or force-detach is performed. The bootstrap does not delete the PVC; deleting it
manually may delete its underlying volume according to the StorageClass reclaim policy.

The initial Service is ClusterIP only, with no Ingress, NodePort, LoadBalancer,
host port or host network. This is a **private dev/demo API**, not public SSO delivery.
It uses the existing local/demo providers and does not invent provider credentials.
API networking explicitly sets `WORKSPACE_API_HOST=0.0.0.0`; the application default
remains `127.0.0.1`. Only these two values are accepted; empty/invalid values fail
startup. Host/origin and SSO authorization checks stay in place. Anonymous demo sessions now
require an actual loopback socket peer; a spoofed Host or forwarded header cannot
acquire an owner session over the Pod network. HTTP probes connect to
the Pod IP and send `Host: 127.0.0.1`; they do not connect to the kubelet's loopback.
The Pod runs as UID/GID 1000 with a read-only root filesystem, dropped capabilities,
no privilege escalation, no service-account token, resource limits and bounded scratch
storage. Workspace state and sibling credential files live on `/data`, never `/tmp`.

The NetworkPolicy is created before the API and denies inbound Pod traffic by default.
It requires a network plugin that enforces policy; policy objects alone do not prove
isolation, and other policies selecting the same Pods can add permissions. Node-origin
traffic (including kubelet probes) and privileged API-server port-forward access have
different enforcement rules. Verify denial from an unrelated Pod before reporting
network isolation. The application-level demo-session restriction remains effective
even if the network plugin does not enforce policy.

Before exposing the Service through a public gateway, separately allow the intended
gateway in network policy and configure the
reviewed public origin, proxy and SSO runtime settings below. Normal image releases
preserve that configuration; they do not reapply the bootstrap template.

The requested ref is resolved to a single immutable commit SHA up front (the `resolve` job);
the quality gate, the pre-merge image build and the deployed image are all bound to that same
SHA, so the commit that passes `npm run check` is exactly the commit that is built and shipped
(no branch-advances-between-jobs race). Dispatch inputs are read from the environment as data
and validated against a character allowlist — never interpolated into a `run:` script — so a
crafted ref cannot inject shell commands. The deployment secrets are scoped to the `deploy` job
and the `dev` environment, so the quality gate and any repository script that runs earlier
never see them. Environment approval and branch restrictions must be configured separately
in GitHub; declaring the environment in YAML does not enable these protections.

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

## Runtime configuration for a public gateway (out-of-band)

Public gateway configuration is injected via Secret/ConfigMap/volume, never Git:

- `WORKSPACE_DATA_FILE` — absolute path on a persistent volume for the workspace data file.
- `TIDB_PUBLIC_ORIGIN` / `WORKSPACE_TRUSTED_ORIGINS` — public origin(s) when served behind the
  reverse proxy (loopback-only by default).
- `TIDB_TRUSTED_PROXY_IPS` — trusted reverse-proxy source IPs/CIDRs for client-source resolution.
- TiDB Cloud SSO configuration when SSO is enabled: `TIDB_SSO_ISSUER`, `TIDB_SSO_CLIENT_ID`,
  `TIDB_SSO_CLIENT_SECRET` (secret only), `TIDB_SSO_REDIRECT_URI`, `TIDB_SSO_OWNER_SUBJECTS`,
  and the optional `TIDB_SSO_*` fields documented in `.env.example`. Leave unset to keep SSO
  disabled. The redirect URI must match the public path (e.g. `/studio`) and callback route.

## First installation and verification

1. Confirm the configured namespace is the intended dev namespace and already exists.
   Confirm its NetworkPolicy, Deployment, Service and `<deployment>-data` PVC do not yet exist.
2. Run the workflow manually on the candidate branch with its full SHA as `deploy_ref`,
   `deployment_mode=bootstrap-preview`, and the actual EBS CSI `storage_class` name.
   Inspect the full diff and server-side dry-run result before creating resources.
3. Run `deployment_mode=bootstrap` on that same reviewed SHA and storage class.
   Wait for rollout; a successful preview alone is not a deployment.
4. Verify the PVC is Bound, Pod is Ready, image digest matches, and `/api/health`
   works through the private Service (port-forward is sufficient), and an unrelated Pod
   cannot obtain a demo owner session even with forged loopback headers. Verify state survives
   replacement of the Pod. With no public runtime configuration, use loopback HTTP
   through port-forward; do not publish the anonymous demo to the internet.
5. Subsequent main pushes/manual `deploy` operations update only the image. If such a
   rollout fails, the workflow undoes the image update and verifies recovery. First
   bootstrap has no previous release and therefore does not invoke rollout undo.

See Kubernetes documentation for [single-instance stateful applications](https://kubernetes.io/docs/tasks/run-application/run-single-instance-stateful-application/),
[ReadWriteOncePod](https://kubernetes.io/docs/tasks/administer-cluster/change-pv-access-mode-readwriteoncepod/),
[NetworkPolicy enforcement](https://kubernetes.io/docs/concepts/services-networking/network-policies/),
and [HTTP probe Host headers](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/).

Concurrency is split by whether a run can deploy. Pull-request runs use a per-PR group with
`cancel-in-progress: true`, so a newer commit on the same PR supersedes the older verify run.
Push-to-main and manual dispatch — the deploy-capable events — share one constant group with
`cancel-in-progress: false`, so they queue behind one another and are never cancelled at the
workflow level mid-rollout/rollback; the `deploy` job carries the same constant-group invariant.
Event matrix: a new PR commit supersedes the old PR verify (good); back-to-back main pushes
serialize (the second waits, the first's rollout completes); main + manual, and two manual runs
on different refs, all share the deploy group and serialize the same way.

## Not in scope

Single dev region (AWS EKS). Public ingress/SSO provisioning, multi-region fan-out,
production CD, automatic namespace creation and ongoing reconciliation of Kubernetes
configuration are out of scope. The bootstrap only creates the first private instance.
