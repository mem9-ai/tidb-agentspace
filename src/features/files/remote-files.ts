import { useEffect, useRef, useState } from 'react';

import { contentUrl, workspaceApi, type WorkspaceFile } from '../../api/client';
export type { WorkspaceFile } from '../../api/client';
export function useRemoteFiles(resourceId: string, path: string, enabled: boolean) {
  const [listing, setListing] = useState<{
    resourceId: string;
    path: string;
    files: WorkspaceFile[];
    nextCursor: string | null;
    earlier: boolean;
  }>({ resourceId: '', path: '', files: [], nextCursor: null, earlier: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const renderedGeneration = generation.current;
  useEffect(() => {
    generation.current++;
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    workspaceApi
      .listFiles(resourceId, path, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted)
          setListing({
            resourceId,
            path,
            files: result.data,
            nextCursor: result.nextCursor,
            earlier: false,
          });
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
  async function loadMore() {
    const cursor = listing.nextCursor;
    if (!cursor || loading) return;
    const request = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const result = await workspaceApi.listFiles(resourceId, path, undefined, cursor);
      if (request !== generation.current) return;
      setListing((current) => {
        if (
          current.resourceId !== resourceId ||
          current.path !== path ||
          current.nextCursor !== cursor
        )
          return current;
        const merged = new Map(current.files.map((file) => [file.id, file]));
        for (const file of result.data) merged.set(file.id, file);
        const files = [...merged.values()];
        return {
          resourceId,
          path,
          files: files.slice(-200),
          nextCursor: result.nextCursor,
          earlier: current.earlier || files.length > 200,
        };
      });
    } catch (cause) {
      if (request === generation.current)
        setError(cause instanceof Error ? cause.message : 'Unable to load files.');
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }
  return {
    files: listing.resourceId === resourceId && listing.path === path ? listing.files : [],
    loading:
      loading ||
      (enabled && !error && (listing.resourceId !== resourceId || listing.path !== path)),
    error,
    nextCursor:
      listing.resourceId === resourceId && listing.path === path ? listing.nextCursor : null,
    earlier: listing.resourceId === resourceId && listing.path === path && listing.earlier,
    loadMore,
    acceptSaved(file: WorkspaceFile) {
      const parent = file.path.slice(0, file.path.lastIndexOf('/')) || '/';
      if (file.resourceId !== resourceId || parent !== path) return;
      // Only a complete, settled directory can absorb a write without refreshing its cursor.
      if (
        renderedGeneration !== generation.current ||
        loading ||
        error ||
        listing.resourceId !== resourceId ||
        listing.path !== path ||
        listing.nextCursor ||
        listing.earlier ||
        listing.files.length >= 32
      ) {
        setRevision((n) => n + 1);
        return;
      }
      setListing((current) =>
        current.resourceId === resourceId && current.path === path
          ? { ...current, files: [...current.files.filter((old) => old.path !== file.path), file] }
          : current,
      );
    },
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
