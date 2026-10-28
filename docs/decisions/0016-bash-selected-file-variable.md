# 0016: A discoverable FILE variable for the selected Bash input

- Status: Accepted owner correction, 2026-10-28; [GH-69](https://github.com/siddontang/tidb.ai/issues/69).
- Baseline: `9ba07863d78d5b2d05f3aaa5375275a5e33d443d` and [ADR 0015](0015-bash-workspace-paths.md).

Keep the first Bash command and ordinary examples filled with the selected file's safely
quoted absolute Workspace path. Also define `FILE` as that path in every fresh interpreter,
so `cat "$FILE"` and `head -20 "$FILE"` are reusable across file selections. `FILE` is a
Workspace convention, not a Bash built-in. Always double-quote its expansion; shell characters
inside its value remain filename data rather than additional commands.

The Bash input metadata adds optional `fileVariable: "FILE"`. The Console advertises the
variable and its example only when that capability is present. Older APIs continue to show
working absolute-path examples; old clients and existing absolute/alias commands are unchanged.
The input path, working directory, compatible aliases and collision handling remain ADR 0015's.

The worker constructs its interpreter environment with only this selected public path;
it does not inherit the parent's FILE value or provider/API credentials. Clients cannot
supply environment configuration. Scripts may assign/unset the variable within their own run,
but cannot gain access to an unselected file, modify the read-only snapshot or persist the
assignment. Every new execution starts with the authorized selected path again.

No scope, resource, mount, provider, persisted-data or credential migration. Update/restart
the API for the variable binding and refresh Console assets for discovery/help. Rollback
removes variable support; absolute paths still work. Revisit before adding execution variables
that contain secrets, other resource paths or persistent session state.

Verify real quoted expansion for ordinary/special filenames, alias collisions, fresh-run
reset, denied unselected reads/writes, absent private environment, metadata and standalone
API packaging. Verify the initial absolute command, optional variable example, no automatic
execution, keyboard, 16px editors and both themes/desktop/mobile. [Usage and evidence](../file-analysis-verification.md#current-file-variable)
record the candidate's results; the implementation PR owns CI and final preview delivery.
