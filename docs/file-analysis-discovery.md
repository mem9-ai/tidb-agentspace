# File System analysis: capability discovery

Implementation update: the owner approved the GH-26 baseline. Read-only Console/API analysis
now uses backend-managed selected-file snapshots; see [ADR 0010](decisions/0010-read-only-file-analysis.md)
and [implementation verification](file-analysis-verification.md). The provider capability findings
below describe the original discovery and do not imply that hosted Exec became available.

- Verified: 2026-10-28 (Asia/Shanghai).
- Intent: [GH-26](https://github.com/siddontang/tidb.ai/issues/26).
- Status: Live capability proof complete. The Console analysis view, Workspace analysis API,
  worker isolation and analysis permissions are not implemented by this discovery change.
- Proposed acceptance baseline: [GH-26 specification](../specs/gh-26/spec.md).

The [GH-34 standalone DuckDB file-source experiment](deprecated/duckdb-databases.md#workspace-file-sources) is retired. Current File System analysis uses the [native snapshot worker](decisions/0021-native-rust-computation.md) and [file grants](decisions/0010-read-only-file-analysis.md).

## Findings

| Capability         | Source support                                                                                              | Current Singapore anonymous service                                                                       | Product implication                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Remote Exec        | Drive9 clients document `GET /v1/runtime/capabilities`, streaming `POST /v1/runtime/exec`, and cancellation | Both capability discovery and a bounded, read-only `duckdb --version` execution request returned HTTP 404 | No remote sandbox or DuckDB installation was confirmed. Do not depend on hosted Exec for this provider/mode. |
| Just Bash          | `drive9/just-bash` exports `Drive9Fs`, implementing the interpreter's filesystem interface over HTTP        | Real listing, `grep -n ERROR service.log \| head -20`, and `grep ERROR service.log \| wc -l` passed       | The Workspace backend can host the interpreter independently of provider Exec.                               |
| DuckDB CSV/Parquet | The native `tidbfs` extension in `drive9-ai/duckdb` accesses the data plane through HTTP                    | DuckDB 2.0.0 queried both real remote formats and returned the expected aggregates                        | A separate analysis worker can use durable remote files without provider Exec or Ti CLI.                     |

An SDK method or source document does not establish that every deployment exposes its server
route. HTTP 404 describes the checked endpoints/provider/date; it does not prove the whole
Drive9 product lacks Exec or that every other region/mode has the same availability. No
anonymous-trial compute quota or price was inferred.

Just Bash interprets supported shell commands; it is not an operating-system shell that can
launch arbitrary native binaries. It does not itself supply DuckDB. The intended feature uses
two execution engines behind a common Workspace authorization boundary.

## Live evidence

The existing real Singapore File System was reused; no new tenant, database or subscription
was created. Three task-owned files remain in `/file-analysis-demo-9de2ebb1/` for inspection:

- `orders.csv`: four rows with id, region and amount.
- `orders.parquet`: the same dataset in Parquet format.
- `service.log`: four log lines, two containing ERROR.

For each analytical format, the independently expected result was APAC = 30 and EU = 20:

```sql
SELECT region, SUM(amount)::INT AS total
FROM read_parquet('tidbfs:///file-analysis-demo-9de2ebb1/orders.parquet')
GROUP BY region ORDER BY region;
```

Replacing `read_parquet` with `read_csv_auto` and the path with `orders.csv` returned the same
values. These were fresh native DuckDB processes reading the real service, not mock results.
The small fixtures establish connectivity and query correctness, not large-file performance
or Parquet row-group pruning. The native proof used a temporary backend-held secret; SQL
containing that secret was supplied over stdin, not arguments or committed files.

Just Bash 3.6.0 mounted the task directory with `Drive9Fs({ readOnly: true })`. It reported
exactly two matching log lines (2 and 4) and count 2. A write attempt was denied, and the target
file remained absent. No provider credential was available as a shell variable. This validates
the adapter's read-only mode; it does not by itself establish future selected-file confinement,
public multi-tenant worker isolation, or a server-issued read-only token.

[Sanitized observed results](evidence/file-analysis-2026-10-28.json) retain no credential,
tenant ID, claim link, or private local machine path. Files uploaded for the proof used the
existing Workspace API and conditional-create behavior. Local temporary analytical files were
removed; the three remote examples were intentionally retained.

## Sources and compatibility

- Drive9 checkout source `018389c81ac037c83e9311a6608ffd6cd35aa57d`:
  [runtime guide](https://github.com/mem9-ai/drive9/blob/018389c81ac037c83e9311a6608ffd6cd35aa57d/docs/guides/runtime-exec.md),
  [runtime API client](https://github.com/mem9-ai/drive9/blob/018389c81ac037c83e9311a6608ffd6cd35aa57d/clients/drive9-js/src/runtime.ts),
  and [Just Bash integration](https://github.com/mem9-ai/drive9/blob/018389c81ac037c83e9311a6608ffd6cd35aa57d/docs/guides/just-bash-integration.md).
- [Just Bash](https://github.com/vercel-labs/just-bash), tested installed version 3.6.0;
  the Drive9 integration documents Node >=20.19 and the optional SDK entry point.
- [Drive9 DuckDB extension](https://github.com/drive9-ai/duckdb), tested local native artifact
  against DuckDB 2.0.0 on macOS arm64. Its pinned C++ SDK revision is
  `42a316a20a71d3d7b789053ed020b45ba633aedc`.

The live proof used the SDK built from its checkout. On the verification date, npm metadata
for `drive9@0.3.0` exported only the package root, not `./just-bash`. Do not assume that
installing the source package's version string supplies this entry point. Verify a published
compatible release or a reproducible pinned source build before using that adapter as a
dependency. A selected-file snapshot runner can instead reuse the existing backend file
adapter and supply an in-memory filesystem to Just Bash.

The system DuckDB was 1.4.2 and rejected the extension's 2.0.0 ABI. An existing matching 2.0.0
binary was reused successfully. Pin and verify the engine/extension/platform combination;
do not silently load an incompatible artifact. The extension is not available through
`INSTALL tidbfs` from a published community repository. Native C++ builds are not browser
WebAssembly artifacts. No community submission or monitoring was resumed.

## Recommended implementation boundary

Keep analysis under File System, with the selected file visible throughout. CSV/Parquet gain
an Analyze with DuckDB action, schema/sample and editable SELECT results. Logs/text gain a
Just Bash view with bounded stdout, stderr, exit status and useful command samples. Use the
existing TiUI components and SQL editor, themes, typography and file side-panel conventions.

The first implementation should be read-only and independent of hosted Exec. Run compute in
bounded backend workers; retain the Workspace Key, resource and internal-credential boundaries.
For a bounded initial release, fetch only the selected file into a private snapshot and expose
that snapshot to the engine, with no provider credential or other files in the guest. This
avoids granting arbitrary guest SQL access to the provider secret. Larger remote scans through
the native connector need a separately verified constrained access path and permission tests.

Never execute user commands through the host Bash or Ti CLI. Just Bash's default runtime
protections and read-only adapter behavior complement process/worker isolation; they do not
replace backend authorization or resource limits. The SDK adapter buffers file reads and does
not propagate cancellation to every HTTP request, so a shell timeout alone cannot establish
memory bounds or immediate upstream cancellation. Check file size before fetching, enforce
stream/time/output limits during work, and keep Download available for unsupported/large files.

Reprobe runtime availability before choosing hosted execution in a future deployment. Recheck
SDK exports, exact package/ABI versions, guest confinement, network/file restrictions and
provider read behavior during implementation. The proof is not permission to expose a generic
remote terminal or to forward the provider owner token into a customer-controlled runtime.

Repository validation after synchronizing the database-browser main branch passed
`npm run check`: 74 tests, runtime/repository rules, formatting, lint, generated OpenAPI/client,
strict types and both independent production builds. Existing dependency eval and bundle-size
warnings remain. This documentation change adds no public analysis API or UI to browser-test.
