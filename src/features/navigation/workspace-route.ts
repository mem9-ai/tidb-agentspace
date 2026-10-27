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
export type WorkspaceRoute = { page: Route; databaseId?: string };

export function databaseEditorHash(resourceId: string): string {
  return `#databases/${encodeURIComponent(resourceId)}/sql`;
}

export function parseWorkspaceRoute(hash: string): WorkspaceRoute {
  const value = hash.replace(/^#/, '');
  // Old workspace-level editor bookmarks now ask the user to choose a database.
  if (value === 'sql') return { page: 'databases' };
  const editor = /^databases\/([^/]+)\/sql$/.exec(value);
  if (editor) {
    try {
      return { page: 'databases', databaseId: decodeURIComponent(editor[1]) };
    } catch {
      return { page: 'databases' };
    }
  }
  if (value.startsWith('databases/')) return { page: 'databases' };
  const page = pages.find((page) => page === value);
  return { page: page ?? 'overview' };
}
