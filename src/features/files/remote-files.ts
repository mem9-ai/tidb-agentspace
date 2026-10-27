import { useEffect, useState } from 'react';

export type WorkspaceFile = {
  id: string;
  resourceId: string;
  path: string;
  type: 'file' | 'directory';
  content?: string;
  updatedAt: string | null;
  size?: number;
};
export type RemotePreview = { content?: string; size: number; unavailableReason?: string };
const base = '/api/v1/workspaces/ws_agentlab/files';
export function contentUrl(file: Pick<WorkspaceFile, 'resourceId' | 'path'>, preview = false) {
  return (
    base +
    '/content?' +
    new URLSearchParams({
      resourceId: file.resourceId,
      path: file.path,
      ...(preview ? { preview: '1' } : {}),
    })
  );
}
export async function fileRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'File request failed.');
  return result;
}
export function useRemoteFiles(resourceId: string, path: string, enabled: boolean) {
  const [listing, setListing] = useState<{
    resourceId: string;
    path: string;
    files: WorkspaceFile[];
  }>({ resourceId: '', path: '', files: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    fileRequest<{ data: WorkspaceFile[] }>(base + '?' + new URLSearchParams({ resourceId, path }), {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setListing({ resourceId, path, files: result.data });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Unable to load files.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [resourceId, path, enabled, revision]);
  return {
    files: listing.resourceId === resourceId && listing.path === path ? listing.files : [],
    loading,
    error,
    refresh: () => setRevision((n) => n + 1),
  };
}
export function downloadRemoteFile(file: WorkspaceFile) {
  const link = document.createElement('a');
  link.href = contentUrl(file);
  link.download = file.path.split('/').pop() || 'download';
  document.body.append(link);
  link.click();
  link.remove();
}
export const fileSize = (file: WorkspaceFile) =>
  file.size ?? new TextEncoder().encode(file.content || '').length;
