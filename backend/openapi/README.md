# workspace-openapi

[View](src/lib.rs) builds the API description for each audience from the [regional](src/regional/), [Global](src/global/) and [operator](src/operator/) definitions. HTTP handlers and offline exports share these definitions. A running host binds server URLs to its configured mount. Client generation consumes the checked-in exports.

For a route change, edit its definition and the corresponding [handler](../api/), then run `npm run api:generate` from the repository root to update the JSON exports and Console types. [The API guide](../../docs/api-guide.md) identifies the appropriate view and credentials.

Run `cargo test --locked -p workspace-openapi --test views` for audience and route checks. Use `npm run api:check` to compare generated artifacts with the checkout.
