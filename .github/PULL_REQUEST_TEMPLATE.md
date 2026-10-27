## Contribution links and baseline

State the contribution type: specification, implementation, acceptance case, harness, or small fix.
Link the parent intent and task Issue where applicable. Use `Refs #...` for design or partial
work. Use `Closes #...` only when this PR completes that Issue's full promised endpoint;
a design-only PR must not close the parent feature intent.

For implementation, link the accepted specification at its full Git SHA, relevant requirement
IDs, source base, and acceptance baseline. For a small fix, link its reproduction or explain
the scoped problem. See `docs/standards/github-contribution-workflow.md`.

## Problem and resulting behavior

Describe the user-visible problem and what changes after this PR.

## Validation

List checks actually run and their results. Include screenshots/viewports for visible UI changes.
Explain any verification gaps.
Map mandatory requirement IDs to tests, completed reviews, and evidence references when using
a specification. Identify the evaluated candidate SHA and any baseline changes. Check results
must be current for the actual PR head; a completion claim does not replace them.
For UI work, cite the TiUI version/component references, shared overrides, and remaining
migration gaps; follow `docs/standards/tiui-design-system.md` for theme/viewport checks.

## Compatibility and operations

Describe API/schema/permission changes, migrations, configuration, or deployment/rollback impact.
State whether cloud providers are connected or behavior is simulated.

## Reusable knowledge

Link canonical standards/ADRs updated for reusable user feedback, conventions, or integration
findings. If none changed, briefly explain why; do not create a document for a one-off detail.
Separate accepted guidance from implementation status. See `docs/standards/knowledge-maintenance.md`.

## Author checklist

- [ ] I reviewed the diff, including agent-written code, and kept the scope focused.
- [ ] `npm run check` passes; meaningful regression tests cover changed behavior.
- [ ] Public contract, client types, and documentation match the implementation.
- [ ] Applicable TiUI rules and reusable-knowledge updates are addressed, with gaps stated.
- [ ] Resource/action authorization and credential boundaries are preserved.
- [ ] No credentials, local data, or personal agent settings are included.
- [ ] Introduced commits have the appropriate contributor's `Signed-off-by` trailer.
