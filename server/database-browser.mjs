import { browseDuckdb } from './duckdb-browser.mjs';
import { sqlError } from './providers/sql-common.mjs';

import { tableName } from './database-identifiers.mjs';
export { tableName } from './database-identifiers.mjs';
export function tableQuery(name) {
  return `SELECT * FROM \`${tableName(name).replaceAll('`', '``')}\` LIMIT 100;`;
}
const mode = (resource) => (resource.provider === 'tidb-cloud-zero' ? 'live' : 'demo');
const tableSelect =
  'SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()';
// Hex literals are independent of SQL escaping modes. Names are values here, identifiers in SELECT.
const nameFilter = (name) =>
  ` AND TABLE_NAME = CONVERT(X'${Buffer.from(name).toString('hex')}' USING utf8mb4)`;
const tables = [{ name: 'agent_events', type: 'BASE TABLE' }];
export const demoColumns = ['id', 'agent', 'event', 'status', 'created_at'];
export function demoRows(createdAt) {
  return [
    {
      id: 1,
      agent: 'research-agent',
      event: 'context.loaded',
      status: 'completed',
      created_at: createdAt,
    },
    {
      id: 2,
      agent: 'coding-agent',
      event: 'memory.recalled',
      status: 'completed',
      created_at: createdAt,
    },
    {
      id: 3,
      agent: 'research-agent',
      event: 'output.saved',
      status: 'completed',
      created_at: createdAt,
    },
  ];
}

export async function browseDatabase({ resource, action, name, execute, createdAt }) {
  if (resource.kind === 'duckdb') return browseDuckdb({ resource, action, name, execute });
  const live = mode(resource) === 'live';
  if (resource.status === 'expired')
    throw sqlError(
      410,
      'DATABASE_EXPIRED',
      'This Zero database has expired. Its data is no longer available.',
    );
  if (resource.status !== 'active')
    throw sqlError(409, 'DATABASE_UNAVAILABLE', 'This database is not active.');
  if (resource.provider && !['local', 'tidb-cloud-zero'].includes(resource.provider))
    throw sqlError(503, 'DATABASE_NOT_CONFIGURED', 'This database provider is not configured.');
  if (action === 'tables') {
    const data = live
      ? (await execute(`${tableSelect} ORDER BY TABLE_NAME LIMIT 501`)).rows
      : tables;
    return { data: data.slice(0, 500), truncated: data.length > 500, mode: mode(resource) };
  }
  name = tableName(name);
  const candidates = live
    ? (await execute(`${tableSelect}${nameFilter(name)} LIMIT 1`)).rows
    : tables;
  const table = candidates.find((entry) => entry.name === name);
  if (!table)
    throw sqlError(
      404,
      'TABLE_NOT_FOUND',
      'This table is no longer available. Refresh the table list.',
    );
  if (action === 'rows') {
    if (live) return execute(tableQuery(name));
    const rows = demoRows(createdAt);
    return { columns: demoColumns, rows, rowCount: rows.length, mode: 'demo', durationMs: 0 };
  }
  if (!live)
    return {
      ...table,
      columns: demoColumns.map((name) => ({
        name,
        type: name === 'id' ? 'int' : name === 'created_at' ? 'datetime' : 'varchar(255)',
        nullable: false,
        default: null,
        key: name === 'id' ? 'PRI' : '',
        extra: '',
      })),
      indexes: [
        {
          name: 'PRIMARY',
          unique: true,
          columns: [{ name: 'id', position: 1, prefixLength: null }],
        },
      ],
      query: 'SELECT * FROM agent_events LIMIT 100;',
      mode: 'demo',
    };
  const columns = (
    await execute(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue, COLUMN_KEY AS columnKey, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()${nameFilter(name)} ORDER BY ORDINAL_POSITION`,
    )
  ).rows;
  const parts = (
    await execute(
      `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS columnName, SEQ_IN_INDEX AS position, SUB_PART AS prefixLength FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()${nameFilter(name)} ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    )
  ).rows;
  const indexes = new Map();
  for (const part of parts) {
    if (!indexes.has(part.name))
      indexes.set(part.name, {
        name: part.name,
        unique: Number(part.nonUnique) === 0,
        columns: [],
      });
    indexes.get(part.name).columns.push({
      name: part.columnName,
      position: Number(part.position),
      prefixLength: part.prefixLength == null ? null : Number(part.prefixLength),
    });
  }
  return {
    ...table,
    columns: columns.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable === 'YES',
      default: column.defaultValue == null ? null : String(column.defaultValue),
      key: column.columnKey,
      extra: column.extra,
    })),
    indexes: [...indexes.values()],
    query: tableQuery(name),
    mode: 'live',
  };
}
