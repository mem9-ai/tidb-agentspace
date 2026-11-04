# ADR 0048: Retire standalone MySQL and DuckDB databases

- Status: Implemented.
- Date: 2026-11-04.
- Scope: database discovery, creation and customer data operations.

## Decision

PostgreSQL-compatible databases through db9 are the only customer database offering. The
Workspace API rejects creation of MySQL/TiDB Zero and standalone DuckDB resources and does
not include existing instances in resource discovery or the Console. Their query, catalog,
import/export and setup operations are unavailable. Capability records for the retired kinds
remain for compatibility and explicitly report `available: false`.

This does not retire DuckDB as the bounded, read-only File System analysis engine. Analysis
continues to use its selected-file authorization and disposable execution boundary under
[ADR 0010](0010-read-only-file-analysis.md).

## Existing resources and restoration

Retirement is an access and provisioning change, not a data deletion. Existing records,
provider bindings, credentials and Workspace Key grants stay intact. Existing resource detail
and supported deletion/cleanup operations remain available for authorized lifecycle management;
provider acceptance is not proof of physical deletion, and Zero deletion remains unsupported.
Requests admitted before deployment may complete. Restoring either provider requires explicitly
re-enabling the public contract and capability checks, updating the Console and documentation,
and restoring provider-specific acceptance and safety coverage before release.

The internal provider and execution implementations remain present for potential restoration
and for existing lifecycle cleanup. Their presence must not be presented as a currently supported
customer database capability. Earlier decisions describing database support, including
[ADR 0006](0006-zero-sql-gateway.md) and [ADR 0008](0008-duckdb-private-storage.md), are
historical for the retired customer operations.

## Verification

Native API acceptance must verify that retired resource creation and operations are rejected
before upstream I/O, records remain intact, and supported lifecycle operations stay available.
The PostgreSQL and File System paths retain their existing authorization and integration coverage.
Console coverage verifies that neither retired kind appears in collections or direct navigation.
