# ADR 0055: Unified 48-hour trial

Status: accepted owner direction, 2026-11-06.

## Decision

New browser Guest sessions and private agent CSV Workspaces last 48 hours from creation, matching the public agent report trial. Global enrollment, regional policy validation, browser cookies, Workspace authorization, Keys and cleanup all use the saved absolute deadline. Returning, switching agents or reissuing a credential never restarts that clock. Public report read grants retain their existing 48-hour boundary.

The signed-out page shows the same trial text in both paths. Account continuation uses “Continue with TiDB Cloud” and aligns to the right below the two choices. Trial notices and the downloadable skill describe the same duration.

## Compatibility and rollout

Previously issued 24-hour sessions keep their original creation and expiry timestamps. Readers accept exactly the legacy 24-hour or current 48-hour window; arbitrary durations, expired sessions and cross-Workspace credentials remain denied. Onboarding carries the recorded creation timestamp instead of reconstructing it using the current duration. No stored credential or cleanup deadline is rewritten.

Deploy all enforcing services together; the current hosted composition uses one native image. Older binaries reject 48-hour policies, so downgrading after new sessions have been issued requires compatible readers. Update the Console and skill with the native rollout. No billing, claim, permissions or provider retention policy changes.

## Verification

Native tests assert new 48-hour registration and cookie expiry, capped Keys, unchanged legacy deadlines, boundary rejection and isolation. Existing cleanup, revocation and restart cases remain applicable. Browser assertions check equal trial wording, account continuation, right alignment and responsive layouts in both themes.
