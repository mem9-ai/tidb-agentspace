# Workspace Key resource types

Accepted. The default Key targets selected public resource IDs. Owners can instead grant the database family, the file system family, or both. A type grant includes matching resources created later in the same Workspace. It never grants an action on its own. Creating resources still requires workspace-wide access and the resource creation scope.

Global accepts exactly one selection in a Key creation request: a nonempty `resourceIds` list (including the existing standalone wildcard), or `resourceTypes` containing `database`, `filesystem`, or both. Global signs the immutable grant and Region evaluates it against stored public resource records at request time. A database grant currently matches public db9 PostgreSQL databases. File analysis storage and retired providers stay private.

Type-filtered resource lists read a bounded Meta page and recheck each record. Their continuation can point past a hidden resource, so Region encrypts it with a Workspace-specific key in Meta and binds it to the caller. Exact-name lookup uses the existing Workspace name index.

Existing grants omit the new field when serialized. Their references, policy signatures, explicit IDs and wildcard semantics survive without a rewrite. Renewal intersects the two grant snapshots. An ID grant and a type grant have no provable overlap without a resource record, so that intersection is denied.
