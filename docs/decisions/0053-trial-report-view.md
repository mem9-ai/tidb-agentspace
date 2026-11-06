# ADR 0053: Read-only Studio links for trial reports

Amended by [ADR 0056](0056-report-continuity.md): canonical project reports, automatic viewing, Python environment reuse and explicit sharing revocation.

[Accepted behavior](../../specs/gh-214/spec.md) extends the [anonymous local report](0052-anonymous-agent-report.md). After confirming a saved revision, the helper signs a read grant for the report UUID and its original expiry. Ed25519 signatures are deterministic, so another agent with the same project binding returns the original URL. Existing active reports need no migration. The viewer reads the same durable regional report on every open. Reading cannot create a report, issue a writer session, extend the deadline or authorize Workspace access.

The URL carries the grant in its fragment. The isolated viewer passes it only in the authorization header to the same-origin read endpoint, omits cookies and referrers, and skips Workspace bootstrap and analytics. Anyone given the full link may read this sample report until the trial deadline. Treat it as a bearer capability. The server checks the signature in a separate domain from writer proofs, the report identity, saved revision, and original deadline. Neither the private key nor a writer session enters the URL. Forgetting a local key ends local editing; issued links still expire on the original schedule. Trial expiry leaves the local Markdown accessible.

The public regional OpenAPI documents the wire format. Private Workspace publication, owner claims and spending need separate authorization.

Choosing **Open report in Workspace** copies the displayed public analysis and verified public CSV through existing conditional file APIs into the reader's own authenticated Workspace or a new browser Guest. This initial transfer contains only public file content, with a short tab-local deadline. The read grant stays in the original report history entry. Identical saved files are reused and edited destinations are preserved. Import completion opens the saved Markdown alongside its source.

The helper's `insightsUrl` selects `?view=markets` with the same grant and deadline. This presentation computes the top-two-state share from the saved state totals; it is not another stored revision.

The completed viewer has one continuation: open the report in Workspace. A Guest sees the 48-hour temporary-session notice there, with **Save to TiDB Cloud**. This explicit action reads only the displayed sales report and its saved source CSV through the current Owner session, including saved edits. It verifies complete text and stable file versions before placing the two contents in a bounded, ten-minute tab-local transfer. Unsaved changes retain the existing save/discard guard. Failures keep the Guest open. The account sign-in return imports through the same conditional APIs, preserves conflicting destination files, and opens the report with **Connect my agent** and **Explore sample data**.

No trial identity, Guest session, Workspace Key, or read grant is transferred. This is an explicit two-file copy, not a Workspace claim or general private-data migration; the original session and report-link deadlines do not change. The transfer is cleared on completed import. Existing account readers open their Workspace directly without a redundant sign-in choice.
