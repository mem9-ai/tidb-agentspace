import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../server/store.mjs';
import { executeNativeSql } from '../server/providers/sql-drivers.mjs';
import { sqlLimits, starterProvider, validateBinding } from '../server/providers/starter-sql.mjs';

// Operator-only, offline configuration: no provider credentials are accepted by the public API.
// Stop the local server before binding so its in-memory resource state cannot overwrite this update.
export async function bindStarter({
  dataFile,
  resourceId,
  connectionFile,
  execute = executeNativeSql,
}) {
  const info = await stat(connectionFile);
  if (info.mode & 0o077) throw new Error('The internal connection file must have mode 0600.');
  const store = await createStore(dataFile);
  const resource = store.read().resources.find((r) => r.id === resourceId);
  if (!resource || resource.kind === 'filesystem')
    throw new Error('Choose an existing database resource.');
  const binding = validateBinding(JSON.parse(await readFile(connectionFile, 'utf8')), resource);
  const query = (sql) => execute(binding, sql, { limits: sqlLimits });
  await query('SELECT 1 AS connected');
  if (binding.kind === 'mysql') {
    const grants = await query('SHOW GRANTS FOR CURRENT_USER');
    const allowedTarget = '`' + binding.database + '`.*';
    const restricted =
      grants.rows.length > 0 &&
      grants.rows.every((row) => {
        const grant = Object.values(row)[0];
        if (typeof grant !== 'string' || /WITH GRANT OPTION/i.test(grant)) return false;
        const match = /^GRANT (.+) ON (.+) TO /i.exec(grant);
        return (
          match && ((match[1] === 'USAGE' && match[2] === '*.*') || match[2] === allowedTarget)
        );
      });
    if (!restricted)
      throw new Error(
        'Use a MySQL SQL user granted only this workspace database, without global or grant-option privileges.',
      );
  } else {
    const roles = await query(
      "SELECT COUNT(*) AS unsafe_roles FROM pg_roles WHERE (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR rolname IN ('pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program', 'pg_read_all_data', 'pg_write_all_data', 'pg_monitor', 'pg_read_all_stats', 'pg_signal_backend')) AND pg_has_role(current_user, oid, 'MEMBER')",
    );
    if (String(roles.rows[0]?.unsafe_roles) !== '0')
      throw new Error('Use a PostgreSQL role without membership in privileged roles.');
  }
  const vault = await createStore(dataFile + '.databases.json', () => ({ bindings: {} }));
  await vault.mutate((draft) => {
    draft.bindings[resourceId] = binding;
  });
  await store.mutate((draft) => {
    const target = draft.resources.find((r) => r.id === resourceId);
    target.provider = starterProvider;
    target.status = 'active';
  });
  return { resourceId, kind: resource.kind };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dataFile, resourceId, connectionFile] = process.argv.slice(2);
  if (!dataFile || !resourceId || !connectionFile) {
    console.error(
      'Usage: node scripts/bind-starter.mjs <workspace-data-file> <resource-id> <private-connection-json>',
    );
    process.exitCode = 1;
  } else {
    try {
      const result = await bindStarter({ dataFile, resourceId, connectionFile });
      console.log(`Bound ${result.resourceId} (${result.kind}). Restart the local server.`);
    } catch (error) {
      // All native errors are sanitized by the adapter; JSON/file errors may contain sensitive input.
      console.error(
        error.code?.startsWith('SQL_')
          ? error.message
          : 'Binding failed. Check private file permissions, connection fields, resource kind/region, and least-privilege database grants.',
      );
      process.exitCode = 1;
    }
  }
}
