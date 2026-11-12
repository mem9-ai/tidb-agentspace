# workspace-meta-service

[Engine](src/engine.rs) is the authority for encrypted, versioned records backed by SlateDB on object storage. The [host](../backend/host/) can embed it or expose the [Meta server](src/server.rs) to an authenticated [remote client](../backend/meta-client/). Both use the same [request contract](../backend/contracts/).

From the repository root, build this service with `cargo build --locked -p workspace-meta-service`. To run it together with isolated object storage and the regional API, follow [local development](../docs/meta-service.md#local-development).

For a write, follow the writer guard, expected record versions and mutation receipt through `Engine::execute`. The receipt and changes commit together so a caller that loses the response can resolve its mutation. Global and regional authorities use separate installations. [Operations and recovery](../docs/meta-service.md) describes initialization, fencing and restart.

Run `cargo test --locked -p workspace-meta-service --lib` from the root. After [building native fixtures](../CONTRIBUTING.md#rust-backend-modules), run `cargo test --locked -p workspace-test-support --test meta -- --ignored --test-threads=1` for durable commits, restart and fencing on isolated RustFS storage.
