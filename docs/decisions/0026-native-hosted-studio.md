# ADR 0026: Native hosted Studio and fresh deployment

- Status: Accepted owner direction; implementation/evidence follows GH-13.
- Date: 2026-10-30.
- Contract: [GH-13](../../specs/gh-13/spec.md).

Rust is the only serving runtime, including hosted Studio. Port TiDB Account public-client code/S256 PKCE, owner grants, session/cookie and public HTTP policy into native modules. Keep Console static publication and `/studio` gateway mounting independent. Keep Workspace Key authorization in the shared native domain.

The owner explicitly permits discarding the old deployment's data. Use deliberate new encrypted record roots and runtime configuration; no JSON/vault migration, Node fallback or perpetual destructive reset. Shared external infrastructure and unrelated secrets are outside deletion scope. Do not roll a Node image back against native configuration/storage. Capture a complete known-good native configuration/image pair before ordinary image-only delivery.

This supersedes ADR 0025's hosted Node compatibility restriction. That decision remains a historical record of the repository consolidation. Native local development can retain explicitly enabled loopback guest sessions; public listeners must require SSO. Node is build/test tooling and an explicit behavioral oracle only, never part of the native deployment.
