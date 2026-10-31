import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceApi, type Resource } from '../../api/client';

/** Bounded discovery for selectors; callers choose when to load the next page. */
export function useResourcePages(enabled: boolean) {
  const [resources, setResources] = useState<Resource[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const generationRef = generation;
    const current = ++generationRef.current;
    setResources([]);
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
        setResources(page.data);
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
      setResources((prior) => {
        const combined = new Map(prior.map((resource) => [resource.id, resource]));
        for (const resource of page.data) combined.set(resource.id, resource);
        return [...combined.values()];
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
    resources,
    nextCursor,
    loading,
    error,
    loadMore,
    retry: () => setRevision((value) => value + 1),
  };
}
