# workspace-contracts

This crate defines the interface between a caller that needs Workspace metadata and the authority that owns it. [Metadata](src/lib.rs) accepts scoped Get, List, Commit and Resolve requests. The same types cross the embedded and remote boundaries. Storage and transport implementations live in [Meta](../../meta-service/) and the [remote client](../meta-client/).

A scope identifies an authority, owner, record family and partition. Related reads may span families within one Workspace partition. The embedded engine can serve them from one transaction. The default trait method performs a sequence of fenced reads. Callers that need one consistent snapshot must account for that difference.

Run `cargo test --locked -p workspace-contracts` from the repository root for the scope checks and executable grouped-read example.
