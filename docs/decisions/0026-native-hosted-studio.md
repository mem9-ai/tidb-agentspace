# ADR 0026: Native hosted Studio and fresh deployment

- Status: Accepted owner direction; implementation/evidence follows GH-13.
- Date: 2026-10-30.
- Contract: [GH-13](../../specs/gh-13/spec.md).

Rust is the only serving runtime, including hosted Studio. Port TiDB Account public-client code/S256 PKCE, owner grants, session/cookie and public HTTP policy into native modules. Keep Console static publication and `/studio` gateway mounting independent. Keep Workspace Key authorization in the shared native domain.

The owner explicitly permits discarding the old deployment's data. Use deliberate new encrypted record roots and runtime configuration; no JSON/vault migration, Node fallback or perpetual destructive reset. Shared external infrastructure and unrelated secrets are outside deletion scope. Do not roll a Node image back against native configuration/storage. Runtime configuration and recovery belong to the operator. The owner's 2026-10-30 clarification limits dev CD to updating the existing Deployment image, without a native annotation prerequisite, health wait or automatic rollback; see [ADR 0013](0013-dev-kubernetes-cd.md). Preserve a complete known-good configuration/image pair for operator recovery.

This supersedes ADR 0025's hosted Node compatibility restriction. That decision remains a historical record of the repository consolidation. Native local development can retain explicitly enabled loopback guest sessions; public listeners must require SSO. The owner’s 2026-10-30 follow-up also retires the Node business source and its dedicated regression tests. Node remains Console/build/operator tooling and native integration fixtures only, never part of the product API. Native tests assert the public contract and expected behavior directly; they must not launch a second business implementation. See [retirement verification](../native-backend-retirement.md).
