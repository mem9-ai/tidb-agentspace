# OpenAPI and Console types

The Rust backend defines the HTTP contracts in [backend/openapi/src](../../backend/openapi/src).
Its HTTP handlers and command-line export use the same regional, Global and operator definitions.
Run these commands from the repository root.

```sh
cargo run --locked -p workspace-backend -- openapi regional
cargo run --locked -p workspace-openapi -- export
cargo run --locked -p workspace-openapi -- check
```

The first command prints one view. Choose `regional`, `owner`, `global`, `entry` or
`operator` for a public contract. Choose `portal-regional` or `portal-global` for the
session-authenticated Portal. The export writes the five public artifacts under `public/`
and the two Portal artifacts in this directory. The check reports drift in either set.

[generate-client.mjs](generate-client.mjs) uses the Portal and operator exports to build the
Console's TypeScript declarations. Run `npm run api:generate` to regenerate the contracts and
Console types together. Run `npm run api:check` to verify both.

[Rust HTTP acceptance tests](../../backend/test-support/tests) exercise the published responses
and authorization boundaries. Use the resource capabilities returned by the running API to
determine which providers are available.
