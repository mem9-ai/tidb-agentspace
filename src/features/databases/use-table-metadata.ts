import { useEffect, useReducer, useRef, useState } from 'react';
import { workspaceApi, type TableDetail } from '../../api/client';
import { TableMetadataCache } from './table-metadata-cache';

type Snapshot = { key: string; data?: TableDetail; error?: string; loading: boolean };
export type TableMetadata = {
  data?: TableDetail;
  error?: string;
  loading: boolean;
  retry: () => void;
};

// Share one selected-table read between the inline columns and explicit inspector.
export function useTableMetadata(
  resourceId: string,
  name: string | undefined,
  revision: number,
  paused: boolean,
): TableMetadata {
  const [attempt, retry] = useReducer((value: number) => value + 1, 0);
  const key = JSON.stringify([resourceId, name, revision, attempt]);
  const [snapshot, setSnapshot] = useState<Snapshot>({ key: '', loading: false });
  const cache = useRef(new TableMetadataCache());
  const context = JSON.stringify([resourceId, revision, attempt]);
  useEffect(() => {
    if (!name || paused) return;
    const cached = cache.current.get(context, name);
    if (cached) {
      setSnapshot({ key, data: cached, loading: false });
      return;
    }
    const controller = new AbortController();
    setSnapshot({ key, loading: true });
    workspaceApi.table(resourceId, name, controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        const next = { key, data, loading: false };
        cache.current.set(context, name, data);
        setSnapshot(next);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        const next = {
          key,
          error: cause instanceof Error ? cause.message : 'Could not load columns. Try again.',
          loading: false,
        };
        setSnapshot(next);
      },
    );
    return () => controller.abort();
  }, [resourceId, name, key, context, paused]);
  return {
    data: snapshot.key === key ? snapshot.data : undefined,
    error: snapshot.key === key ? snapshot.error : undefined,
    loading: !!name && (snapshot.key !== key || snapshot.loading),
    retry,
  };
}
