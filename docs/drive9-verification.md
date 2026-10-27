# Drive9 anonymous File System verification

Verified on 2026-10-27 against the live Singapore anonymous endpoint, using a single dedicated
trial resource. This evidence describes a loopback prototype, not a public deployment.

## Automated and live checks

- `npm run check`: runtime/repository policy, formatting, lint, generated contract, 52 tests,
  TypeScript, and production build. CI remains credential-free.
- `node scripts/verify-drive9.mjs <loopback-origin> <resource-id>`: a scoped Workspace Key
  uploaded Markdown (415 bytes), JSON (50), CSV (64), binary (9), and oversized Markdown
  (165,014). All downloads matched original bytes. The large and binary previews returned
  explanations without editable source; other previews returned the expected UTF-8 text.
- A read-only Workspace Key received 403 on writes and 401 after revocation. Fake-provider
  tests also cover cross-resource/workspace access and expiration before provider requests.
- Restarting the local gateway reused the original internal binding and real tenant.
- Browser file chooser uploaded a Markdown file to the real service. Browser Download
  matched the uploaded bytes. Editing and saving updated the cloud file from 236 to 71 bytes.
  Switching away from an unsaved draft offered Keep editing / Discard changes.
- Existing local File System files remained present and editable.

Generated live examples remain in the trial's verification folder for manual viewing. No
customer secrets, provider tokens, internal tenant IDs, or personal files are in these fixtures
or screenshots. Smoke-test Workspace Keys are revoked in the script's cleanup block.

## Browser checks

TiUI 2.9.1, React 18.3.1. Checked 1280 × 900 and 390 × 844 in Light and Dark, including the
non-modal reading panel, rendered Markdown, lossless large JSON integers, loading states,
large-file fallback, browser upload/download, and save/draft protection. At 390px the reader
has Back to files and no page-wide horizontal overflow. The mode label wraps below the
File System selector so it is not truncated.

| View    | Light                                           | Dark                                           |
| ------- | ----------------------------------------------- | ---------------------------------------------- |
| Desktop | [1280 × 900](screenshots/drive9-light-1280.png) | [1280 × 900](screenshots/drive9-dark-1280.png) |
| Narrow  | [390 × 844](screenshots/drive9-light-390.png)   | [390 × 844](screenshots/drive9-dark-390.png)   |

[Large-file fallback](screenshots/drive9-large-file.png) keeps the original-byte Download
available and disables Edit source when content has not been loaded.

## Limits

Uploads are currently bounded at the smaller of 1 MiB and the service's negotiated limits.
Automatic text previews are bounded at 128 KiB plus renderer budgets. Binary files are
available for download, without image/PDF rendering. Multipart, redirects, and extent-backed
files are not supported by this first adapter. Database provisioning/SQL and chart telemetry
remain simulated. Trial storage quota, total usage, and billing are unmeasured rather than
reported as zero. See [ADR 0004](decisions/0004-drive9-anonymous-provider.md).
