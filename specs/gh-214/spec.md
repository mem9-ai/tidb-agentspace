# Read an agent trial report in Studio

Parent intent [GH-214](https://github.com/mem9-ai/tidb.ai/issues/214). Source baseline `2cc97c6bfd8c27c62e315b56cb0e84254069cc81`. Extend the [anonymous report trial](../gh-210/spec.md) to the person receiving its results.

- **RV-1 · Handoff.** After a confirmed save, the local agent returns a clickable Studio link alongside the local Markdown. A local-only or unconfirmed result offers only its local file. Existing unexpired reports can acquire a link on resume.
- **RV-2 · Continuity.** An unauthenticated browser opens the latest saved report directly. A second client in the same project can add the product section. The first URL and report ID stay stable across updates, refreshes and service restarts. Present the state totals and the leading state's product analysis from the saved revision.
- **RV-3 · Read authority.** Possession grants only reading the specified anonymous public-sample report. A copied ID alone, altered credential, cross-report substitution or attempt to use the viewing credential for updates, Workspace access or agent authentication must fail. Keep the private signing key and writing session out of the link. Carry the read capability in the URL fragment and a dedicated authorization header, avoiding server URLs, telemetry, referrers and shared caches.
- **RV-4 · Expiry.** Enforce the original server-side 48-hour deadline on each read. Opening or sharing the link never extends it. Expired, invalid and temporary failure states must be understandable without sign-in. Preserve the local Markdown and the existing project key cleanup policy.
- **RV-5 · Boundary.** This covers the anonymous sales fixture. Private Workspace sharing, claiming, billing and a browser report library remain separate.

Acceptance uses a real regional service, durable restart, two independent clients, and a signed-out browser including narrow and dark layouts. Verify revision 1 has California at USD 48,000 of USD 100,000 and revision 2 adds Monitors at USD 18,000. Exercise the original link after revision 2 and after simulated expiry, plus cookie and write isolation. Verify the public Studio handoff after release.
