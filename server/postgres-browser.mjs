import { sqlError } from './providers/sql-common.mjs';
import { tableName } from './database-identifiers.mjs';
const literal = (value) => "E'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
export const postgresTableQuery = (name) =>
  `SELECT * FROM "workspace"."${tableName(name).replaceAll('"', '""')}" LIMIT 100;`;
const select =
  "SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_catalog = current_database() AND table_schema = 'workspace'";
export async function browsePostgres({ resource, action, name, execute }) {
  if (resource.provider !== 'db9-anonymous')
    throw sqlError(503, 'DATABASE_NOT_CONFIGURED', 'This PostgreSQL resource is not configured.');
  if (resource.status !== 'active')
    throw sqlError(409, 'DATABASE_UNAVAILABLE', 'PostgreSQL is not active.');
  if (action === 'tables') {
    const data = (await execute(`${select} ORDER BY table_name LIMIT 501`)).rows;
    return { data: data.slice(0, 500), truncated: data.length > 500, mode: 'live' };
  }
  name = tableName(name);
  const table = (await execute(`${select} AND table_name = ${literal(name)} LIMIT 1`)).rows[0];
  if (!table)
    throw sqlError(
      404,
      'TABLE_NOT_FOUND',
      'This table is no longer available. Refresh the table list.',
    );
  if (action === 'rows') return execute(postgresTableQuery(name));
  const columns = (
    await execute(
      `SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS "defaultValue", ordinal_position AS position FROM information_schema.columns WHERE table_catalog = current_database() AND table_schema = 'workspace' AND table_name = ${literal(name)} ORDER BY ordinal_position`,
    )
  ).rows;
  const parts = (
    await execute(
      `SELECT i.relname AS name, x.indisunique AS "uniqueValue", x.indisprimary AS "primaryValue", x.indkey::text AS "positionKeys" FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class t ON t.oid = x.indrelid JOIN pg_catalog.pg_namespace s ON s.oid = t.relnamespace JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid WHERE s.nspname = 'workspace' AND t.relname = ${literal(name)} ORDER BY i.relname`,
    )
  ).rows;
  const positions = new Map(columns.map((c) => [Number(c.position), c.name]));
  const indexColumns = (part) => {
    const keys = Array.isArray(part.positionKeys)
      ? part.positionKeys
      : String(part.positionKeys).trim().split(/\s+/).map(Number);
    if (!keys.length || keys.some((key) => !Number.isInteger(Number(key)) || Number(key) < 0))
      throw sqlError(502, 'INVALID_METADATA', 'PostgreSQL returned unsupported index metadata.');
    return keys.map((key, index) => ({
      name: positions.get(Number(key)) || `Expression ${index + 1}`,
      position: index + 1,
      prefixLength: null,
    }));
  };
  const indexedParts = parts.map((part) => ({ ...part, columns: indexColumns(part) }));
  const primary = new Set(
    indexedParts
      .filter((part) => part.primaryValue)
      .flatMap((part) => part.columns.map((column) => column.name)),
  );
  const unique = new Set(
    indexedParts
      .filter((part) => part.uniqueValue)
      .flatMap((part) => part.columns.map((column) => column.name)),
  );
  const indexes = indexedParts.map((part) => ({
    name: part.name,
    unique: part.uniqueValue === true,
    columns: part.columns,
  }));
  return {
    ...table,
    columns: columns.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable === 'YES',
      default: c.defaultValue == null ? null : String(c.defaultValue),
      key: primary.has(c.name) ? 'PRI' : unique.has(c.name) ? 'UNI' : '',
      extra: '',
    })),
    indexes,
    query: postgresTableQuery(name),
    mode: 'live',
  };
}
