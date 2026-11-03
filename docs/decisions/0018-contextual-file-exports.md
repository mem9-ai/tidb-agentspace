# 0018: Separate original-file actions from output export

- Status: Accepted and implemented, 2026-10-29.
- Contract/acceptance: [GH-79 specification](../../specs/gh-79/spec.md).
- Extends ADR 0013 and 0017 without changing read-only analysis or existing SQL export contracts.

Preview actions target the saved original; result actions target the completed SQL result or
chosen Bash stream. Following the 2026-11-03 owner feedback on the file-centered Workspace,
CSV and Parquet previews offer **Create table** directly in addition to Export. This opens the
same database-targeted preparation and explicit review; the original remains unchanged. Other
files retain Export, and output actions remain separate. This supersedes GH-84's single-action
rule for tabular previews without changing the export API or the original/output authority.
Download original remains a destination inside the explicitly labeled original file dialog.
Draft download/save stays explicit in the preview/source header. A source footer must not appear under output.
Raw downloads/copies preserve bytes. Export never reruns SQL or Bash.

Offer the same destinations through shared controls. Database import of original files or Bash
text requires explicit format/schema/type review. Use a bounded server preparation, bound to
the current principal and saved input version, followed by an explicit confirmed write. Keep
rows internal, expire/limit preparations, reject replay after a write begins and reauthorize
source/target on commit and each write. Fixed parsing stays in disposable credential-free workers.

Original copy requires read access; parse/import and output export additionally require analyze.
Destination write grants stay explicit. Retain existing conditional file creation, dialect-safe
new tables, partial-write reporting and no automatic retries/DROP. No provider secret, hidden
DuckDB storage, native shell or arbitrary connection becomes a product capability.

No persisted-data migration. A restart invalidates preparation handles, while completed files/
tables survive code rollback. Revisit before persistent jobs, larger imports or new formats.
See [verification and API usage](../contextual-file-export-verification.md) for FE-01–06 evidence
and current limits. This supersedes the ambiguous file-panel Download placement, not ADR 0013's
existing result snapshot authority or limits.
