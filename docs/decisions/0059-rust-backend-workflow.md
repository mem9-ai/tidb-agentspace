# ADR 0059: Rust owns backend operation, contracts and acceptance

Accepted, 2026-11-08.

The same `workspace-backend` executable runs the API, Meta roles and local supervision. A local installation writes private configuration, starts an isolated RustFS instance, and runs the configured roles through the deployment plan interface. The remote Meta transport remains available for independent deployments and for testing isolation and recovery.

The Rust OpenAPI crate owns the definitions for the public, Owner, operator and internal Portal views. HTTP responses and offline exports use the same generator. Checked-in exports let client developers review contract changes without running a service.

Backend acceptance runs through Cargo against real Rust processes and isolated object storage. It covers both Meta transports, public HTTP, credentials, quota enforcement, durability, SQL and File System operations. Provisioning fixtures use loopback addresses. Node and Python are used for tests of clients written in those languages. Rust prepares native build inputs and packages the backend.

See the [local setup](../../README.md#local-setup), [backend commands](../rust-backend.md) and [verification guide](../standards/openapi-verification.md).
