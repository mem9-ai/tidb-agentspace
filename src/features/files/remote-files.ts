import { useEffect, useState } from 'react';

import { contentUrl, workspaceApi, type WorkspaceFile } from '../../api/client';
export type { WorkspaceFile } from '../../api/client';
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
    workspaceApi
      .listFiles(resourceId, path, controller.signal)
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
