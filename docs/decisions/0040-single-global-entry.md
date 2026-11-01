# ADR 0040: One Global endpoint for agent connections

- Status: implemented for newly issued Keys; older Keys retain Workspace-scoped issuance.
- Date: 2026-11-01.

## Decision

An agent configures a single API endpoint ending in `/api` and its Workspace Key. For example,
`https://workspace.example/studio/api` is the endpoint when the product is mounted at `/studio`.
The endpoint serves `/v1/token-issuances`, `/v1/workspaces/{workspaceId}/region-route`, and
the discovery contract at `/openapi.json`; the Global management mount remains internal.
Global verifies the Key,
identifies its Workspace and selected Region, and issues an appropriately scoped Token. A
bodyless Global request with a Global Token returns a 307 to the Region API base. The client
handles that response manually and compares it with authenticated Global issuance before sending
Region credentials. SQL, file contents and other data requests go directly to Region; Global
does not proxy them. Never put credentials in a redirect URL or forward the Workspace Key to
Region. Region never calls Global.

Fresh and rotated Keys include an encoded non-secret Workspace lookup hint. Global treats the
hint as untrusted and authenticates the entire Key against the exact Workspace record. It does
not need a cross-tenant scan or separate lookup index. Existing Keys without hints continue to
work on the Workspace-scoped issuance API; they need a normal rotation or replacement to use
the new entry point. No Key or provider credential is silently discarded.

The repository Node client `connectAgent` accepts a Global endpoint and Key, validates the
redirect, enrolls a proof-bound regional session and caches the route. Defaults are in-memory;
restart recovery during a Global outage requires the caller to retain both its proof key and a
protected secret store. Cached credentials and route are integrity-bound to the Key and Global
endpoint. Client data operations never replay an uncertain write. Existing Key expiration and
delivered revocations remain authoritative.

Global discovery currently chooses the single Region in the Key's grant. Multi-Region choice
is future work. Cross-origin browser Fetch can expose manual redirects as opaque, so the
repository client workflow is currently Node-oriented. Raw HTTP callers inspect redirects
without automatic credential forwarding and validate the target before sending Region Tokens.
The current client is repository code, not a published SDK.
