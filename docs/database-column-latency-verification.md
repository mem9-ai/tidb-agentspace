# MySQL column expansion latency

Verified 2026-10-29 against the existing anonymous TiDB Cloud Zero database and table.
No database was provisioned and no schema/data mutation was used for this verification.

## Cause and change

The selected-table endpoint opened three fresh TLS sessions in sequence for table identity,
columns and indexes. Two baseline requests to the running Rust API took 27,507 ms and 14,231 ms;
table listing took 6,215 ms. Native SELECT measurements showed most time inside the provider
operation, rather than rendering. These are observations over a variable network, not an SLA.

Rust and the retained Node API now execute one server-generated UNION ALL catalog statement.
Every branch restricts schema and exact table name; ordinal/index-part order is retained.
The combined response stays within the existing 15-second, 1,000-row and 1 MiB native budget;
overflow fails explicitly. No connection pool, authorization cache or SQL retry was added.

The new endpoint in an isolated Rust regional preview returned `id`, `note` and `PRIMARY`
in 6,452 ms and 9,925 ms. Running the combined SQL through the original gateway also succeeded
in 6,671 ms and 7,539 ms. First loads still incur a verified remote connection. The Console
retains up to 16 successful table descriptions for 30 seconds; returning to a cached table
avoids another request. Refresh/retry/resource changes invalidate this route-local cache.

## Checks

- `npm run check`: passed, 157 tests passed; 11 environment-gated tests skipped in this gate.
- `npm run backend:check`: passed Rust format/Clippy/unit/doc checks and all 11 isolated
  S3/metadata/Node–Rust compatibility tests, without cloud credentials.
- Metadata tests assert a single native call, complete columns/composite indexes/defaults,
  missing-table behavior, hex-safe unusual names, safe error propagation, and authorization
  before provider I/O. Rust/Node parity asserts a single MySQL call and unchanged result shape.
- Cache tests cover A/B/A reuse, expiry without sliding renewal, resource/refresh invalidation,
  bounded retention and least-recently-used eviction. Failed/aborted requests never populate it.
- Browser: real table expansion; collapse/reopen displayed columns in about 275 ms including
  browser automation overhead. Query table and Run query returned both existing rows. Refresh
  performed a fresh list/metadata read while retaining the SQL draft and completed results.
- TiUI 2.9.1 and the official SQL Editor remain unchanged; no typography, palette, spacing or
  component override was introduced. Checked Light/Dark at 1280×900 and 390×844.

Screenshots: [desktop dark](screenshots/column-latency/desktop-dark.png),
[desktop light](screenshots/column-latency/desktop-light.png),
[mobile dark](screenshots/column-latency/mobile-dark.png),
[mobile light](screenshots/column-latency/mobile-light.png).

Canonical behavior and limits: [ADR 0007](decisions/0007-database-browser.md).
PG native-session optimization and whole-read UI deadlines are tracked separately in GH-94.
