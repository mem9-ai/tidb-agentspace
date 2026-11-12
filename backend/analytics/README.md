# workspace-analytics

Product analytics measures usage in a separate process with its own SlateDB storage. The [client](src/client.rs) enqueues native observations for bounded asynchronous delivery. A full queue or unavailable collector can lose observations. Permissions, billing and security audit decisions require authoritative business state.

Trace collection from the [service handlers](src/server.rs) through [aggregation](src/store.rs) to [the SlateDB implementation](src/database.rs). The [host](../host/) wires the analytics role independently of business Meta. The [operator guide](../../docs/product-analytics.md) explains isolation, access, and how to interpret the metrics.

Run `cargo test --locked -p workspace-analytics --lib` for client and storage behavior.
