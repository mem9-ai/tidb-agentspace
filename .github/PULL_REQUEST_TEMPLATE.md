## Problem and resulting behavior

Describe the user-visible problem and what changes after this PR.

## Validation

List checks actually run and their results. Include screenshots/viewports for visible UI changes.
Explain any verification gaps.
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
