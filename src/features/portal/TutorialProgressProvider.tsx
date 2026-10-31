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

const Context = createContext<TutorialStore | null>(null);
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
  useEffect(() => {
    void store.refresh(ids ? ids.split(',') : []);
  }, [store, ids]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useTutorialStore() {
  const store = useContext(Context);
  if (!store) throw new Error('Tutorial progress requires a Workspace.');
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { store, ...snapshot };
}
export function TutorialProgressStatus() {
  const { store, loading, error } = useTutorialStore();
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
