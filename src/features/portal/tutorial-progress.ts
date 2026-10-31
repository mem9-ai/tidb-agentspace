export type TutorialProgress = {
  id: string;
  attempted: boolean;
  ready: boolean;
  completed: boolean;
};
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type Stores = { persistent?: StorageLike; session?: StorageLike };

function parseProgress(raw: string | null): TutorialProgress | null {
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
    )
      return {
        id: value.id,
        attempted: value.attempted,
        ready: value.ready,
        completed: 'completed' in value && value.completed === true && value.ready,
      };
  } catch {
    /* Ignore malformed or unavailable optional storage. */
  }
  return null;
}
function read(storage: StorageLike | undefined, key: string) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(storage: StorageLike | undefined, key: string, value: string) {
  try {
    storage?.setItem(key, value);
  } catch {
    /* In-memory progress remains usable. */
  }
}

export function createTutorialStore(workspaceId: string, stores: Stores = {}) {
  const prefix = `workspace-tutorial:v1:${workspaceId}:`;
  const memory = new Map<string, string>();
  const get = (key: string) =>
    memory.get(key) ?? read(stores.persistent, key) ?? read(stores.session, key);
  const set = (key: string, value: string) => {
    memory.set(key, value);
    write(stores.persistent, key, value);
    write(stores.session, key, value);
  };
  return {
    readSample(resourceId: string): TutorialProgress | null {
      const key = prefix + resourceId;
      const saved =
        parseProgress(memory.get(key) ?? null) ??
        parseProgress(read(stores.persistent, key)) ??
        parseProgress(read(stores.session, key));
      if (saved) return saved;
      // The previous session-only release supported this one fixed workspace.
      const legacy =
        workspaceId === 'ws_agentlab'
          ? parseProgress(read(stores.session, `tutorial:${resourceId}`))
          : null;
      if (legacy) set(key, JSON.stringify(legacy));
      return legacy;
    },
    saveSample(resourceId: string, progress: TutorialProgress) {
      set(prefix + resourceId, JSON.stringify(progress));
    },
    readSelection(kind: 'database' | 'filesystem') {
      const saved = get(prefix + `selection:${kind}`);
      if (saved) return saved;
      const legacy =
        workspaceId === 'ws_agentlab' ? read(stores.session, `tutorial-selection:${kind}`) : null;
      if (legacy) set(prefix + `selection:${kind}`, legacy);
      return legacy ?? '';
    },
    saveSelection(kind: 'database' | 'filesystem', resourceId: string) {
      set(prefix + `selection:${kind}`, resourceId);
    },
  };
}
export type TutorialStore = ReturnType<typeof createTutorialStore>;
const browserStores = new Map<string, TutorialStore>();
export function getTutorialStore(workspaceId: string): TutorialStore {
  const existing = browserStores.get(workspaceId);
  if (existing) return existing;
  let persistent: StorageLike | undefined;
  let session: StorageLike | undefined;
  try {
    persistent = window.localStorage;
  } catch {
    /* Optional storage. */
  }
  try {
    session = window.sessionStorage;
  } catch {
    /* Optional storage. */
  }
  const store = createTutorialStore(workspaceId, { persistent, session });
  browserStores.set(workspaceId, store);
  return store;
}
