import { sqlError } from './providers/sql-common.mjs';
import { tableName } from './database-identifiers.mjs';
const quote = (name) => "'" + name.replaceAll("'", "''") + "'";
export const duckdbTableQuery = (name) =>
  `SELECT * FROM "main"."${tableName(name).replaceAll('"', '""')}" LIMIT 100;`;
const schema = "table_catalog = current_database() AND table_schema = 'main'";
export async function browseDuckdb({ resource, action, name, execute }) {
  if (resource.status !== 'active')
    throw sqlError(409, 'DATABASE_UNAVAILABLE', 'DuckDB is not active.');
  const select = `SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE ${schema}`;
  if (action === 'tables') {
    const data = (await execute(`${select} ORDER BY table_name LIMIT 501`)).rows;
    return { data: data.slice(0, 500), truncated: data.length > 500, mode: 'live' };
  }
  name = tableName(name);
  const table = (await execute(`${select} AND table_name = ${quote(name)}`)).rows[0];
  if (!table)
    throw sqlError(
      404,
      'TABLE_NOT_FOUND',
      'This table is no longer available. Refresh the table list.',
    );
  if (action === 'rows') return execute(duckdbTableQuery(name));
  const columns = (
    await execute(
      `SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS defaultValue FROM information_schema.columns WHERE ${schema} AND table_name = ${quote(name)} ORDER BY ordinal_position`,
    )
  ).rows;
  const filter = `database_name = current_database() AND schema_name = 'main' AND table_name = ${quote(name)}`;
  const constraints = (
    await execute(
      `SELECT constraint_type AS type, constraint_column_names AS names, constraint_index AS position FROM duckdb_constraints() WHERE ${filter} AND constraint_type IN ('PRIMARY KEY','UNIQUE') ORDER BY constraint_index`,
    )
  ).rows;
  const parts = (
    await execute(
      `SELECT index_name AS name, is_unique AS uniqueValue, CAST(expressions AS VARCHAR[]) AS expressions FROM duckdb_indexes() WHERE ${filter} ORDER BY index_name`,
    )
  ).rows;
  const indexes = constraints.map((c) => ({
    name: c.type === 'PRIMARY KEY' ? 'PRIMARY' : `UNIQUE_${c.position}`,
    unique: true,
    columns: c.names.map((name, i) => ({ name, position: i + 1, prefixLength: null })),
  }));
  for (const index of parts)
    indexes.push({
      name: index.name,
      unique: index.uniqueValue,
      columns: index.expressions.map((expression, i) => ({
        name: /^"(?:[^"]|"")+"$/.test(expression)
          ? expression.slice(1, -1).replaceAll('""', '"')
          : expression,
        position: i + 1,
        prefixLength: null,
      })),
    });
  return {
    ...table,
    columns: columns.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable === 'YES',
      default: c.defaultValue == null ? null : String(c.defaultValue),
      key: constraints.some((x) => x.type === 'PRIMARY KEY' && x.names.includes(c.name))
        ? 'PRI'
        : constraints.some((x) => x.names.includes(c.name))
          ? 'UNI'
          : '',
      extra: '',
    })),
    indexes,
    query: duckdbTableQuery(name),
    mode: 'live',
  };
}
