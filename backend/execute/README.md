# workspace-execute

The Region uses [Executor](src/lib.rs) to run one computation in a disposable child of the current backend executable. [The parent](src/exec.rs) clears the environment, sends the task over bounded pipes and enforces its deadline. [The child entry point](src/entry.rs) decodes the request and flushes the result before exit.

[Native tasks](src/native.rs) use DuckDB for tabular snapshots and Bashkit for a restricted virtual shell. The [product layer](../product/) selects the file and checks permissions before passing inputs to Execute. Provider credentials stay in the parent. See [the computation decision](../../docs/decisions/0021-native-rust-computation.md).

From the root, run `cargo run --locked -p workspace-build-tools -- prepare`, then `cargo test --locked -p workspace-execute --lib`. The [host tests](../host/tests/execute.rs) also exercise the child protocol through the executable.
