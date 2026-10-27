# ADR 0002: TiUI as the shared frontend foundation

- Status: Accepted
- Date: 2026-10-27
- Scope: UI components, theme ownership, design consistency, and shared agent guidance
- Implementation status: Migration pending

## Context

The owner requested TiUI as the foundation for this independent Workspace. The prototype
instead used custom React/CSS, DM Sans, a red action palette, Lucide icons, and an independent
theme controller. Increasing text size and adding dark mode improved usability but did not
satisfy TiUI adoption. The owner also requires reusable design rules to be available to all
coding agents and future contributors.

Official documentation and the public `@tidbcloud/uikit@2.9.1` distribution are accessible.
The absence of the package in the original empty workspace was not an installation blocker.

## Decision

Use real TiUI components, its root ThemeProvider/stylesheet, typography, icon set, and theme
mechanism. Keep Workspace-specific readability and spacing adjustments in a small shared
configuration/adapter layer, using supported extension APIs. Preserve the independent product
model and customer Workspace Key boundary; sharing a UI foundation does not require reusing
the TiDB Cloud product hierarchy.

The [TiUI standard](../standards/tiui-design-system.md) is the canonical implementation guide.
It separates verified versioned upstream facts, accepted Workspace rules, and migration
status. Root and frontend agent instructions route every tool to it. The
[knowledge-maintenance workflow](../standards/knowledge-maintenance.md) governs future reusable
findings; a tool's private memory is insufficient as the team's source of truth.

## Consequences and migration

Migrate incrementally: dependency/provider and shared theme, foundational controls, domain
forms/tables/cards, navigation and remaining features. Remove superseded global style rules
and the duplicate theme controller as their replacements become active. Preserve the saved
theme preference and existing behavior. Verify peer compatibility and bundle/build behavior
before selecting the exact application dependency version.

The current custom UI remains explicitly labeled as awaiting migration. A scoped PR must
report which components actually migrated and which remain. A styling workaround needs a
specific reason, owner/scope, and removal condition in the canonical standard; routine
supported size/density overrides do not require a new approval ceremony.

## Verification

Inspect actual TiUI imports, provider ownership, shared overrides, and removal of obsolete
styles. Run the shared quality gate and inspect light/dark desktop/narrow layouts, keyboard
behavior, and relevant workflow states. Update the migration table with PR/commit evidence.
Documentation routing checks cannot substitute for dependency, type, or browser verification.
