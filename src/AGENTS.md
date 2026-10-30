# Frontend instruction entry point

Before editing any frontend component, CSS, theme, icon, or UI dependency, read the root
[AGENTS.md](../AGENTS.md), [CONTRIBUTING.md](../CONTRIBUTING.md), and
[TiUI design standard](../docs/standards/tiui-design-system.md).
Keep detailed design rules in that standard rather than duplicating them here.

Apply [product experience](../docs/standards/product-experience.md) to every flow: reuse
comparable patterns across resource types and remove unnecessary steps to a useful outcome.
Preserve necessary context, permission, parsing and discard decisions.

The console uses TiUI 2.9.1, its official icons, and the separate TiUI SQL Editor.
Reuse `src/ui/` and the single WorkspaceThemeProvider. Read the standard before changing
component styles: function-based upstream styles require composition, not plain-object
replacement. Verify actual exports, compatible peers, and rendered behavior on upgrades.

Capture reusable user corrections and integration findings using
[knowledge maintenance](../docs/standards/knowledge-maintenance.md). Update migration status
with evidence when completing a component migration. Preserve the larger-text/spacing
requirements and check both themes and narrow layouts as specified in the design standard.

Use the shared [browser verification standard](../docs/standards/browser-verification.md)
for functional assertions, theme/viewport coverage and trace-based diagnosis. Visual changes
still need focused visual review; avoid repeating unrelated flows through screenshots.
