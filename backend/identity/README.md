# workspace-identity

[Directory](src/lib.rs) turns a verified issuer and subject into a stable personal identity and Workspace reservation in Global metadata. The API supplies the verified identity. [Onboarding](src/onboarding.rs) coordinates the regional side. Keep Global reservation and regional activation distinct so an interrupted signup can resume with the same IDs.

[Global Keys](src/global_keys.rs) own issuance. [Regional Key policy](src/regional_key_policy.rs) and [refresh grants](src/regional_refresh.rs) support access in the assigned Region. Identity code uses the [metadata contract](../contracts/). [HTTP handlers](../api/) own browser callbacks and credential presentation. See [personal account isolation](../../docs/decisions/0030-personal-account-isolation.md).

Run `cargo test --locked -p workspace-identity --lib` from the root. [Identity directory acceptance](../test-support/tests/identity_directory.rs) exercises persisted state using the native fixtures.
