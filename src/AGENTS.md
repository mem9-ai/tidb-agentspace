# Frontend instruction entry point

Before editing any frontend component, CSS, theme, icon, or UI dependency, read the root
[AGENTS.md](../AGENTS.md), [CONTRIBUTING.md](../CONTRIBUTING.md), and
[TiUI design standard](../docs/standards/tiui-design-system.md).
Keep detailed design rules in that standard rather than duplicating them here.

TiUI is the accepted component foundation. The current custom React/CSS console has not
yet migrated; its implementation is not evidence of TiUI compliance. Verify actual package
exports, supported overrides, and rendered behavior before claiming integration.

Capture reusable user corrections and integration findings using
[knowledge maintenance](../docs/standards/knowledge-maintenance.md). Update migration status
with evidence when completing a component migration. Preserve the larger-text/spacing
requirements and check both themes and narrow layouts as specified in the design standard.
