# workspace-api

[WorkspaceServer](src/lib.rs) accepts regional HTTP requests, resolves caller credentials and connects authenticated requests to [Workspace](../workspace/) and [product operations](../product/). Start in [HTTP policy](src/http_policy.rs) for Host, Origin and CORS rules, or [regional security](src/region_security.rs) for agent credentials.

[Global API](src/global_api.rs) handles the separate Global entry. Keep the distinction when adding a route. Its authority, authentication and published audience must agree with the [OpenAPI view](../openapi/) and [API guide](../../docs/api-guide.md). The [host](../host/) supplies configuration and starts the selected roles.

After the [native fixture build](../../CONTRIBUTING.md#rust-backend-modules), run `cargo test --locked -p workspace-test-support --test contract -- --ignored` to exercise the HTTP boundary.
