import type { Resource } from '../../api/client';
import { databaseEditorHash } from '../navigation/workspace-route';
import { fileSystemHash } from '../files/file-location';

export function resourceWorkspaceHref(resource: Resource): string {
  return resource.kind === 'filesystem'
    ? fileSystemHash(resource.id)
    : databaseEditorHash(resource.id);
}

export function resourceServiceLabel(resource: Resource): string {
  switch (resource.provider) {
    case 'db9-anonymous':
      return 'PostgreSQL compatible · Trial';
    case 'drive9-anonymous':
      return 'Drive9 · Anonymous trial';
    default:
      return 'Local demo';
  }
}
