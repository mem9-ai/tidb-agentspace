# db9 PostgreSQL runtime and recovery

The owner-selected db9 anonymous/free service provides PostgreSQL-compatible resources. It is
independent of TiDB Cloud PG Starter. The accepted [GH-40 specification](../specs/gh-40/spec.md)
and [ADR 0011](decisions/0011-db9-postgres.md) define the boundary.

## Run

Use the pinned runtime and install with `npm ci`, then:

```sh
WORKSPACE_POSTGRES_PROVIDER=db9-anonymous \
  WORKSPACE_MYSQL_PROVIDER=tidb-cloud-zero \
  WORKSPACE_FILES_PROVIDER=drive9-anonymous npm run dev
```

Choose PostgreSQL · db9 in Create database. Anonymous registration needs no user email/card.
The backend uses official REST endpoints and native `pg` 8.23.1; no CLI is installed or required.
`postgresql` is the public kind, `db9-anonymous` its provider, and `automatic` the region request.
The service does not promise a region or database expiry not supplied by the provider. Token
expiry is an internal account concern, not a database lifetime.

Default `WORKSPACE_POSTGRES_PROVIDER=disabled` prevents new PostgreSQL creation. Existing
configured PG bindings remain usable; historical simulated PG is never rebound or exposed.

## Credentials and isolation

The sibling `<state-file>.db9.json` vault contains one anonymous account and resource-scoped
native bindings, with mode 0600. Never commit, log or send it to the Console. Startup rejects
insecure existing vault permissions. It is local prototype credential storage; production
secret management and public identity remain unimplemented.

The provider token handles account/database management. Customer SQL uses a generated native
non-superuser role owning the `workspace` schema; admin credentials are discarded from its
binding after successful setup. Connections require a verified public certificate and an
allowlisted db9 host/port. Public inputs cannot override hosts, credentials or TLS settings.
One Workspace Key can query its selected PG resource and read/write its selected Files; both
actions and resource IDs are enforced before upstream access. Native passwords are never
exported; Connect provides gateway examples with a Workspace Key placeholder.

Queries use fresh sessions, one extended-protocol statement and no automatic retries. Budgets
remain 64 KiB SQL, four concurrent PG queries, 15 seconds including connection, 1,000 rows and
1 MiB retained results. Closing/overflow/timeouts can leave a write outcome unknown; inspect
before retrying. Table browsing is restricted to workspace, lists at most 500 tables/views and
previews 100 unordered rows. It requires queries:execute and the database resource grant.

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
token. Back up state and the vault together; losing them can lose access to an anonymous account.
Reverting code or disabling creation does not erase cloud data. Preserve bindings when rolling
back, and never expose retired simulated PG records as live. See [verification](db9-verification.md).
