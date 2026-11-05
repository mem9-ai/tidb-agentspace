# ADR 0051: Guest Workspace entry and File System setup

Accepted for the bundled Studio. The browser can initialize its view and prepare the default
File System concurrently after enrollment.

The bundled auth configuration returns the Workspace ID from the authenticated session or
null for a signed-out browser. Older hosts can omit the field, and distributed Console entry
still performs the regional ticket exchange. Product operations authorize independently.

Only a newly issued Guest cookie can carry an `initialFileSystemRegion` hint in the enrollment
response. The Console can immediately send the same owner-only, idempotent `onlyIfNew` request
specified by [ADR 0047](0047-default-file-system.md). Resumed sessions discover their actual
resources first. The creation receipt updates the loaded Workspace even if the snapshot finished
later. Conflicts, deletions and uncertain writes require authoritative observation. A provider
error must remain visible. Enrollment alone creates no provider resource.

On first entry a new Guest has no prior sample or tutorial to resume. Returning to Overview
checks progress again. Opening a known active File System reads its directory. An acknowledged
text write can update a complete directory and open its text in the editor. A partial or unsettled
directory needs a new listing. Live file counts are folder-local. Local usage and billing data
come from the usage endpoint.

Browser acceptance holds the initial snapshot open, confirms provisioning can complete first,
then checks the requests through creating and editing a file. Native Guest acceptance covers
authenticated discovery, fresh versus resumed entry, and isolation. These checks measure
request dependencies separately from provider response times.
