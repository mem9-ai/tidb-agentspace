# AgentSpace with Raft

The optional Raft mode gives Humans and Agents distinct verified identities and exact resource
access. It needs a registered App, explicit server configuration and a matching HTTPS deployment.
Code and local test success do not establish that a particular hosted installation is enabled.
The [Global OpenAPI](../public/global-openapi.json) is the complete ordinary API contract;
the [design decision](decisions/0062-federated-raft-access.md) explains its security boundaries.

## Human setup and first saved file

1. Open the deployed Console's `/raft` page and choose **Sign in with Raft**.
2. Create an empty Workspace explicitly. Login and admission create no default resources.
3. Create a File System, enter a relative file path and content, then choose **Create file**.
   Local storage is labeled. Cloud/provider creation uses the service's configured adapter;
   it is not a new delegated TiDB Cloud connection.
4. An Agent signs into the registered App and invokes `context`. Copy its returned identity ID
   to **Identity ID from the agent’s context action**. Review the verified kind, subject and
   Server before approving membership. An ordinary admission request can also be approved.
5. Choose **Share resources**, review the member and exact resources, select actions and expiry,
   then confirm. Approval alone grants no data access. New tag matches are never included.
6. Inspect the resource's grants to revoke a particular path, or remove membership to stop all
   its interactive access. Removing one grant leaves other live grants in effect. Data remains.

Management requires a Human sign-in within ten minutes. A stale policy or tag revision is 412;
reload and review the current state before retrying. Do not treat an upstream outage as an empty
list. The Console keeps SQL request identities across reload and preserves unsaved text on errors.
Membership reinstatement and independent application credentials are not available in this flow.
Resource deletion, custom file analysis and usage reporting are also unavailable through this
adapter. Its resource views omit native-only capabilities, and grants reject unsupported actions.

## Agent use

Use the exact registered client key supplied by the service operator. Discover actions before
invoking them; the following names apply to this manifest, not arbitrary Apps.

```sh
raft integration login --service <client-key> --target <current-conversation>
raft integration invoke --service <client-key> --list-actions
raft integration invoke --service <client-key> --action context
```

A stored login cookie is not sufficient evidence of application login. Verify the context's
actor kind, Server and admission state. If admission is required, give the Human your own returned
identity ID. Do not request another identity's credentials or copy a Human browser session.

After explicit admission and sharing:

```sh
raft integration invoke --service <client-key> --action list-resources --param workspaceId=<id>
raft integration invoke --service <client-key> --action read-file \
  --param workspaceId=<id> --param resourceId=<id> --param path=note.txt
```

`tags` is a JSON object of exact string key/value filters, combined with AND. It only filters
resources you may already discover. Pages contain no hidden totals. Retain the returned cursor;
a changed filter or policy requires restarting pagination. A page can be empty with a next cursor.

Before any SQL submission, generate and retain a request UUID. Send a JSON file containing
`workspaceId`, `resourceId`, `requestId` and `sql` using the public CLI's `--data-file` option.
Do not place credentials in that file. The same ID/content cannot execute twice; a changed
request under that ID returns 409.

```sh
raft integration invoke --service <client-key> --action query --data-file <private-request.json>
raft integration invoke --service <client-key> --action query-status \
  --param workspaceId=<id> --param resourceId=<id> --param requestId=<original-uuid>
```

After transport failure, use query-status with the original key. `running` is not success;
`outcomeUnknown` means the provider may have accepted the SQL. Do not submit a new ID as a retry,
and do not claim rollback or exactly-once execution. Status/results require current rights and
belong to the verified caller. Missing records never authorize replay. The service retains
request identities and bounded results without expiry; there is no replay-enabling cleanup.

SQL is limited to 64 KiB, one statement, 15 seconds, 1,000 rows and 1 MiB of results. Read-only
permissions use the native provider's read-only enforcement. Nonempty bound-parameter arrays are
currently rejected; do not interpolate untrusted values into SQL. Text reads are at most 128 KiB,
text writes 64 KiB. Paths are relative and reject traversal/backslashes/control characters.
File replacement requires the actual current revision. A provider without revisions does not
receive fabricated ones, and the Console cannot perform an unchecked replacement.

## Operator configuration

Configure the existing Global and Region services; no additional proxy service is required.
Global's optional `raft` object contains:

```json
{
  "issuer": "https://api.raft.build",
  "clientId": "your-registered-client-key",
  "clientSecretFile": "/private/secrets/agentspace-raft-client",
  "redirectUri": "https://agentspace.example/api/global/auth/raft/callback",
  "postLoginUrl": "https://agentspace.example/raft",
  "allowedServerIds": ["11111111-1111-4111-8111-111111111111"]
}
```

This is a configuration fragment with placeholders, not a registered/deployed App. Set the
exact registered callback using Global's configured `publicOrigin` and `publicPath`. Use a
private credential file with the existing native file permissions; never put its contents in
chat, source, the Console config, manifest, command-line arguments or logs.

Region's `security.raft` uses the same issuer, client ID and explicit allowed Server IDs, without
`clientSecretFile`, callback or landing URL. Region needs the existing authenticated Global
control connection and a configured data endpoint reachable by Global. Backend requests use
only that configured endpoint, with redirects disabled. Browser cookies stay on the App origin.
Raft mutating requests reject other Origins even if trusted for legacy Console operations.

Production uses HTTPS and the existing trusted clocks/writer/floor configuration.
Operators must keep each authority clock within five seconds of UTC. Proofs use a 50-second
window to reserve both clock errors within the 60-second admission bound. Local clock checks
detect rollback/health failures; they do not establish NTP synchronization. Fixture HTTP
is loopback-only and requires explicit test configuration. Do not enable it on a remote host.
Each Workspace has one serving Region; active-active serving is outside this implementation.

For a Global mounted at `/api/global`, register the manifest at
`https://agentspace.example/api/global/.well-known/raft-agent-manifest.json`. Its execution base
is the bare origin and action paths contain the complete mount. The public manifest contains
only contracts. This does not replace another application's root-origin manifest.

App registration uses Raft's Human-commit registration card. Source ownership, installation,
login consent and AgentSpace membership/resource grants are separate. Request only `openid`
and `profile`; this integration does not require a Raft Agent directory permission. Deliver
App credentials only through the supported private handoff/store, and retain the App's exact
client key. Registration/installation alone does not enable the backend configuration.

## Acceptance before enabling a hosted installation

Use a fresh released Raft CLI and a fresh Human browser session against the registered HTTPS
callback. Verify both context identities, explicit admission, real file/SQL results, exact
read/write separation, local logout, grant removal, upstream refusal/outage and restart.
Exercise real App disable/uninstall and identity restoration through public interfaces; a
provider fixture does not prove those remote behaviors. Record the served API/Console revisions
and actual target. No automatic conversion or credential rotation of existing tenants is part
of this setup. New Cloud delegation, attachment and application secrets require separate
provider contracts and acceptance before being advertised or enabled.
