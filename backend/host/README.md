# workspace-backend

This crate builds the backend executable. [Command dispatch](src/lib.rs) selects local lifecycle commands, the API, Meta and other roles, or the internal Execute worker. [Deployment plans](src/plan.rs) wire the components and own startup and shutdown order.

Use the [local setup](../../README.md#local-setup) to prepare native dependencies, initialize a private runtime directory, start the stack and check its health. [Local supervision](src/local/) manages its RustFS process and configuration. The same executable can run an [independent deployment](../../docs/rust-backend.md) using embedded or remote Meta.

After the [native build](../../CONTRIBUTING.md#rust-backend-modules), run `cargo test --locked -p workspace-backend --test local_runtime -- --ignored --test-threads=1` to exercise the CLI lifecycle.
