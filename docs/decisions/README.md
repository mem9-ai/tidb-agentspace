# Architecture decisions

Record a short ADR for a change to a public contract, isolation model, credential boundary,
billing behavior, design-system foundation, or deployment architecture. Number files
sequentially as `NNNN-short-title.md`. Include status, context, decision, consequences,
migration, and how the decision is verified. Routine implementation choices do not need an ADR.

## Accepted decisions

- [0001: Unified Workspace Key](0001-unified-workspace-key.md)
- [0002: TiUI as the shared frontend foundation](0002-tiui-design-system.md) — implemented;
  see its linked standard for current integration and verification evidence.
- [0003: File System regions and provider modes](0003-filesystem-regions-and-modes.md) —
  Singapore default, additive API support, preserved existing regions, and mode boundaries.

- [0004: Drive9 anonymous provider](0004-drive9-anonymous-provider.md) — real Singapore files, private backend bindings, bounded transfers, and explicit provisioning recovery.

- [0005: Zero SQL gateway](0005-starter-sql-gateway.md) — real anonymous MySQL, backend credentials, scoped Workspace Keys, expiry/recovery, and temporary PG withdrawal.
