# Native Studio deployment and local sign-in testing

Status: GH-13 implementation; live rollout and real-account login require separate observed evidence. The accepted contract is [NAT-01–06](../specs/gh-13/spec.md), accepted at `b6bf3645547ee2f172fc93b6249a966fb3f19079`.

Rust is the only product API runtime. Node builds the Console and runs tools/regression oracles; it is absent from the deployed API image. The existing hosted Node image/JSON/vault path is retired. The owner permits discarding its data. Fresh native metadata uses the existing S3 bucket with a new unique prefix and new independent Global/Region encryption keys and service tokens. No old data or upstream credentials are imported, and no shared bucket is deleted.

## Authentication and gateway

The native API implements public-client authorization code + S256 PKCE, bounded ten-minute browser-bound flows, a twenty-attempt/minute per-socket-peer limit, and eight-hour opaque server-side sessions. Discovery must return the exact configured issuer; endpoints use HTTPS, redirects are not followed, provider responses are bounded. JWKS verification allows asymmetric algorithms only and validates signature, key ID/use/algorithm, issuer, audience, expiry, nonce and authorized party. Callback replay fails. Logout revokes the server session and its already-cloned operation credentials; multi-step imports reauthorize before INSERT. Restart invalidates sessions and preparations.

Identity is always issuer + immutable scalar `sub`; events carry `tidb:<sub>`. Exact `ownerSubjects` or `ownerEmailRules` with boolean `email_verified=true` grants full ownership of the same Workspace. Optional `allowedOrgs` is an additional filter. Empty grants deny everyone. These are Console sign-in grants, not delegated provider API authorization or customer tenant isolation. Workspace Keys remain separately scoped and resource-restricted.

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

Use S3 workload identity where the runtime actually supports it, or add the existing private `accessKeyId`/`secretAccessKey` credentials to `s3`. The pipeline's short-lived ECR/EKS identity is not automatically available inside the Pod. Supply verified native tidbfs artifacts through `product.compute` before enabling native DuckDB database creation. Selected-file parsing does not need that extension.

Run `node scripts/init-hosted-config.mjs /private/input.json /private/new-output-directory`. It exclusively creates 0600 private files and new random installation roots/keys. Run `workspace-backend initialize --config /run/workspace/bootstrap.json` once with those files mounted. Initialization opens only the selected new roots, commits an empty Workspace and releases ownership; it does not start public listeners. Then use `workspace-backend serve --config /run/workspace/deployment.json`, whose flags disable initialization. Keep that exact configuration/key set through restarts. Missing/incompatible roots fail closed; do not generate a second installation to hide a failure.

The generated co-located dev profile binds Meta only to loopback with separate authority credentials and HTTPS S3; its environment is explicitly `test`. Production remote Meta requires the existing mTLS profile and protected operations. The API itself requires public SSO. One API writer per Workspace remains enforced; crashed writers require exact-owner reconciliation.

## One-time Kubernetes cutover and recurring CD

The Docker image is native Linux amd64, the currently verified Linux static DuckDB platform. No arm64 manifest is advertised. Console publication remains separate. Configure the existing protected `dev` environment and ECR/EKS target; PR builds never receive deployment credentials.

Before first native delivery, mount the prepared private files at `/run/workspace` with owner-only permissions readable by UID 1000. Kubernetes Secret projection can be copied by a non-root init container into a memory-backed volume with `umask 077`/mode 0600; a group-readable Secret projection itself does not satisfy native private-file checks. Run the explicit initializer before starting the steady plan. Preserve a private copy of the old Pod template only for operator recovery; never roll a Node image back against native configuration.

The target must have one replica/Recreate, bounded scratch space, non-root UID/GID 1000, read-only root, no service account token/capabilities, `/api/health` readiness with loopback Host, and Pod-template annotation `workspace.tidb.ai/runtime: rust-v1`. Its container must invoke the image's native entrypoint, without the previous Node command override. Mark the target only after its native configuration and storage are verified.

After bootstrap, main-only CD builds once, pushes an immutable digest, atomically updates the existing container image and verifies readiness; failed rollout restores the previous native digest. The deployment helper refuses an unmarked legacy target before any write. It does not create infrastructure, delete data, change credentials or rerun initialization. A successful rollout must also be followed by an authorized read, an unauthorized denial, public `/studio` routing and real-account login before reporting the hosted product live.

## Local and automated testing

Normal local development retains `meta:local init/serve`, isolated RustFS storage and explicit `insecureLoopback:true`. With no SSO, only a real loopback socket may create a guest session. For real local login, use a separate development public-client registration and an exact fixed loopback callback if the provider permits it. For example, use `publicPath:"/studio"` and `http://127.0.0.1:4318/studio/api/auth/tidbcloud/callback`, plus the exact Console origin and same-origin post-login URL. Set `postLoginUrl` to the API/gateway origin, so keep the Console behind the same local gateway for the callback landing page. Loopback HTTP omits Secure; HTTPS always sets it. If registration rejects localhost, use a stable development HTTPS gateway/tunnel with its own client/grants and exact registered callback; never reuse the production cookie/client configuration.

Automated native tests use a local signed fake provider and isolated temporary S3: `npm run backend:check`. They exercise code/PKCE, signatures/issuer/audience/nonce, default-deny owner rules, hostile hosts/origins, cookie prefixes, replay/logout, expired sessions and separate Workspace Key behavior. Only explicitly local fixtures may enable `allowLoopbackHttp` for provider endpoints. CI requires no real identity or cloud credentials. `npm run check` independently verifies Console, generated API/client contracts and the test oracle. Package native artifacts only from clean reviewed source.
