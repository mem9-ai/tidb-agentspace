# workspace-cache-budget

Meta and analytics each open SlateDB instances. This crate divides the block-cache memory available to all instances sharing a host or container. [Policy::resolve](src/lib.rs) uses the detected memory limit. Use `Policy::allocate` with an explicit capacity for reproducible calculations.

When several processes share an allocation, configure the same total budget and instance count in each. Each database may use less than its share. An override above the share fails, even when it fits in the machine's total memory. [Meta configuration](../../docs/meta-service.md) documents the operator settings.

Run `cargo test --locked -p workspace-cache-budget` for allocation examples and Linux cgroup-limit cases.
