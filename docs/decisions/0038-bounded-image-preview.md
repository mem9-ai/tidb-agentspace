# 0038: Bounded raster image previews

- Status: Accepted owner direction, implementation in this change.
- Scope: File System preview response and Console rendering; extends [ADR 0004](0004-drive9-anonymous-provider.md).

## Decision

The existing `files:read` authorized `GET /files/content?preview=1` response may contain an
`image` with `mimeType` and `base64` instead of text content. PNG, JPEG, GIF and WebP are
recognized by case-insensitive extension and checked against their byte signature. The server
checks provider metadata before fetching and bounds the actual read again, to 1 MiB. A file
that exceeds the budget or fails its signature check returns `unavailableReason` and its size.
Text previews retain their 128 KiB budget and existing response. SVG remains inert source.

The Console renders the authenticated response inline, does not expose provider credentials or
load an upstream URL, and never treats image bytes as editable text. Invalid, unsupported or
oversized files retain the original Export action. Browser decode failures have the same fallback.
The local text-only provider is unchanged. Upload and download limits are unchanged.

## Consequences and verification

The additive response field is documented in OpenAPI. Older clients can continue to use
existing text and download paths, but clients expecting every non-text file to produce an
`unavailableReason` should tolerate the new image variant. Deploy the API before the new
Console to provide image previews; an older API continues to report images unavailable.
No permission, storage, or credential migration is required. Rollback restores download-only
image behavior. Test authorized access, signature validation, the exact byte boundary and
metadata preflight, and the Console's rendered and fallback states in supported themes and
viewports. Compressed size does not bound decoded pixels or animation frames; review resource
budgets and image parsing before increasing the upload or preview limits.
