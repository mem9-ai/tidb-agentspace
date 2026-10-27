# ADR 0003: File System regions and provider modes

- Status: Accepted
- Date: 2026-10-27
- Scope: File System defaults, additive regional API support, and provider evidence
- Implementation status: Singapore is the local demo default; no hosted provider is connected.

## Context and verified evidence

The owner identified Singapore as the Drive9 quick-start region. The Console originally
offered only Oregon and its region label helper treated every non-Virginia code as Oregon.

The live [Drive9 region manifest](https://drive9.ai/manifest/regions/drive9-regions.json), read
on 2026-10-27, defaults to `aws-ap-southeast-1` with mode `tidb_cloud_starter` and endpoint
`https://api.drive9.ai`. Drive9's CLI normalizes that legacy mode name to `anonymous`.
Its fallback manifest also selects Singapore/Anonymous. The same live manifest separately
lists Singapore `tidb_cloud_native` at `https://aws-ap-southeast-1.drive9.ai` and Virginia
`tidb_cloud_native` at `https://aws-us-east-1.drive9.ai`.

Source evidence: `mem9-ai/drive9`, `cmd/drive9/cli/region.go` (fallback manifest and mode
normalization) and `cmd/drive9/cli/db.go` (mode constants). The inspected region implementation
was last changed by commit `18ed73ca883913d1a4b89fccc3998f2d88a28e4b`.
[Drive9's security documentation](https://drive9.ai/security) describes Anonymous as a
Drive9-hosted evaluation workspace without customer TiDB Cloud credentials, and TiDBCloud
as an account-bound mode. A region is a location; it is not a plan or a credential mode.

The [TiDB Cloud Filesystem region list](https://docs.pingcap.com/tidbcloud-filesystem/filesystem-regions-and-limitations/)
also includes AWS Singapore and Oregon. Its [free-tier limits](https://docs.pingcap.com/tidbcloud-filesystem/manage-filesystem-limits/)
apply per region: one file system, 2 GiB, 2,000 files, and a 500 MiB single-file limit for
organizations without a credit card. These are distinct from Drive9 source-code defaults
or Anonymous-mode runtime quotas. Do not infer an anonymous tenant's actual quota from the
region manifest or copy one provider/mode's limits into another.

## Decision

- Add `aws-ap-southeast-1` to this demo's File System regions and place it first, making it
  the default for the Console's create form and new seeded workspaces. Keep Oregon available.
- Continue requiring an explicit region in resource-creation requests. The first entry in
  each resource kind's `capabilities.regions` is the Console default. Derive OpenAPI's region
  enum from those capabilities; backend validation remains specific to the resource kind.
- Use explicit labels for configured regions and show an unknown code unchanged rather than
  silently labeling it Oregon. Do not imply MySQL/PG support from File System availability.
- Keep existing resource regions, file contents, keys, and IDs unchanged. Changing a default
  is not migration; the local demo does not implement relocation of a provisioned resource.
- Retain current demo quotas and local text-file limits. A hosted adapter must select an
  explicit provider, region, and mode, read its actual capabilities/quotas, and keep upstream
  credentials inside the service under [ADR 0001](0001-unified-workspace-key.md).

## Consequences and verification

The public region enum gains Singapore without removing existing values. Existing clients
and persisted Oregon workspaces continue working. A fresh demo starts in Singapore; an older
workspace can create a separate Singapore file system using the default selection.

Tests cover fresh defaults, persistence without relocation, Singapore/Oregon creation,
per-region free-tier conflicts, resource-specific rejection, generated-contract alignment,
and unknown-region labels. Browser verification checks creation defaults, both region labels,
and conflict messages in light/dark desktop/narrow layouts. Revisit the snapshot when the
Drive9 manifest changes or a real provider adapter is introduced; do not fetch an unvalidated
remote manifest into the frontend or turn a default change into silent data migration.

Verification on 2026-10-27: `npm run check` passed with 47 tests. Browser checks at
1280 × 900 and 390 × 844 in both themes confirmed Singapore is selected when switching
the form to File System, Oregon remains selectable, an existing Oregon resource blocks a
duplicate only in Oregon, and creating a separate Singapore resource succeeds with its own
empty file list and correct label. All creation checks used an isolated local fixture.
TiUI 2.9.1 NativeSelect/Modal/Alert and existing shared overrides are unchanged.

| Viewport   | Light                                                 | Dark                                                 |
| ---------- | ----------------------------------------------------- | ---------------------------------------------------- |
| 1280 × 900 | [Desktop](../screenshots/files-region-light-1280.png) | [Desktop](../screenshots/files-region-dark-1280.png) |
| 390 × 844  | [Narrow](../screenshots/files-region-light-390.png)   | [Narrow](../screenshots/files-region-dark-390.png)   |
