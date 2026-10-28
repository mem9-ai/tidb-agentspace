export type FileView = 'preview' | 'source' | 'analyze';
export type FileLocation = { resourceId: string; path: string; view: FileView };
export function fileSystemHash(resourceId: string): string {
  return '#files?' + new URLSearchParams({ resourceId }).toString();
}
export function parseFileSystemLocation(hash: string): {
  resourceId: string;
  file: FileLocation | null;
  invalidFile: boolean;
} | null {
  if (!hash.startsWith('#files?')) return null;
  const query = new URLSearchParams(hash.slice(7));
  const resourceId = query.get('resourceId');
  if (!resourceId) return null;
  const file = parseFileLocation(hash);
  return {
    resourceId,
    file,
    invalidFile: !file && (query.has('path') || query.has('view')),
  };
}
export function fileHash(resourceId: string, path: string, view: FileView): string {
  return (
    '#files?' +
    new URLSearchParams({ resourceId, path, view: view === 'source' ? 'preview' : view }).toString()
  );
}
export function parseFileLocation(hash: string): FileLocation | null {
  if (!hash.startsWith('#files?')) return null;
  const query = new URLSearchParams(hash.slice(7));
  const resourceId = query.get('resourceId');
  const path = query.get('path');
  const view = query.get('view') || 'preview';
  if (
    !resourceId ||
    !path ||
    !path.startsWith('/') ||
    path === '/' ||
    path.includes('\\') ||
    [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    path
      .split('/')
      .slice(1)
      .some((part) => !part || part === '.' || part === '..') ||
    (view !== 'preview' && view !== 'source' && view !== 'analyze')
  )
    return null;
  return { resourceId, path, view: view === 'source' ? 'preview' : view };
}
