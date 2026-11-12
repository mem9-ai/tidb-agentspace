# workspace-providers

[Providers](src/lib.rs) translates regional operations into Drive9 File System requests and db9 PostgreSQL provisioning. [The SQL driver](src/sql.rs) executes statements over a bounded native connection and converts database values into the public result shape.

Callers in [product](../product/) authorize the resource and action before provider I/O. Provider account and resource bindings come from the private [Workspace repository](../workspace/). A lost provisioning response can leave a real resource behind. Follow the provider-specific reconciliation procedure before attempting another creation. See [db9 setup and recovery](../../docs/db9-postgres.md) and [the Drive9 boundary](../../docs/decisions/0004-drive9-anonymous-provider.md).

Existing private deployment files can still contain `mysqlProvider` and `zeroEndpoint`. The config parser validates these legacy settings. Public discovery and creation expose only PostgreSQL and File Systems under [ADR 0058](../../docs/decisions/0058-public-resource-kinds.md). Guest cleanup can still reconcile an old DuckDB resource's private Drive9 store using a durable, scoped deletion permit under [ADR 0029](../../docs/decisions/0029-guest-logout-cleanup.md).

Run `cargo test --locked -p workspace-providers --lib` from the root. For provider effects, use the [native acceptance fixtures](../test-support/), which supply loopback providers and isolated storage.
