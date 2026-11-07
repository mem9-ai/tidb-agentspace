# ADR 0056: Public report continuity and explicit sharing removal

Accepted direction: owner feedback and the two coding-agent journey reviews, 2026-11-06.
This is a bounded improvement to [ADR 0052](0052-anonymous-agent-report.md) and
[ADR 0053](0053-trial-report-view.md), based on source
`c6242c9fe80c38398b91643a2959620ca58e2239`. The broader scoped pairing and native agent
execution evidence in GH-150/GH-158/GH-159 remain separate work.

## One report body, explicit copies

The trial API returns canonical Markdown alongside the aggregates. Local clients and
**Open report in Workspace** save these exact bytes, including report UUID/revision provenance.
The viewer may visualize the aggregates differently; an import must not invent SQL or another
report title. Both clients save the report and immutable `us-sales.csv` under the selected
project's `reports/tidb-agent-workspace/` directory. Credentials stay outside the project.
Local user edits and symlink destinations are preserved, not silently replaced.

New Workspace imports use `/us-sales-report.md` and `/us-sales.csv`, matching the existing
browser sample. Re-entry reuses exact content. A later revision can conditionally update an
unchanged prior import, using the Workspace's version and a browser-local receipt of its
public report ID, revision and content hash. Conflicting edits, a missing receipt, another
report ID, or a stale incoming revision cannot overwrite the destination. Historical filenames
are still readable and transferable; existing user files are not renamed or deleted.

This is an explicit copy into the reader's Workspace, not a claim of the writer's identity or
a live mounted view. A source update is reflected in the Workspace on re-entry through the
report's action. The public read grant never supplies Owner authority, a Workspace Key, or
an account identity. Account continuation carries the current saved report/source using the
existing complete-read, version and unsaved-change guards.

## Predictable local project selection

Accepted after first-use feedback: an unrelated `~/.git` must not capture reports from
Downloads or another non-repository folder. Default lookup stops before the home or filesystem
root; a real repository below that boundary is reused, otherwise the current directory is used.
An existing binding in the selected folder or its project parents takes precedence.
An explicit `--project` selects that exact directory. A new home/root binding is refused;
existing home-bound reports remain accessible through explicit selection.

Before any key creation or remote request, both public and private helpers check for a binding
at the former parent root. When the newly selected folder has none, the agent offers continuing
the original report or explicitly starting separately. It does not migrate ambiguous home-wide
identity or silently make another trial. New independent reports preserve the original binding.
The resolved output folder is visible before public-report writes. Default output gives the
verified finding, Studio/local links, expiry/share visibility and the next action; `--json`
retains structured output for agents. Only canonical server Markdown is saved; local calculations
verify the numbers instead of constructing a second report body.

Offline helper regressions cover home-repository boundaries, exact selection, old-binding
recovery without key/network side effects, nested-project continuity and both output modes.
The legacy local install names remain compatibility details, explained once in the skill.
Dependency logs are quiet while failures remain visible. Full dependency locking, independent
release signatures and complete runtime uninstall are separate improvements, not claims of
this UX change. Revisit project selection if portable project identities replace path bindings.

## An open viewer stays current

The isolated viewer checks for updates every ten seconds while visible, immediately on focus,
visibility return or page restoration, with no overlapping requests. Transient failures retain
the last confirmed report and back off to one minute. Original expiry still clears the page;
revocation or invalid access clears it on the next check. Hidden pages stop polling. Cookies,
referrers, analytics and Workspace bootstrap remain absent from this reader.

## Public skill identity

The canonical public entry is `/studio/skills/tidb-agent-workspace/SKILL.md`.
Use it in copied prompts, discovery pages and installer downloads. The former
`drive9-workspace` URL remains a byte-identical compatibility alias, generated and
checked by `scripts/check-trial-installer.mjs`; maintain only the canonical assets.
Keep existing local installation and credential locations to preserve cross-agent
identity. A public name correction must not create a second key or lose reports.

## Reuse Python and secure storage

Keep one Python helper and the native Keychain,
Secret Service or Credential Manager. Reuse the installed isolated environment and credentials.
A missing compatible interpreter or secure store stops the journey with a specific prerequisite;
no automatic interpreter installation, alternative runtime or plaintext key fallback is allowed.
With Python already available, first use can install the helper dependencies once. The installer reuses its environment,
installs dependencies only when needed and preserves customized managed-skill files.

Support Python 3.9.2+ (including this Mac's developer-tools Python 3.9.6). Keyring 25.6.0
supports Python 3.9; cryptography 46.0.5 excludes 3.9.0/3.9.1. Replace the Python-3.10-only
filelock dependency with a bounded standard-library OS lock (fcntl on Unix, msvcrt on Windows).
Process exit releases the lock; two agents in the same project still serialize identity creation.
Python availability is detected, not inferred from the OS. Native Windows/Secret Service
behavior requires platform evidence; macOS alone does not verify those platforms.

Expiry denies server access at the original deadline. The next local invocation deletes the
expired key; no background cleanup service is installed. `forget` removes local access only
and retains all project files. A new trial requires explicit `new` after expiry/removal.

## Close links separately from deleting a key

`DELETE /agent-trial/report-sharing` accepts only the report's signed-in writer session.
It permanently sets a durable `sharingRevoked` flag; retries are idempotent. Existing records
default to false. Every read grant for that report then returns 410 `REPORT_SHARING_REVOKED`,
including grants re-signed with the same key. Updating/reopening the report cannot clear this
flag or extend expiry. Writer access and local files remain usable. Read-only recipients cannot
revoke, write or reach another report. A failed revocation must not be described as success.

`unshare` confirms this operation before `forget` is offered as combined removal. The two
operations have distinct consequences. Removing a local key alone never claimed server revocation.

## Rollout and acceptance

Deploy the additive API before publishing clients requiring canonical Markdown. After sharing
revocation is enabled, do not roll the API back to a reader that ignores the flag; retain this
check or disable public report reads. Older clients continue to use aggregates and get normal
410 responses for closed links.

Acceptance covers two independent clients, nested project paths, restart/retry identity,
canonical local/API/Workspace bytes, source reuse, conditional revision updates and edit
conflicts, automatic/focus refresh, transient failure and expiry, revocation isolation and
restart durability, local forget/expiry retention, missing secure-store rejection, and old-Python compatibility.
This public sample still uses fixed, reproducible analyses. It does not prove arbitrary agent
SQL execution, a unified Workspace pairing flow, private publishing, billing or cloud hosting.

Runtime metadata: [keyring 25.6.0](https://pypi.org/project/keyring/25.6.0/), [cryptography 46.0.5](https://pypi.org/project/cryptography/46.0.5/).
