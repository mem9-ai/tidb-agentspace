# Resource page measurement, 2026-10-31

Status: local exploratory measurement, not a production capacity or latency commitment.
The implementation remains incomplete for a million-resource Workspace. See
[ADR 0033](decisions/0033-sparse-scale-metadata.md) and
[the scale assessment](scale-assessment.md) for the outstanding paths.

## Environment and data

- Apple M4, 10 logical CPUs, 24 GiB memory, macOS 27.0.1.
- One local RustFS 1.0.4 instance, an independently running Meta service using the pinned
  SlateDB 0.17.0 and a regional Workspace API. Meta and API used debug builds and communicated
  over loopback; object storage, fixture credentials and all resources were isolated.
- One Workspace received 1,000,000 synthetic, small resource metadata records. The count is
  based on successful atomic batch acknowledgements, not a separate full inventory scan.
  The first 405,000 records were seeded sequentially; the remaining 595,000 were seeded in
  four concurrent 1,000-record batches through the same Meta service and SlateDB writer.
  The parallel phase took 1,269.69 seconds. This is fixture preparation, not a product
  resource-creation throughput measurement. The seed processes used Node 25.2.1 and 24.22.1,
  respectively; the request sampler used Node 24.22.1.
- The measured owner-page implementation was an in-progress debug binary from before the
  final branch commits; its ID-page read path is equivalent to the opt-in path on this branch,
  but the exact measured binary and source tree were not preserved as a reproducible release.
  Repository regression checks were running on the same machine during the measurement.

## Request sample

The client issued 100 successful GET /resources requests with limit 100 and a cursor, with four
concurrent requests. Eighty percent chose a cursor in the first 100 synthetic IDs and twenty
percent were spread over the million IDs. This is a resource-level hot/cold mix inside **one**
Workspace; it is not a model of Tenant activity. The API returned stored resource state and
did not refresh provider status. Each page contained at most 100 resources.

| Observation                  |    Result |
| ---------------------------- | --------: |
| p50                          | 150.15 ms |
| p95                          | 201.45 ms |
| p99                          | 246.41 ms |
| Errors in these 100 requests |         0 |
| Total sample duration        |    3.88 s |

The sample is small, especially for p99, and includes contention from other checks. A separate
diagnostic probe was interrupted when the isolated fixture shut down after the sample; it is
not included in the successful request count. The fixture and its temporary object data were
removed afterward.

## Repeating and interpreting

Run the following command to start a fresh isolated RustFS/SlateDB fixture with the same page
size and hot/cold request shape:

    SCALE_RESOURCES=1000000 SCALE_REQUESTS=100 node scripts/benchmark-resource-pages.mjs

The checked-in harness seeds sequentially, so it does **not** reproduce the mixed
sequential/parallel preparation used for the measurement above. Use the repository's pinned
Node runtime and a prebuilt backend. A rerun must record its own candidate revision,
environment and results rather than copying these numbers.

This sample does not test one million Tenants, live provider creation or deletion, default
Portal/bootstrap, the unpaged list, Workspace-wide resource creation, mixed reads and writes,
authorization under load, cold caches, durable recovery, shard movement, S3 network latency,
storage cost or production p99. It cannot establish that the product supports the requested
scale. At the measured revision, Portal/bootstrap and creation retained the legacy Workspace
view limit and shared coordination gate. Later changes are described in [ADR 0033](decisions/0033-sparse-scale-metadata.md);
the numbers above have not been rerun against those changes.
