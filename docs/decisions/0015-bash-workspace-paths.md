# 0015: Preserve the selected Workspace path inside Just Bash

- Status: Accepted owner correction for the loopback prototype, 2026-10-28.
- Scope and reproduction: [GH-67](https://github.com/siddontang/tidb.ai/issues/67), source
  `00ca073e6165292978069e5611a6028668657cde`. Running `cat` with the selected file's visible
  absolute path failed because the worker exposed only a fixed virtual filename.
- Supersedes: ADR 0010's fixed-name-only mapping and GH-63's requirement to translate a
  Workspace path into `/workspace/input.log`. ADR 0010's isolation/permissions and ADR 0014's
  independent method selection remain in effect.

## Decision

Mount the one authorized saved snapshot at its actual absolute Workspace path in Just Bash's
in-memory filesystem. The file header and interpreter now use the same identity. This is a
virtual snapshot path, never a native host path or a mount of the provider filesystem.
Provider reads still happen only through the authorized snapshot adapter; the child receives
the public Workspace path separately from the private temporary source path.

The Bash option in capabilities adds optional `input` metadata containing `path`,
`workingDirectory` and `aliases`. The service derives it from the normalized selected path;
clients cannot supply a mount, working directory, alias, native path or environment. Optional
current-file variable discovery is defined by [ADR 0016](0016-bash-selected-file-variable.md). The
Console uses this metadata for its copyable input, samples, limits and error recovery.
Samples single-quote the entire path and escape embedded single quotes, so spaces, shell
metacharacters and newlines cannot interpolate additional commands.

Keep cwd `/workspace` and offer `/workspace/input.log` as a compatibility symlink to the
same snapshot when the paths can coexist. A symlink avoids retaining another file body.
If the alias equals the primary path, no extra alias is needed. If either would be a parent
of the other (for example a selection at `/workspace/input.log/nested.log`), omit the alias
rather than replacing a real file/directory. Report only aliases actually available.
Relative paths resolve from the reported working directory, not the selected file's parent;
the full displayed input path is the recommended command input.

Only the selected bytes and required virtual parent directories are exposed. An alias never
selects another file. Existing read-only proxies, command allowlist, no network/native programs,
fresh disposable workers, budgets, cancellation and Workspace Key checks remain unchanged.
This correction does not authorize listing/reading sibling files from the provider or exposing
provider credentials to the child. SQL's table `file` is unchanged.

## Compatibility, operations and verification

No persisted-data/grant/credential migration. New Console code falls back to the legacy input
when an older API lacks metadata. Old commands continue through the compatibility alias where
possible; the rare ancestor collision cannot represent both a file and a directory, so those
clients must use the newly reported primary path. Revisit before reserving another namespace.
Restart the API for this worker change and refresh Console assets. Rollback restores the fixed
input path without modifying customer files.

Verify the exact reported `cat /file-analysis-demo-9de2ebb1/service.log`, root/nested/special
paths, alias equality/ancestor collisions and old absolute/relative input commands against
the real interpreter. Prove unselected/host files and writes through both names remain denied;
validate HTTP metadata and strict request fields. Check safely quoted examples, copy, errors,
independent CSV modes, themes/desktop/mobile, limits and standalone API packaging. See
[usage and evidence](../file-analysis-verification.md#workspace-path-identity).
