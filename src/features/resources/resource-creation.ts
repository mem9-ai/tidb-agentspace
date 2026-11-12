import type { KnownKind } from '../../api/resource-discovery';
import type { Data } from '../../api/client';

export type ResourceKind = KnownKind;
export type CreatableResourceKind = KnownKind;
export type ResourceCreationTarget = CreatableResourceKind | 'resource' | 'database';
export type DatabaseCreationContext = {
  data: Data;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
  isGuest: boolean;
};
export const resourceKindLabels: Record<string, string> = {
  postgresql: 'PostgreSQL',
  filesystem: 'File System',
};
type CreationCapabilities = Record<
  ResourceKind,
  Pick<Data['capabilities'][ResourceKind], 'regions' | 'available'>
>;

export function resourceCreationContext(
  target: ResourceCreationTarget,
  capabilities: CreationCapabilities,
) {
  const kinds: CreatableResourceKind[] =
    target === 'resource'
      ? ['postgresql', 'filesystem']
      : target === 'database'
        ? ['postgresql']
        : [target];
  const initialKind =
    kinds.find(
      (kind) => capabilities[kind].available !== false && capabilities[kind].regions.length > 0,
    ) ?? kinds[0];
  return {
    kinds,
    initialKind,
    initialRegion: capabilities[initialKind].regions[0],
    title:
      target === 'resource'
        ? 'Create a resource'
        : target === 'database'
          ? 'Create a database'
          : target === 'filesystem'
            ? 'Create a File System'
            : `Create a ${resourceKindLabels[target]} database`,
  };
}
