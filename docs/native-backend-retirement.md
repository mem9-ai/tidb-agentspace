# Native backend and verification

The [Rust workflow decision](decisions/0059-rust-backend-workflow.md) covers the API, Meta, local supervision, OpenAPI and backend acceptance. The earlier [hosted Studio decision](decisions/0026-native-hosted-studio.md) describes the original Node retirement and the fresh encrypted storage boundary.

## Build and run

Follow the [local setup](../README.md#local-setup) for an empty Workspace and [the Rust guide](rust-backend.md) for private configuration, embedded and remote Meta, and native packaging. Global and regional roles can run in one executable or as independently deployed processes.

## Verification ownership

| Capability                                                                             | Verification                                                                                                                                                          |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract schemas and all declared regional JSON operations                             | [Rust OpenAPI](../backend/openapi/) and [live HTTP contract tests](../backend/test-support/tests/contract.rs)                                                         |
| Owner and Workspace Key authorization, expiry, revocation, scoped SQL and files        | [Native integration suites](../backend/test-support/tests/) against isolated Global and regional services and loopback providers                                      |
| In-process and remote Meta, writer fencing, durable acknowledgments and crash recovery | [Host transport](../backend/test-support/tests/host_transport.rs) and [Meta](../backend/test-support/tests/meta.rs)                                                   |
| Guest isolation, SSO, identity and credential continuity                               | [Guest](../backend/test-support/tests/guest_host.rs), [identity](../backend/test-support/tests/identity_directory.rs) and [SSO](../backend/test-support/tests/sso.rs) |
| On-disk permissions, local startup and shutdown, native packaging                      | [Local lifecycle](../backend/host/tests/local_runtime.rs) and [package acceptance](../backend/build-tools/tests/package.rs)                                           |
| Published SDKs                                                                         | [Client integration](../tools/agent-client-tests/) against disposable Rust services                                                                                   |

Run the [contributor commands](../CONTRIBUTING.md#rust-backend-modules), including `cargo acceptance all` for full backend acceptance. See [OpenAPI verification](standards/openapi-verification.md) for coverage and browser applicability. Keep deployment credentials, local data and encryption keys outside Git and release artifacts.
