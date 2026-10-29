import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const workspaceId = 'ws_agentlab';
export const capabilities = {
  mysql: {
    label: 'TiDB Starter · MySQL',
    regions: ['aws-us-east-1', 'aws-us-west-2'],
    storageGiB: 5,
    monthlyRU: 50_000_000,
    preview: false,
  },
  postgresql: {
    label: 'PostgreSQL · db9',
    regions: ['automatic'],
    storageGiB: null,
    monthlyRU: null,
    preview: true,
    available: false,
  },
  duckdb: {
    label: 'DuckDB',
    regions: ['aws-ap-southeast-1'],
    storageGiB: null,
    monthlyRU: null,
    preview: true,
  },
  filesystem: {
    label: 'TiDB Cloud File System',
    // The first region is the Console default. See ADR 0003 for provider/mode evidence.
    regions: ['aws-ap-southeast-1', 'aws-us-west-2'],
    storageGiB: 2,
    maxFiles: 2000,
    preview: true,
  },
};
export function seed() {
  const now = new Date().toISOString();
  return {
    workspace: {
      id: workspaceId,
      name: 'Agent playground',
      description: 'A home for your next idea.',
      plan: 'Free',
      createdAt: now,
    },
    profile: { name: 'Siddon', email: '', role: 'Local developer' },
    resources: [
      {
        id: 'db_memory',
        name: 'agent-memory',
        kind: 'mysql',
        region: 'aws-us-east-1',
        status: 'active',
        createdAt: now,
      },
      {
        id: 'fs_shared',
        name: 'shared-files',
        kind: 'filesystem',
        region: capabilities.filesystem.regions[0],
        status: 'active',
        createdAt: now,
      },
    ],
    files: [
      { id: 'f_docs', resourceId: 'fs_shared', path: '/docs', type: 'directory', updatedAt: now },
      {
        id: 'f_data',
        resourceId: 'fs_shared',
        path: '/datasets',
        type: 'directory',
        updatedAt: now,
      },
      {
        id: 'f_outputs',
        resourceId: 'fs_shared',
        path: '/outputs',
        type: 'directory',
        updatedAt: now,
      },
      {
        id: 'f_agents',
        resourceId: 'fs_shared',
        path: '/AGENTS.md',
        type: 'file',
        content:
          '# Agent playground\n\nUse the workspace API to discover databases and files.\nUse a scoped key. Never put credentials in source files.\n\nThis local prototype uses simulated cloud resources.\n',
        updatedAt: now,
      },
      {
        id: 'f_readme',
        resourceId: 'fs_shared',
        path: '/README.md',
        type: 'file',
        content:
          '# Welcome to your workspace\n\nDatabases for memory. Files for context. One place to build.\n\nThis is a local product prototype. Database provisioning and telemetry are simulated; files and keys persist locally.\n',
        updatedAt: now,
      },
      {
        id: 'f_notes',
        resourceId: 'fs_shared',
        path: '/docs/architecture.md',
        type: 'file',
        content:
          '# Architecture notes\n\nA workspace groups resources, scoped API keys, activity, and usage.\nEach MySQL resource has its own instance. PostgreSQL is currently unavailable. File systems have independent regional endpoints and data tokens.\n',
        updatedAt: now,
      },
    ],
    keys: [],
    events: [
      {
        id: 'evt_welcome',
        action: 'workspace.created',
        resource: 'Agent playground',
        actor: 'You',
        at: now,
        outcome: 'success',
      },
    ],
    queryCount: 0,
    resourceQueryCounts: {},
    idempotency: {},
  };
}
export async function createStore(file, initialState = seed) {
  let state;
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = initialState();
  }
  let queue = Promise.resolve();
  return {
    read: () => structuredClone(state),
    mutate(fn) {
      const job = queue.then(async () => {
        const draft = structuredClone(state);
        const result = await fn(draft);
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file + '.tmp', JSON.stringify(draft, null, 2), { mode: 0o600 });
        await rename(file + '.tmp', file);
        state = draft;
        return result;
      });
      queue = job.catch(() => {});
      return job;
    },
  };
}
export function usage(state) {
  return state.resources
    .filter(
      (resource) =>
        Object.hasOwn(capabilities, resource.kind) &&
        (resource.kind !== 'postgresql' || resource.provider === 'db9-anonymous'),
    )
    .map((resource) => ({
      resourceId: resource.id,
      name: resource.name,
      kind: resource.kind,
      storageBytes: [
        'drive9-anonymous',
        'tidb-cloud-zero',
        'duckdb-drive9',
        'db9-anonymous',
      ].includes(resource.provider)
        ? null
        : resource.kind === 'filesystem'
          ? state.files
              .filter((f) => f.resourceId === resource.id)
              .reduce((n, f) => n + Buffer.byteLength(f.content || ''), 0)
          : 0,
      storageLimitBytes: [
        'drive9-anonymous',
        'tidb-cloud-zero',
        'duckdb-drive9',
        'db9-anonymous',
      ].includes(resource.provider)
        ? null
        : capabilities[resource.kind].storageGiB * 1024 ** 3,
      measured: !['drive9-anonymous', 'tidb-cloud-zero', 'duckdb-drive9', 'db9-anonymous'].includes(
        resource.provider,
      ),
      fileCount: ['drive9-anonymous', 'tidb-cloud-zero', 'duckdb-drive9', 'db9-anonymous'].includes(
        resource.provider,
      )
        ? null
        : state.files.filter((f) => f.resourceId === resource.id && f.type === 'file').length,
      monthlyRU: ['drive9-anonymous', 'tidb-cloud-zero', 'duckdb-drive9', 'db9-anonymous'].includes(
        resource.provider,
      )
        ? null
        : 0,
      monthlyRULimit: ['tidb-cloud-zero', 'duckdb-drive9', 'db9-anonymous'].includes(
        resource.provider,
      )
        ? null
        : (capabilities[resource.kind].monthlyRU ?? null),
    }));
}

// Remote vaults refresh only at an authorized provider entry point.
export function withFreshStore(adapter, store) {
  if (!store.refresh) return adapter;
  return new Proxy(adapter, {
    get(target, key, receiver) {
      const method = Reflect.get(target, key, receiver);
      if (typeof method !== 'function' || key === 'close') return method;
      return async (...args) => {
        await store.refresh();
        return Reflect.apply(method, target, args);
      };
    },
  });
}
