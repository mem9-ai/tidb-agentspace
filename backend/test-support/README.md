# workspace-test-support

This crate tests the native backend through its process and HTTP boundaries. [Fixture helpers](src/lib.rs) own temporary data, child processes and loopback ports. [Provider fixtures](src/provider.rs) and [OIDC fixtures](src/oidc.rs) let tests exercise real authorization and persistence without cloud credentials.

From the repository root with the [native prerequisites](../../README.md#local-setup) installed:

```sh
cargo run --locked -p workspace-build-tools -- prepare
cargo build --locked --workspace --bins --examples
cargo test --locked -p workspace-test-support --test contract -- --ignored
```

Choose a [test target](tests/) for the boundary you changed. Many process tests are ignored during ordinary Cargo unit tests and are selected explicitly by [the acceptance runner](../build-tools/src/bin/workspace-verify.rs). The [verification guide](../../docs/standards/openapi-verification.md) lists profiles and their scope.
