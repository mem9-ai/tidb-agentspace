import type { TableList } from '../../api/client';

// The initial catalog is only a creation-time snapshot. Do not retain it across reloads.
const snapshots = new Map<string, TableList>();
const key = (workspaceId: string, resourceId: string) => JSON.stringify([workspaceId, resourceId]);

export function rememberInitialTables(workspaceId: string, resourceId: string, tables: TableList) {
  snapshots.set(key(workspaceId, resourceId), tables);
}

export function initialTables(workspaceId: string, resourceId: string): TableList | undefined {
  return snapshots.get(key(workspaceId, resourceId));
}

export function forgetInitialTables(workspaceId: string, resourceId: string) {
  snapshots.delete(key(workspaceId, resourceId));
}
