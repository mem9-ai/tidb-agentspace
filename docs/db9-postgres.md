# db9 PostgreSQL runtime and recovery

The Rust API uses the private deployment described in the
[Rust runtime guide](rust-backend.md), with record metadata under [ADR 0024](decisions/0024-fresh-record-metadata.md).

The owner-selected db9 anonymous/free service provides PostgreSQL-compatible resources. It is
independent of TiDB Cloud PG Starter. The accepted [GH-40 specification](../specs/gh-40/spec.md)
and [ADR 0011](decisions/0011-db9-postgres.md) define the boundary.

## Run

Set `product.providers.postgresProvider` to `db9-anonymous` in the private regional API
configuration. Optionally enable `mysqlProvider: "tidb-cloud-zero"` and
`filesProvider: "drive9-anonymous"` independently. Start the reviewed native artifact:

```sh
workspace-backend serve --config /absolute/private/regional-api-plan.json
```

Choose PostgreSQL · db9 in Create database. Anonymous registration needs no user email/card.
The backend uses official REST endpoints and its native Rust PostgreSQL driver; no CLI is installed or required.
`postgresql` is the public kind, `db9-anonymous` its provider, and `automatic` the region request.
The service does not promise a region or database expiry not supplied by the provider. Token
expiry is an internal account concern, not a database lifetime.

The default `postgresProvider: "disabled"` prevents new PostgreSQL creation. Existing
configured PG bindings remain usable; historical simulated PG is never rebound or exposed.

## Credentials and isolation

The regional Meta service stores the anonymous account at `credentials/accounts/db9` and
resource-specific bindings/credentials in separate encrypted records. The API never sends these
records to the Console. Private configuration, encryption keys, service credentials and object
storage must be protected and recovered together; see [metadata operations](meta-service.md).
The former owner-only JSON vault exists only in isolated regression fixtures, with no serving
or migration path. Production secret management and public identity remain unimplemented.

The provider token handles account/database management. Customer SQL uses a generated native
non-superuser role owning the `workspace` schema; admin credentials are discarded from its
binding after successful setup. Connections require a verified public certificate and an
allowlisted db9 host/port. Public inputs cannot override hosts, credentials or TLS settings.
One Workspace Key can query its selected PG resource and read/write its selected Files; both
actions and resource IDs are enforced before upstream access. Native passwords are never
exported; Connect provides gateway examples with a Workspace Key placeholder.

The Rust driver prepares one statement to validate it and retain field metadata, then reads
text-protocol results to preserve native numeric/temporal/JSON text. It does not run SQLx's
extra `EXPLAIN`/nullability probes. Completed requests send protocol Terminate; closing errors
do not replace a confirmed result. Internal diagnostics contain only a phase/error category,
with SQL statement logging disabled. A loopback wire fixture checks empty fields, no EXPLAIN
and connection termination without requiring cloud credentials.

Queries use fresh sessions, one statement and no automatic retries. Budgets
remain 64 KiB SQL, four concurrent PG queries, 15 seconds including connection, 1,000 rows and
1 MiB retained results. Closing/overflow/timeouts can leave a write outcome unknown; inspect
before retrying. Table browsing is restricted to workspace, lists at most 500 tables/views and
previews 100 unordered rows. It requires queries:execute and the database resource grant.
The Rust table-description operation reuses one fresh native session for its three generated
metadata statements, sharing the 15-second/1,000-row/1 MiB operation budget. It never reuses a
customer SQL session or returns a partial description. Console database reads also have an
explicit whole-read deadline and retryable error; see [verification](postgres-column-latency-verification.md).

## Provider compatibility

[db9 data types](https://db9.ai/docs/sql/data-types/) document NUMERIC at **28–29 significant
digits**. It can remove digits beyond that range; live testing confirmed this. The gateway
returns native bigint/numeric/temporal/JSON text without JavaScript number/date coercion, but
cannot recover provider-side precision loss. Do not use this provider as an arbitrary-precision
PostgreSQL replacement without checking its documented type/SQL compatibility. Details links
to that reference. Expression index parts without a catalog column identity use an explicit
Expression label. Cross-schema browsing and complete PostgreSQL catalog compatibility are not
claimed. The existing gateway only supports one statement and ephemeral native sessions.

Anonymous accounts currently allow five databases including branches. The product does not
create extra accounts to bypass that quota. Storage/usage/billing are unmeasured here. There is
no account claim, paid upgrade, native credential download or db9 filesystem integration.

## Recovery and rollback

Registration and creation intents are persisted before the request. Concurrent same-resource
requests share the operation. Returned credentials are saved before native setup. A lost
registration response needs operator recovery; no automatic new account is registered.

A database create with an uncertain outcome is never posted again automatically. Setup can
look up the deterministic saved provider name under the same account, recover that exact
instance, and continue native role/schema setup with persisted credentials. If no unique
instance is found, it fails closed. Setup requires resources:write plus the resource grant.
Do not delete the failed binding to make the service send another POST without first examining
the original outcome. Raw provider/native errors stay internal and public errors are structured.

Refresh the anonymous token using the stored anonymous ID/secret when needed for management;
refresh never changes account identity or creates databases. Native user SQL does not use that
token. Preserve the regional object-store metadata and its encryption keys together; losing them can lose access to an anonymous account.
Reverting code or disabling creation does not erase cloud data. Preserve bindings when rolling
back, and never expose retired simulated PG records as live. See [verification](db9-verification.md).
