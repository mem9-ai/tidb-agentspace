# PostgreSQL column loading latency and recovery

Verified 2026-10-29 for [GH-94](https://github.com/siddontang/tidb.ai/issues/94), using the
existing anonymous db9 database and tables. No account/database was provisioned and no schema
or customer data was changed. The implementation PR identifies its exact candidate and CI.
This extends [ADR 0007](decisions/0007-database-browser.md) and preserves the accepted
[db9 boundary](decisions/0011-db9-postgres.md).

## Measured cause and result

The previous Rust table-description operation opened three sequential native TLS connections
for table identity, columns and indexes. On the existing preview, listing took 5,020 ms,
the exported `query_results_20261028_082601` description took 15,282 ms, and `agent_notes`
took 15,696 ms. These requests completed, but the UI had no whole-read deadline.

The isolated candidate returned the same descriptions in **7,164 ms** and **6,083 ms**;
listing was 5,325 ms. The exported table retained its one text column/no indexes, and
agent_notes retained all five columns, defaults and primary index. Measurements include
network variation and are observations, not an SLA. First reads still incur a remote connection.

The three server-generated PG metadata statements now share one fresh application-role TLS
session, one admission permit and a combined 15-second/1,000-row/1 MiB budget. Statements remain
individually prepared. Failure stops remaining reads, closes the connection and returns an
error without a partial description. User SQL keeps its independent session and existing
single-statement/result behavior. There is no persistent pool or automatic SQL retry.

The shared route-local cache from PR #95 retains at most 16 successful descriptions for 30
seconds. Continuous A/B/A browser switching displayed the cached columns in **181 ms**, including
automation overhead. Refresh/retry/resource changes invalidate cached metadata; errors and
aborted reads do not populate it. The MySQL combined query and DuckDB paths are retained.

## Bounded loading and recovery

Table list, selected-table metadata and row-preview reads use a **20-second** whole-read
deadline, including response decoding. It aborts the transport and displays an explicit
retryable error; navigation cancellation remains silent. Late responses cannot overwrite a
settled read. This does not retry SQL or assert a database write was rolled back.

A local fault-injection proxy stalled the metadata response while forwarding other requests
to the isolated Rust API. The browser canceled it after **20,002 ms** and showed
“Database read timed out. Try again or use SQL Editor.” in both inline columns and Table details.
After removing the injected stall, the explicit Try again action loaded all five columns
and the primary index. SQL text and navigation remained available. The proxy is test tooling,
not a product dependency or provider integration path.

## Checks and UI evidence

- `npm run check`: 161 passed; 11 environment-gated integration tests skipped in this gate.
- `npm run backend:check`: Rust format/Clippy/unit/doc checks and all 11 isolated real
  S3/metadata/Node–Rust compatibility tests passed, without cloud credentials.
- Native wire fixtures accept one connection for all metadata statements, initialize the
  search path once, avoid EXPLAIN/introspection, preserve empty fields, stop on an intermediate
  error or aggregate row/byte overflow, and receive protocol Terminate on cleanup.
- Deadline regressions cover a hung transport, success, original API failure, navigation
  abort, already-aborted calls, retry and late completion. Existing cache and authorization/
  provider parity regressions remain enabled. Public OpenAPI and permissions are unchanged.
- TiUI **2.9.1**, official SQL Editor **0.0.6**, shared theme/spacing and PostgreSQL dialect
  remain unchanged. Light/Dark at **1280×900** and **390×844**; computed body/editor text
  **16px**, no page-wide horizontal overflow. Inline columns and Table details use the same
  completed/error snapshot. No new component migration gap is introduced.

Screenshots: [desktop dark](screenshots/pg-column-latency/desktop-dark.png),
[desktop light](screenshots/pg-column-latency/desktop-light.png),
[narrow dark](screenshots/pg-column-latency/mobile-dark.png),
[narrow light](screenshots/pg-column-latency/mobile-light.png),
[stalled request recovery](screenshots/pg-column-latency/timeout-retry.png).

The legacy Node PG adapter retains its existing sequential connection behavior; the shared
Console deadline still bounds its visible loading. Rust is the serving backend. Cloud latency
and db9 SQL/type compatibility remain provider limitations; credentials stay internal and
authoritative metadata/provider state requires no migration.
