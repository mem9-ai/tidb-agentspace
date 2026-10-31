import type { Tutorial, workspaceApi } from '../../api/client';
import { WorkspaceApiError } from '../../api/transport.ts';

export type TutorialProgress = {
  id: string;
  attempted: boolean;
  ready: boolean;
  completed: boolean;
  version?: string;
};
type StorageLike = Pick<Storage, 'getItem'>;
type Stores = { persistent?: StorageLike; session?: StorageLike };
type Api = Pick<typeof workspaceApi, 'listTutorials' | 'replaceTutorial'>;
type Snapshot = { loading: boolean; error: string; samples: Record<string, Tutorial> };

function read(storage: StorageLike | undefined, key: string) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function legacySample(raw: string | null): TutorialProgress | null {
  try {
    const value: unknown = JSON.parse(raw || 'null');
    if (
      value &&
      typeof value === 'object' &&
      'id' in value &&
      typeof value.id === 'string' &&
      /^[a-f0-9]{32}$/.test(value.id) &&
      'attempted' in value &&
      typeof value.attempted === 'boolean' &&
      'ready' in value &&
      typeof value.ready === 'boolean' &&
      (!('completed' in value) || typeof value.completed === 'boolean')
    ) {
      return {
        id: value.id,
        attempted: value.attempted || value.ready,
        ready: value.ready,
        completed: 'completed' in value && value.completed === true && value.ready,
      };
    }
  } catch {
    /* Untrusted legacy browser data is optional. */
  }
  return null;
}
function fromRecord(record: Tutorial): TutorialProgress {
  if (
    !/^[a-f0-9]{32}$/.test(record.sampleId) ||
    !/^"tutorial-[a-f0-9]{32}"$/.test(record.version) ||
    !['pending', 'attempted', 'ready', 'completed'].includes(record.state)
  )
    throw new Error('Invalid saved tutorial progress.');
  return {
    id: record.sampleId,
    attempted: record.state !== 'pending',
    ready: ['ready', 'completed'].includes(record.state),
    completed: record.state === 'completed',
    version: record.version,
  };
}
function input(progress: TutorialProgress) {
  return {
    sampleId: progress.id,
    state: progress.completed
      ? ('completed' as const)
      : progress.ready
        ? ('ready' as const)
        : progress.attempted
          ? ('attempted' as const)
          : ('pending' as const),
  };
}

export function createTutorialStore(workspaceId: string, api: Api, stores: Stores = {}) {
  let snapshot: Snapshot = { loading: true, error: '', samples: {} };
  const listeners = new Set<() => void>();
  const selection = { database: '', filesystem: '' };
  let pending: Promise<void> | undefined;
  let resources: string[] = [];
  const publish = (next: Snapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  async function load() {
    const samples: Record<string, Tutorial> = {};
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await api.listTutorials(workspaceId, cursor);
      for (const record of page.data) {
        fromRecord(record);
        samples[record.resourceId] = record;
      }
      cursor = page.nextCursor || undefined;
      if (cursor && seen.has(cursor)) throw new Error('Invalid tutorial pagination.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return samples;
  }
  async function refresh(resourceIds?: string[], background = false) {
    if (resourceIds) resources = resourceIds;
    if (pending) return pending;
    publish({ ...snapshot, loading: background ? snapshot.loading : true, error: '' });
    pending = (async () => {
      try {
        let samples = await load();
        let migrated = false;
        for (const resourceId of resources) {
          if (samples[resourceId]) continue;
          const key = `workspace-tutorial:v1:${workspaceId}:${resourceId}`;
          const legacy =
            legacySample(read(stores.persistent, key)) ??
            legacySample(read(stores.session, key)) ??
            (workspaceId === 'ws_agentlab'
              ? legacySample(read(stores.session, `tutorial:${resourceId}`))
              : null);
          if (!legacy?.attempted) continue;
          try {
            await api.replaceTutorial(workspaceId, resourceId, input(legacy));
          } catch (cause) {
            if (!(cause instanceof WorkspaceApiError && cause.status === 412)) throw cause;
          }
          migrated = true;
        }
        if (migrated) samples = await load();
        publish({ loading: false, error: '', samples });
      } catch {
        publish({
          ...snapshot,
          loading: false,
          error:
            'Could not load or migrate Workspace tutorial progress. Retry before continuing; your existing samples have not been changed.',
        });
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    readSample(resourceId: string) {
      return snapshot.samples[resourceId] ? fromRecord(snapshot.samples[resourceId]) : null;
    },
    async saveSample(resourceId: string, progress: TutorialProgress): Promise<TutorialProgress> {
      if (snapshot.loading || snapshot.error)
        throw new Error('Load Workspace tutorial progress before continuing.');
      try {
        const { data } = await api.replaceTutorial(
          workspaceId,
          resourceId,
          input(progress),
          progress.version,
        );
        const saved = fromRecord(data);
        publish({ ...snapshot, samples: { ...snapshot.samples, [resourceId]: data } });
        return saved;
      } catch (cause) {
        await refresh(undefined, true); // Observe only: a missing acknowledgement never replays a sample write.
        throw new Error(
          cause instanceof WorkspaceApiError && cause.status === 412
            ? 'Tutorial progress changed in this Workspace. The saved sample has been reloaded; review it before continuing.'
            : 'Could not confirm saved tutorial progress. Refresh and check the saved sample before continuing. No sample action was retried.',
          { cause },
        );
      }
    },
    readSelection(kind: 'database' | 'filesystem') {
      return (
        selection[kind] ||
        read(stores.persistent, `workspace-tutorial:v1:${workspaceId}:selection:${kind}`) ||
        ''
      );
    },
    saveSelection(kind: 'database' | 'filesystem', resourceId: string) {
      selection[kind] = resourceId;
    },
  };
}
export type TutorialStore = ReturnType<typeof createTutorialStore>;

export function browserLegacyStores(): Stores {
  const stores: Stores = {};
  try {
    stores.persistent = window.localStorage;
  } catch {
    /* Migration is optional. */
  }
  try {
    stores.session = window.sessionStorage;
  } catch {
    /* Migration is optional. */
  }
  return stores;
}
