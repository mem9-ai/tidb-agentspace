# workspace-build-tools

This crate prepares native dependencies, packages a reviewed backend and runs acceptance profiles. [DuckDB preparation](src/duckdb.rs) selects and verifies the pinned prebuilt library. [Packaging](src/package.rs) takes a source revision and binary and emits the distributable with its checksums.

From the repository root, run `cargo run --locked -p workspace-build-tools -- prepare` before building Execute or the host. For release inputs and output paths see [build and package](../../docs/rust-backend.md#build-check-and-package).

The [verification binary](src/bin/workspace-verify.rs) implements the `cargo acceptance` alias and selects cases from [test support](../test-support/). Run `cargo test --locked -p workspace-build-tools --bins` for preparation, packaging and suite-selection unit tests.
