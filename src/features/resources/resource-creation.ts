import type { Data, Resource } from '../../api/client';

export type ResourceKind = Resource['kind'];
export type ResourceCreationTarget = ResourceKind | 'resource' | 'database';
export const resourceKindLabels: Record<ResourceKind, string> = {
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  duckdb: 'DuckDB',
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
  const kinds: ResourceKind[] =
    target === 'resource'
      ? ['mysql', 'postgresql', 'duckdb', 'filesystem']
      : target === 'database'
        ? ['mysql', 'postgresql', 'duckdb']
        : [target];
  const choices = kinds.filter(
    (kind) => kind !== 'postgresql' || capabilities.postgresql.available || target === kind,
  );
  const initialKind = choices[0];
  return {
    kinds: choices,
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
