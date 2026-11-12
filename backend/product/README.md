# workspace-product

[Product::handle](src/lib.rs) dispatches regional product operations for resources, databases, files and tutorials. It receives the credential from the [API](../api/), obtains authorization and records from [Workspace](../workspace/), and calls [providers](../providers/) or [Execute](../execute/) to perform the work.

Trace a file operation through [files.rs](src/files.rs). A fixed preview requires file read access. Custom SQL or shell analysis also requires the analyze grant before reading the selected snapshot. For operations that move data, follow both the source and the destination checks in [exports](src/exports.rs) and [imports](src/imports.rs).

After [preparing the native build](../../docs/rust-backend.md#build-check-and-package), run `cargo test --locked -p workspace-product --lib`. The [native product cases](../test-support/tests/product.rs) cover effects and recovery across HTTP.
