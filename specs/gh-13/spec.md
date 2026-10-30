# GH-13: Native hosted Studio

- Parent: [#13](https://github.com/mem9-ai/tidb.ai/issues/13).
- Baseline: `97104c6a7a564ed006c031a29d2c6f354b8bcce4`.
- Owner direction: Rust replaces the hosted Node API; old workspace data can be discarded.
- Delivery: reviewed native implementation, automatic dev delivery and observed deployment evidence where configured access is available.

## Accepted behavior

NAT-01: Native authorization-code public-client S256 PKCE verifies JWKS signature, exact configured issuer, audience, expiration, nonce and immutable scalar subject. Owner admission requires an exact subject or explicitly configured verified-email rule; an optional organization filter never grants access alone. No client secret or provider credential reaches the Console.

NAT-02: Public deployment requires explicit trusted HTTPS origins and configured SSO. Anonymous owner sessions require explicit local mode and an actual loopback socket peer. Server-side eight-hour sessions are bounded, revocable and tied to distinct issuer/subject identities; ten-minute flows are single-use, browser-bound, bounded and rate limited. Failed verification, replay, expiry and unauthorized accounts never mint sessions. Unsafe browser requests must pass exact Origin policy. Invalid bearer tokens never fall back to a cookie.

NAT-03: Console and API stay independently buildable and hosted. `/studio` mounting supports both gateway-stripped API routes and direct prefixed routes, never HTML fallback. Callback registration includes the prefix; flow/session cookie paths and the same-origin post-login URL stay inside it. HTTPS uses Secure/HttpOnly cookies; loopback HTTP development may omit Secure. API config and existing Workspace Key contracts remain compatible.

NAT-04: The runtime image contains the native executable and required OS libraries, with no Node runtime or Console. Automated dev delivery uses reviewed source, immutable digests, protected credentials and serialized image updates. Per the owner's 2026-10-30 delivery clarification, CD only updates the existing Deployment image; it does not require a runtime annotation, wait for health or automatically roll back. Configuration, initialization and runtime recovery remain operator-owned. A successful CD run confirms the image update, not service readiness. Build only verified native platforms; do not advertise an unverified architecture. Console artifact publication remains separate.

NAT-05: Initialize deliberate new SlateDB roots and new encryption/writer identity; do not interpret old JSON/vault files. Initialization is explicit, not an implicit fallback or recurring reset. Existing data may be discarded, but this does not authorize deleting unrelated shared buckets, secrets or infrastructure. Rollback across storage formats requires configuration recovery, not merely an old image. Keep deployment configuration and credentials outside source/artifacts.

NAT-06: All normal serving/build/deployment commands select Rust. Remove hosted Node packaging/entry paths and stale dual-runtime claims. A Node behavioral oracle may remain explicitly test-only until its independent cases are ported; tooling and Console builds may use Node. Do not retain an operational fallback backend.

## Evidence

Use signed local fake-provider tests for positive code/PKCE, session and logout flows; reject issuer/audience/signature/nonce/state failures, replay, unverified/domain-lookalike email, public anonymous owner, hostile Host/Origin, bad configuration and cross-session imports. Exercise local and `/studio` cookie/config paths with the compiled native API and isolated real RustFS. Run `npm run check` and `npm run backend:check`, native-only packaging and deployment-script checks. Inspect the production Console against Rust at desktop and narrow sizes. Real TiDB Account integration and live rollout are reported separately from synthetic evidence.
