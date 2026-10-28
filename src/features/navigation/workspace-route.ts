const pages = [
  'overview',
  'databases',
  'files',
  'connect',
  'keys',
  'api',
  'monitoring',
  'billing',
  'settings',
] as const;

export type Route = (typeof pages)[number];
export type WorkspaceRoute = {
  page: Route;
  databaseId?: string;
  databaseView?: 'tables' | 'sql';
  tableName?: string;
};

function databaseHash(resourceId: string, view: 'tables' | 'sql', tableName?: string): string {
  return `#databases/${encodeURIComponent(resourceId)}/${view}${tableName ? `?table=${encodeURIComponent(tableName)}` : ''}`;
}
export function databaseEditorHash(resourceId: string, tableName?: string): string {
  return databaseHash(resourceId, 'sql', tableName);
}
export function databaseTablesHash(resourceId: string, tableName?: string): string {
  return databaseHash(resourceId, 'tables', tableName);
}
export function tableSelectSql(name: string, dialect: 'mysql' | 'duckdb' = 'mysql'): string {
  if (dialect === 'duckdb')
    return `SELECT * FROM "main"."${name.replaceAll('"', '""')}" LIMIT 100;`;
  return `SELECT * FROM \`${name.replaceAll('`', '``')}\` LIMIT 100;`;
}
export function parseWorkspaceRoute(hash: string): WorkspaceRoute {
  const value = hash.replace(/^#/, '');
  if (value === 'sql') return { page: 'databases' };
  const database = /^databases\/([^/]+)\/(tables|sql)(?:\?table=([^&]*))?$/.exec(value);
  if (database) {
    try {
      const tableName = database[3] === undefined ? undefined : decodeURIComponent(database[3]);
      if (
        tableName !== undefined &&
        (!tableName ||
          [...tableName].length > 64 ||
          [...tableName].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ))
      )
        return { page: 'databases' };
      return {
        page: 'databases',
        databaseId: decodeURIComponent(database[1]),
        databaseView: database[2] === 'tables' ? 'tables' : 'sql',
        ...(tableName === undefined ? {} : { tableName }),
      };
    } catch {
      return { page: 'databases' };
    }
  }
  if (value.startsWith('databases/')) return { page: 'databases' };
  const page = pages.find((page) => page === value);
  return { page: page ?? 'overview' };
}
