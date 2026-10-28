# ADR 0013: Mounting the Console and API beneath a website path

- Status: Implemented for configured gateways; live production deployment is separate.
- Scope: Hosting the existing workspace below a parent website without reserving its root API paths.

Build the Console with a Vite base path. Keep the exact-origin configuration
contract and add an optional `apiPathPrefix` for requests and generated links.
The gateway strips that prefix before forwarding to the existing API routes.
`WORKSPACE_PUBLIC_PATH` scopes session and SSO cookies and validates the SSO
callback/return path. No model, provider, authorization or persisted-data behavior
changes. Root hosting remains the default; frontend and API remain independently
buildable and deployable as in ADR 0005.

The gateway must preserve API error statuses, methods, bodies and authentication
headers. Static fallback applies only after API/schema rules. Browser cookie paths
reduce accidental routing overlap; they do not isolate untrusted applications on
the same origin. Public-origin and trusted-proxy configuration still need deployment
validation. No deployment credentials or provider values belong in artifacts.

Transport tests cover prefix validation and raw requests. SSO tests cover the
prefixed flow/session/logout cookies, callback, return URL and revoked sessions;
existing root-host tests remain regression coverage.
