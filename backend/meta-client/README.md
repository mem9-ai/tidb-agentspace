# workspace-meta-client

[RemoteMetadata](src/lib.rs) implements the [Metadata port](../contracts/) over HTTP. The host supplies a private client configuration. Connection setup checks that the remote service reports the expected authority and installation. HTTPS requires mutual TLS. Cleartext transport is an explicit loopback test option.

A lost response can follow a successful commit. The client disables HTTP retries and reports an uncertain commit to its caller. Use the original mutation ID to resolve the outcome against the same authority. The [Meta protocol](../../docs/meta-service.md) describes receipts and writer fencing.

After the [native fixture build](../../CONTRIBUTING.md#rust-backend-modules), run `cargo test --locked -p workspace-test-support --test host_transport -- --ignored` for transport integration.
