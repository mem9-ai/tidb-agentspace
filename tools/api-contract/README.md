# Public contract tooling

`server/generate-openapi.mjs` is the editable OpenAPI generator; these schema-only modules
describe its public shapes and fixed limits. They contain no provider, persistence,
authorization or execution implementation. Native response tests check the generated schema
against the Rust API; runtime capability discovery remains authoritative for availability.

`generate-client.mjs` produces the shared Portal client types from the generated internal
`portal-regional-openapi.json` and `portal-global-openapi.json`. Public `openapi.json` and
`global-openapi.json` describe Agent operations; `owner-openapi.json` describes the regional
owner-only history operations. Portal session and Key administration
operations are kept in the separate Portal contracts. Use
`npm run api:generate` and `npm run api:check`; do not edit generated outputs manually.

The native import fixture `server/test-support/fixtures/import.parquet` is a fixed DuckDB
2.0.0-generated Parquet file: one BIGINT column `id`, values 0 through 24. Native tests read
and import all 25 rows while returning only the 20-row review sample. Its bytes are checked
in so running the tests does not require a second Node DuckDB engine.
