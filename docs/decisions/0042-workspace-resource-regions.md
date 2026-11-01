# ADR 0042: Global Workspaces and regional resources

- Status: accepted; single-Region implementation.
- Date: 2026-11-01.

## Decision

A Workspace is a global logical ownership and authorization boundary. Its default Region
identifies the control plane for new resources. Each resource records its owning `regionId`.
The current release admits only the Workspace's existing Region; an explicitly different
`regionId` on creation is rejected. This does not implement multi-Region routing or a way to
change the default. An agent still configures only the Global endpoint and its Key; direct
Region requests and locally renewed sessions follow ADR 0041.

The existing resource `region` is the provider data location, which can be `automatic` or a
provider-specific location. It is not the control-plane `regionId` and does not establish a
data-residency guarantee. Provider availability and existing locations are unchanged.

## Metadata and compatibility

Global's personal Workspace Directory records the existing assignment as `regionId`; newly
created records also store it as `defaultRegionId`. Existing Global records retain their
assignment and are interpreted as having that default. The current single-Region model
requires the regional copy of `defaultRegionId` to match the Region's configured Meta authority.
Region initializes it for new Workspaces and adds it to existing Workspace records using a
version-checked metadata update. A conflicting stored value fails closed. Region never calls
Global on the data path.

New resource records persist `regionId`. Existing records without it are interpreted as owned
by the Region Meta authority that already stores them, independent of provider `region`.
No full inventory scan or provider operation is needed. A normal mutation of such a resource
can persist the inferred field; an explicitly conflicting stored `regionId` fails closed.
The migration preserves resource IDs, provider locations, contents, bindings and credentials.
It does not create replicas or move data. Future multi-Region support needs an explicit global
default-change and placement protocol; the present equality check must be revised then.

## Availability

Previously discovered Region routes and locally enrolled, renewable credentials can continue
reading and writing when Global is unavailable, subject to their established expiry and
revocation policy. A new client without cached Region discovery cannot bootstrap during a
Global outage. A single combined deployment still shares one process failure domain.
