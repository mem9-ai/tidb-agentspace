# workspace-domain

[Workspace and Principal](src/lib.rs) authenticate callers and apply Workspace Key grants. [Repository](src/repository.rs) stores scoped records through the [Metadata port](../contracts/). The [product layer](../product/) uses these operations for both agents and the Console.

For a resource operation, check the action scope and the selected record. A resource-family grant can include future resources in the same Workspace. Checking only an explicit ID would miss those grants. The public-kind filter also excludes retired records. See [the grant model](../../docs/decisions/0060-workspace-key-resource-types.md).

Start in [the repository modules](src/repository/) for resource indexes, scoped history and other persisted state. Run `cargo test --locked -p workspace-domain` from the root, including the executable example on `Principal::permits_record`.
