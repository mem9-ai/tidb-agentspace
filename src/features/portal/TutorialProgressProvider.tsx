import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Alert, Button, Text } from '@tidbcloud/uikit';
import { workspaceApi } from '../../api/client';
import { browserLegacyStores, createTutorialStore, type TutorialStore } from './tutorial-progress';

const Context = createContext<{ store: TutorialStore; ids: string } | null>(null);
export function TutorialProgressProvider({
  workspaceId,
  resourceIds,
  children,
}: {
  workspaceId: string;
  resourceIds: string[];
  children: ReactNode;
}) {
  const store = useMemo(
    () => createTutorialStore(workspaceId, workspaceApi, browserLegacyStores()),
    [workspaceId],
  );
  const ids = resourceIds.join(',');
  const context = useMemo(() => ({ store, ids }), [store, ids]);
  return <Context.Provider value={context}>{children}</Context.Provider>;
}
export function useTutorialStore(load = true) {
  const context = useContext(Context);
  if (!context) throw new Error('Tutorial progress requires a Workspace.');
  const { store, ids } = context;
  useEffect(() => {
    if (load) void store.refresh(ids ? ids.split(',') : []);
  }, [store, ids, load]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { store, ...snapshot };
}
export function TutorialProgressStatus() {
  const { store, loading, error } = useTutorialStore(false);
  if (loading) return <Text role="status">Loading Workspace tutorial progress…</Text>;
  if (!error) return null;
  return (
    <Alert color="red" role="alert" title="Tutorial progress unavailable">
      {error}
      <Button mt="sm" variant="default" onClick={() => void store.refresh()}>
        Retry tutorial progress
      </Button>
    </Alert>
  );
}
