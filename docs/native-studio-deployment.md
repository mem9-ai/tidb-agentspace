# Native Studio deployment and local sign-in testing

Status: GH-13 implementation; live rollout and real-account login require separate observed evidence. The contract is [NAT-01–06](../specs/gh-13/spec.md), originally accepted at `b6bf3645547ee2f172fc93b6249a966fb3f19079`. The owner's 2026-10-30 clarification limits NAT-04 dev CD to image updates; runtime configuration and recovery remain operator-owned.

Rust is the only product API runtime. Node builds the Console and runs operator tools and native test fixtures; it is absent from the deployed API image. The existing hosted Node image/JSON/vault path is retired. The owner permits discarding its data. Fresh native metadata uses the existing S3 bucket with a new unique prefix and new independent Global/Region encryption keys and service tokens. No old data or upstream credentials are imported, and no shared bucket is deleted.

## Authentication and gateway

The native API implements public-client authorization code + S256 PKCE, bounded ten-minute browser-bound flows, a twenty-attempt/minute per-socket-peer limit, and opaque server-side sessions. Discovery must return the exact configured issuer; endpoints use HTTPS, redirects are not followed, provider responses are bounded. JWKS verification allows asymmetric algorithms only and validates signature, key ID/use/algorithm, issuer, audience, expiry, nonce and authorized party. Callback replay fails. Logout revokes the server session and its already-cloned operation credentials; multi-step imports reauthorize before INSERT. The isolated legacy loopback profile has eight-hour sessions that restart invalidates; managed hosted account grants persist across Region restarts as described in ADR 0030. Preparations do not survive restart.

Identity uses issuer + immutable scalar `sub`. Managed hosted login creates a personal tenant and Workspace for each verified identity; Region-local grants continue across restart and do not require Global on each request. The older shared-owner `ownerSubjects`, `ownerEmailRules`, and `allowedOrgs` admission rules apply only to the isolated legacy loopback profile; the co-located managed callback does not use them to admit accounts. The separate GlobalLogin composition rejects these filters. Workspace Keys remain separately scoped and resource-restricted. See [ADR 0030](decisions/0030-personal-account-isolation.md) for the revocation and availability tradeoffs.

A public API configuration requires `insecureLoopback:false`, explicit `publicOrigins` and SSO with a trusted HTTPS callback origin. It can bind `0.0.0.0:4318` behind the existing private Service/gateway. Unknown Hosts, hostile Origins, public browser mutations without Origin and public anonymous owner sessions are denied. Host and forwarding headers cannot prove an actual local peer or bypass throttling. Forwarded IPs are intentionally ignored; size a shared-proxy rate limit before expanding public traffic.

Build the independent Console with `npm run build:console -- --base=/studio/` and serve `config.json` as `{"apiOrigin":"","apiPathPrefix":"/studio"}`. The Rust API accepts gateway-stripped `/api/*` and direct `/studio/api/*`; it never serves static HTML. Keep gateway API rules before the SPA fallback. Callback registration is exactly `https://drive9.ai/studio/api/auth/tidbcloud/callback`; use the actual configured public origin. Session cookies use `/studio/`, HttpOnly, SameSite=Strict and Secure; the temporary flow cookie uses `/studio/api/auth/tidbcloud`, SameSite=Lax and Secure. Post-login redirects stay in the configured callback origin/prefix.

Native `api.json` accepts the existing `TIDB_SSO_*` environment settings when its `sso` field is absent; `TIDB_PUBLIC_ORIGIN`, `WORKSPACE_TRUSTED_ORIGINS` and `WORKSPACE_PUBLIC_PATH` are supported. Explicit `sso` JSON uses camelCase (`issuer`, `clientId`, `redirectUri`, optional endpoints/grants). No OAuth client secret is read. Provider endpoints and ID-token issuer must match the registered client; a successful fake-provider test is not real TiDB Account integration.

## Fresh dev configuration

Prepare an owner-only input file outside Git with these fields. Keep actual values/credentials in existing secret storage, never in PRs, images or chat:

```json
{
  "publicOrigin": "https://console.example.com",
  "prefix": "studio-native",
  "s3": {
    "endpoint": "https://s3.example.com",
    "region": "existing-region",
    "bucket": "existing-bucket"
  },
  "sso": {
    "issuer": "https://identity.example.com/",
    "clientId": "registered-public-client",
    "ownerSubjects": ["immutable-allowed-subject"]
  }
}
```

Use S3 workload identity where the runtime actually supports it, or add the existing private `accessKeyId`/`secretAccessKey` credentials to `s3`. The pipeline's short-lived ECR/EKS identity is not automatically available inside the Pod. Supply verified native tidbfs artifacts through `product.execute` before enabling native DuckDB database creation. Selected-file parsing does not need that extension.

Run `node scripts/init-hosted-config.mjs /private/input.json /private/new-output-directory`. It exclusively creates 0600 private files and new random installation roots/keys. Run `workspace-backend initialize --config /run/workspace/bootstrap.json` once with those files mounted. Initialization opens only the selected new roots, commits an empty Workspace and releases ownership; it does not start public listeners. Then use `workspace-backend serve --config /run/workspace/deployment.json`, whose flags disable initialization. Keep that exact configuration/key set through restarts. Missing/incompatible roots fail closed; do not generate a second installation to hide a failure.

The generated co-located dev profile binds Meta only to loopback with separate authority credentials and HTTPS S3; its environment is explicitly `test`. Production remote Meta requires the existing mTLS profile and protected operations. The API itself requires public SSO. One API writer per Workspace remains enforced; crashed writers require exact-owner reconciliation.

## Guest deployment configuration

Guest is disabled by default. The co-located host can opt in by adding
`"guest":{"globalAuthorityId":"global","workspaceLimit":128}` to its regional API
configuration, or setting the explicit environment variable `WORKSPACE_GUEST_ENABLED=true` on the
regional host. The environment flag uses a 128-Workspace open-pool limit; `false` disables Guest.
The same deployment plan must explicitly host independent `global` and Region metadata authorities; the regional binding must be `inProcess`. The API configuration must contain
SSO and an exact trusted HTTPS public origin. Guest signup and the Region API currently share a
co-located trust boundary; this is not a remote Global-to-Region transport.

The regional scheduler attempts supported provider deletion after Guest logout or expiry and
retains unsupported or unconfirmed outcomes with their bindings for reconciliation. It does not
claim a provider request is proof of deletion. Regional authentication rejects expired Guests
independently of the scheduler. If Global fails, existing regional Guests
remain usable until their original expiry; new signup is unavailable. If Global was unavailable
when the host started, restarting the host is currently required for new signup to recover. See
[ADR 0029](decisions/0029-guest-logout-cleanup.md) for provider and reconciliation limits.

The protected, main-only `Enable Guest on dev` workflow changes only that environment flag. It
requires full same-commit CI, serializes with API deployment, waits for rollout, then verifies a
new Guest Cookie and its Workspace through the public origin. Verification failure triggers a
rollout rollback and checks its completion; an ambiguous configuration update fails without
blindly undoing a possibly unrelated rollout. This creates an empty, temporary Guest Workspace as
an operational smoke test. Verify the Console separately after its independent publication.

## One-time Kubernetes cutover and recurring CD

The Docker image is native Linux amd64, the currently verified Linux static DuckDB platform. No arm64 manifest is advertised. Console publication remains separate. Configure the existing protected `dev` environment and ECR/EKS target; PR builds never receive deployment credentials.

For native service startup, mount the prepared private files at `/run/workspace` with owner-only permissions readable by UID 1000. Kubernetes Secret projection can be copied by a non-root init container into a memory-backed volume with `umask 077`/mode 0600; a group-readable Secret projection itself does not satisfy native private-file checks. Run the explicit initializer before starting the steady plan. These are operator-owned runtime requirements, not preconditions checked by CD. Preserve a private copy of the old Pod template only for operator recovery; never roll a Node image back against native configuration.

The runtime profile uses one replica/Recreate, bounded scratch space, non-root UID/GID 1000, read-only root, no service account token/capabilities and `/api/health` readiness with loopback Host. Its container must invoke the image's native entrypoint, without the previous Node command override. CD does not require the former Pod-template annotation `workspace.tidb.ai/runtime: rust-v1` and leaves existing annotations, probes and configuration untouched.

Main-only CD builds once, pushes an immutable digest and runs `kubectl set image` against the existing Deployment/container. It does not wait for health, automatically roll back, create infrastructure, delete data, change credentials or run initialization. A successful run confirms only the image update. Operators verify readiness, an authorized read, an unauthorized denial, public `/studio` routing and real-account login before reporting the hosted product live.

### Deployment operator handoff

The owner handles runtime configuration separately from CD. Source integration and automatic image updates can finish independently; an operator completes and records the following before claiming a live cutover:

1. Confirm the existing S3 bucket, region, HTTPS endpoint and a credential Secret or supported runtime identity. The GitHub `dev` environment already provides the ECR/EKS deployment identity; it does not provide S3 access to the application Pod. Preserve the existing SSO client, explicit owner grants and exact `/studio` callback registration.
2. Generate the private configuration once with `init-hosted-config.mjs`, using a new prefix and independent keys. Keep all ten generated files in private secret storage. Run the initializer against that new installation and retain its matching steady configuration. The old workspace data need not be migrated.
3. Prepare the native Pod template/configuration described above. CD can update the image without a separate runtime annotation; it does not prepare or validate the private runtime configuration.
4. Verify readiness, authorized/denied requests, `/studio` routing and real TiDB Account login separately from the main-only CD image update. Record the source SHA, image digest and observed results in [#13](https://github.com/mem9-ai/tidb.ai/issues/13). Keep its live-rollout acceptance open until those results exist.

## Local and automated testing

Normal local development retains `meta:local init/serve`, isolated RustFS storage and explicit `insecureLoopback:true`. With no SSO, only a real loopback socket may create a guest session. For real local login, use a separate development public-client registration and an exact fixed loopback callback if the provider permits it. For example, use `publicPath:"/studio"` and `http://127.0.0.1:4318/studio/api/auth/tidbcloud/callback`, plus the exact Console origin and same-origin post-login URL. Set `postLoginUrl` to the API/gateway origin, so keep the Console behind the same local gateway for the callback landing page. Loopback HTTP omits Secure; HTTPS always sets it. If registration rejects localhost, use a stable development HTTPS gateway/tunnel with its own client/grants and exact registered callback; never reuse the production cookie/client configuration.

Automated native tests use a local signed fake provider and isolated temporary S3: `npm run backend:check`. They exercise code/PKCE, signatures/issuer/audience/nonce, default-deny owner rules, hostile hosts/origins, cookie prefixes, replay/logout, expired sessions and separate Workspace Key behavior. Only explicitly local fixtures may enable `allowLoopbackHttp` for provider endpoints. CI requires no real identity or cloud credentials. `npm run check` independently verifies Console, generated API/client contracts and tooling. Package native artifacts only from clean reviewed source.

## Read-only discovery when S3 inputs are unknown

The main-only manual `inspect` operation uses the existing protected GitHub dev identity. It first reports only the target's referenced configuration field names. It then queries one bounded S3 bucket-name page (100), filters project name hints (`drive9`, `mem9`, `slatedb`, `workspace`, `tidb-ai`/`tidb.ai`), and reports region/project tags for at most eight candidates. It never reads objects, changes IAM, creates resources or chooses a bucket automatically. Unrelated bucket names, owner identifiers, pagination tokens and non-project tags are omitted. A permission-denied result is explicit and never falls back to exporting the short-lived deployment credentials into a Pod. A name match is a discovery hint, not authorization to use that storage; confirm the intended bucket and runtime access identity before initialization.

Observed after PR #15: protected inspection successfully connected to the configured EKS target; the target was still the old runtime, with one replica/Recreate and only SSO fields in its referenced ConfigMap. No S3 endpoint, bucket or credential reference was present. [Inspection run](https://github.com/mem9-ai/tidb.ai/actions/runs/40979807553). The main-triggered image release was cancelled during credential-free verification, before cluster operations; the live API was left running. Source and Console publication are complete; first native bootstrap remains separate.

## Personal account isolation and old shared Workspace

Managed TiDB Account login uses the separate Global directory and Region policy/session metadata;
every verified `(iss, sub)` has a stable personal tenant and Workspace. Region access uses its
own durable browser grant without contacting Global. Guest signup can be disabled independently.
See [ADR 0030](decisions/0030-personal-account-isolation.md) for the continuity and revocation
tradeoffs, the Global restart limitation, and the current tenant/organization representation.

Managed startup uses an internal health Workspace and does not open `ws_agentlab`. After the new
version, real login and isolation have been verified, the explicitly dispatched protected
`Retire legacy shared Workspace` workflow can retire only `ws_agentlab`. Provide the immutable digest observed in the verified deployment. The workflow verifies
same-commit CI and that the current image exactly matches that digest, sets `WORKSPACE_RETIRE_LEGACY=ws_agentlab`,
waits for a one-replica Recreate rollout and the exact completion marker, then removes the flag
and verifies a second healthy rollout. Failures leave an explicit state for inspection; do not
blindly roll back to a binary expecting deleted data. Offline operators can instead stop the host
and run `workspace-backend purge-legacy --config <private-deployment.json> --workspace ws_agentlab`.
The operation logically deletes live metadata and credentials; it does not physically erase
historical SlateDB/object-store versions or delete provider instances.

On 2026-10-31, [the dev rollout](https://github.com/mem9-ai/tidb.ai/actions/runs/41192855387)
was followed by a real TiDB Account login and Guest-to-account cross-access denials.
[The protected retirement](https://github.com/mem9-ai/tidb.ai/actions/runs/41194217771)
reported completion and healthy rollouts; the personal account Workspace remained accessible.
A second real TiDB Account has not been verified; two-account isolation is covered by the
signed-provider integration fixture.

## Hosted Execute configuration repair

A previously deployed private API configuration used `product.compute`, while the current
canonical runtime accepts only `product.execute`. Rename that field in both `api.json` and
`api-bootstrap.json` before starting a canonical-only image; preserve its value and every other
Secret entry. The protected recovery workflow's explicit `repair-config` operation reads only
referenced Secrets, requires exactly one matching API configuration Secret and uses resourceVersion-guarded changes through stdin. For an immutable Secret it verifies and reuses a single matching prior replacement if present, otherwise creates a new copy, then switches only the matching Deployment volume and retains the original. Multiple or mismatching replacements require operator inspection. For a mutable Secret it replaces the object with a resourceVersion precondition, preserving its other entries. It preserves the deployment image and checks public health. If the Secret update or rollout result is uncertain, inspect before
retrying. The operation does not change Workspace or provider data.
