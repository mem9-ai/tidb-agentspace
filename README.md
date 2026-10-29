# TiDB Agent Workspace

An independent Workspace for developers and agents to use databases and files through one scoped Workspace Key. The Console is React/TiUI; business services are Rust. MySQL, opt-in db9 PostgreSQL, native DuckDB and independent File Systems have separate provider capabilities and credential boundaries.

Start with [start-here.md](start-here.md), [contribution rules](CONTRIBUTING.md) and [architecture](docs/architecture.md). Proposed hosted multi-tenancy and production identity remain distinct from the current trusted loopback development profile.

## Local setup

Use the exact Node/npm versions in `.node-version` and `package.json`, Rust from `rust-toolchain.toml`, and installed RustFS 1.0.4.

```sh
npm ci
npm run backend:build
npm run meta:local -- init --directory .data/meta-runtime --api-port 4318
npm run meta:local -- serve --directory .data/meta-runtime
```

Then run `npm run dev:console` in another terminal and open http://127.0.0.1:5173. The operator starts independent Global and regional Meta roles and the regional API. First creation produces an empty Workspace with no cloud provisioning or sample resources. Subsequent starts reuse its versioned encrypted SlateDB/S3 records. No JSON import is required or supported.

Provider configuration lives in private `.data/meta-runtime/rust-api.json`, under `product.providers`:

```json
{
  "filesProvider": "drive9-anonymous",
  "mysqlProvider": "tidb-cloud-zero",
  "postgresProvider": "db9-anonymous"
}
```

These modes enable explicit resource creation in the Console; startup does not provision instances. Defaults use local demo files/MySQL with PostgreSQL disabled. Native DuckDB also requires a separately verified tidbfs extension under `product.compute`. The service manages native credentials internally; callers use scoped Workspace Keys. See [Rust configuration](docs/rust-backend.md), [db9](docs/db9-postgres.md), [MySQL](docs/starter-sql-verification.md) and [DuckDB](docs/duckdb-databases.md) for boundaries and limits.

## Build and verification

| Component       | Build                   | Run                                                                  |
| --------------- | ----------------------- | -------------------------------------------------------------------- |
| Console         | `npm run build:console` | `npm run start:console` or static hosting                            |
| Rust API / Meta | `npm run build:api`     | `workspace-backend serve --config /absolute/private/deployment.json` |

`npm run check` runs the shared Node/Console quality gate. `npm run backend:check` runs the Rust and real isolated S3/API/native artifact suites. The Node modules under `server/` are regression oracles and tooling; they have no product-serving entry point and are not packaged as an API.

`npm run package -- FULL_REVIEWED_SOURCE_SHA` packages a reviewed clean native backend and separate Console assets with source SHA and checksums. Configuration and credentials remain outside artifacts. Console `/config.json` selects the API origin. Follow [independent delivery](docs/independent-delivery.md) and [CI/CD policy](docs/ci-cd.md).

Fresh record installation format 2 supersedes the old five-document bridge. Old roots fail explicitly; they are never silently reset. [ADR 0024](docs/decisions/0024-fresh-record-metadata.md) records the owner's authorized local reset and its exclusion of cloud deletion. This guest profile is not production login, automatic HA or verified million-resource capacity.
