const pages = [
  'overview',
  'databases',
  'files',
  'connect',
  'tutorials',
  'keys',
  'api',
  'monitoring',
  'activity',
  'billing',
  'settings',
] as const;

export type Route = (typeof pages)[number];
export type WorkspaceRoute = {
  page: Route;
  databaseId?: string;
  databaseView?: 'tables' | 'sql';
  tableName?: string;
  fileLink?: string;
  tutorialResourceId?: string;
  tutorialKind?: 'database' | 'filesystem';
};

export function tutorialHash(resourceId: string): string {
  return '#tutorials?' + new URLSearchParams({ resourceId }).toString();
}
export function tutorialKindHash(kind: 'database' | 'filesystem'): string {
  return '#tutorials?' + new URLSearchParams({ kind }).toString();
}

function databaseHash(resourceId: string, view: 'tables' | 'sql', tableName?: string): string {
  return `#databases/${encodeURIComponent(resourceId)}/${view}${tableName ? `?table=${encodeURIComponent(tableName)}` : ''}`;
}
export function databaseEditorHash(resourceId: string, tableName?: string): string {
  return databaseHash(resourceId, 'sql', tableName);
}
export function databaseTablesHash(resourceId: string, tableName?: string): string {
  return databaseHash(resourceId, 'tables', tableName);
}
export function tableSelectSql(
  name: string,
  dialect: 'mysql' | 'duckdb' | 'postgresql' = 'mysql',
): string {
  if (dialect === 'postgresql')
    return `SELECT * FROM "workspace"."${name.replaceAll('"', '""')}" LIMIT 100;`;
  if (dialect === 'duckdb')
    return `SELECT * FROM "main"."${name.replaceAll('"', '""')}" LIMIT 100;`;
  return `SELECT * FROM \`${name.replaceAll('`', '``')}\` LIMIT 100;`;
}
export function parseWorkspaceRoute(hash: string): WorkspaceRoute {
  const value = hash.replace(/^#/, '');
  if (value.startsWith('tutorials?')) {
    const query = new URLSearchParams(value.slice(10));
    const resourceId = query.get('resourceId');
    const kind = query.get('kind');
    return {
      page: 'tutorials',
      ...(resourceId ? { tutorialResourceId: resourceId } : {}),
      ...(kind === 'database' || kind === 'filesystem' ? { tutorialKind: kind } : {}),
    };
  }
  if (value.startsWith('files?')) return { page: 'files', fileLink: value };
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
