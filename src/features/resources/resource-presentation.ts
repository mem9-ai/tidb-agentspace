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
    case 'tidb-cloud-zero':
      return 'TiDB Cloud Zero · Trial';
    case 'db9-anonymous':
      return 'db9 · Anonymous free tier';
    case 'duckdb-drive9':
      return 'DuckDB · Experimental';
    case 'drive9-anonymous':
      return 'Drive9 · Anonymous trial';
    default:
      return 'Local demo';
  }
}
