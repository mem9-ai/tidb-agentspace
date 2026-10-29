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

## Upload progress and recovery (GH-99)

Owner correction, implemented 2026-10-29 on base `6d124ece96790d08dbcb06036b798fda0fb2f63d`.
The File System entry is Upload; Import remains the parsed database-ingestion operation.
`use-file-upload.ts` owns a persistent file/path status, and `FileUploadStatus` uses TiUI
Paper, Loader and Progress. The generated API client still owns routes, raw/JSON serialization,
credentials and structured errors; its upload transport uses real XMLHttpRequest upload
events, a bounded 120-second acknowledgement timeout and no automatic retry. The percentage
describes request transfer to the Workspace API, not upstream Drive9 persistence. Unknown
length and the subsequent Saving phase expose indeterminate progress without `aria-valuenow`;
only an acknowledged write produces Upload complete. Post-write refresh errors retain success
and explain recovery. Local-demo text uploads use the same feedback and retain existing limits.

Transport regression tests verify exact binary bytes, generated/encoded paths, cookies,
conditional-create headers, actual progress versus acknowledgement, unknown/zero lengths,
403/409/413/502 structured errors, network/timeout failure, cancellation and no automatic retry.
Collision-code presentation retains other service errors. No API, backend, provider credentials,
dependencies or transfer limits changed.

Browser checks used an isolated fixture on a hostname separate from the active preview.
An ignored verification proxy delayed acknowledgement by 18 seconds; production code has no
artificial delay or timer-based percentage. Both Light/Dark were checked at 1280×800 and
390×844: a progress bar remains visible while saving, Upload/resource actions stay disabled,
completion re-enables them, unknown save progress has no numeric ARIA value, and narrow page
width remains 390px. Browser tests also checked preflight size rejection, a network disconnect,
structured service rejection, acknowledged-write/failed-refresh recovery and local text upload.
Intermediate 50% progress and timeout/cancel behavior are covered by the transport tests;
loopback transfers were too fast to retain a useful intermediate-percentage screenshot.

Live browser proof used the existing Singapore anonymous trial and generated files in
`/upload-verification-1793269965383/`, without provisioning a resource or exposing credentials.
The 147-byte Markdown uploaded, rendered and downloaded byte-for-byte. A same-name upload
was rejected by conditional create. A 614,400-byte binary also uploaded and downloaded with
identical original bytes. SHA-256 checksums were respectively
`438bad01e2d651d40ee984f7e7fe322fd425b7b32510229a048af7efa3f360a9` and
`3c7e7ecba97572f06d6792084bf56a8b2e428534e1e36f0bdf009facfac29512`. These generated files remain available for manual inspection.
The later live proof does not change the historical capability claims above.

Screenshots:

- [Saving, Dark desktop](screenshots/upload-status/saving-dark-1280.png)
- [Saving, Light desktop](screenshots/upload-status/saving-light-1280.png)
- [Saving, Dark narrow](screenshots/upload-status/saving-dark-390.png)
- [Saving, Light narrow](screenshots/upload-status/saving-light-390.png)
- [Network failure, Dark narrow](screenshots/upload-status/network-error-dark-390.png)
- [Live upload and Markdown preview](screenshots/upload-status/live-markdown-dark-1280.png)

The PR records the final complete quality gate, exact head, remote CI and local preview handoff.
Multipart/resume, provider-side progress and bulk uploads remain outside this change.
