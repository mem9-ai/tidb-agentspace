import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceApi, type Resource } from '../../api/client';
import { resourceWindow } from './resource-window';

/** Bounded discovery for selectors; callers choose when to load the next page. */
export function useResourcePages(enabled: boolean, selectedId?: string) {
  const [window, setWindow] = useState<{ resources: Resource[]; truncated: boolean }>({
    resources: [],
    truncated: false,
  });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const selection = useRef(selectedId);
  selection.current = selectedId;
  useEffect(() => {
    const generationRef = generation;
    const current = ++generationRef.current;
    setWindow((prior) => ({
      resources: enabled
        ? prior.resources.filter((resource) => resource.id === selection.current)
        : [],
      truncated: false,
    }));
    setNextCursor(null);
    setError('');
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    workspaceApi
      .resourcesPage()
      .then((page) => {
        if (generation.current !== current) return;
        setWindow((prior) => ({
          resources: resourceWindow(prior.resources, page.data, selection.current).resources,
          truncated: false,
        }));
        setNextCursor(page.nextCursor ?? null);
      })
      .catch((cause: unknown) => {
        if (generation.current === current)
          setError(cause instanceof Error ? cause.message : 'Unable to load resources.');
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      generationRef.current++;
    };
  }, [enabled, revision]);
  const loadMore = useCallback(async () => {
    if (!nextCursor || loading) return;
    const current = generation.current;
    setLoading(true);
    setError('');
    try {
      const page = await workspaceApi.resourcesPage(nextCursor);
      if (generation.current !== current) return;
      setWindow((prior) => {
        const next = resourceWindow(prior.resources, page.data, selection.current);
        return { resources: next.resources, truncated: prior.truncated || next.dropped };
      });
      setNextCursor(page.nextCursor ?? null);
    } catch (cause) {
      if (generation.current === current)
        setError(cause instanceof Error ? cause.message : 'Unable to load resources.');
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [nextCursor, loading]);
  return {
    resources: window.resources,
    hasEarlier: window.truncated,
    nextCursor,
    loading,
    error,
    loadMore,
    retry: () => setRevision((value) => value + 1),
  };
}
