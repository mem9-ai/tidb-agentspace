import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Group, Loader, NativeSelect, Text, TextInput } from '@tidbcloud/uikit';
import { useResourcePages } from '../resources/use-resource-pages';
import type { Resource } from '../../api/client';
export type DestinationKind = 'download' | 'filesystem' | 'database';
const liveProviders = ['tidb-cloud-zero', 'db9-anonymous'];
export function ExportKindSelect({
  kind,
  onKindChange,
  busy,
}: {
  kind: DestinationKind;
  onKindChange: (kind: DestinationKind) => void;
  busy: boolean;
}) {
  return (
    <NativeSelect
      label="Destination"
      value={kind}
      disabled={busy}
      onChange={(event) => {
        const value = event.currentTarget.value;
        if (value === 'download' || value === 'filesystem' || value === 'database')
          onKindChange(value);
      }}
      data={[
        { value: 'download', label: 'Download to your computer' },
        { value: 'filesystem', label: 'Workspace File System' },
        { value: 'database', label: 'Workspace database' },
      ]}
    />
  );
}
export function useExportDestination(
  kind: DestinationKind,
  resourceId: string,
  created?: Resource,
) {
  const pages = useResourcePages(kind !== 'download', resourceId);
  const { resources, loading } = pages;
  const [loadedKind, setLoadedKind] = useState<DestinationKind | null>(null);
  useEffect(() => setLoadedKind(kind), [kind]);
  const candidates = created
    ? [...resources.filter((resource) => resource.id !== created.id), created]
    : resources;
  const targets = candidates.filter(
    (resource) =>
      resource.status === 'active' &&
      (kind === 'filesystem'
        ? resource.kind === 'filesystem'
        : resource.kind !== 'filesystem' &&
          resource.kind !== 'duckdb' &&
          liveProviders.includes(resource.provider || '')),
  );
  return {
    targets,
    destination: targets.find((resource) => resource.id === resourceId),
    loading: loading || (kind !== 'download' && loadedKind !== kind),
    loadError: pages.error,
    retry: pages.retry,
    nextCursor: pages.nextCursor,
    hasEarlier: pages.hasEarlier,
    loadMore: pages.loadMore,
  };
}
export function ExportDestinationFields({
  kind,
  onKindChange,
  resourceId,
  onResourceChange,
  path,
  onPathChange,
  table,
  onTableChange,
  busy,
  state,
  showKindSelector = true,
  children,
}: {
  kind: DestinationKind;
  onKindChange: (kind: DestinationKind) => void;
  resourceId: string;
  onResourceChange: (id: string) => void;
  path: string;
  onPathChange: (path: string) => void;
  table: string;
  onTableChange: (table: string) => void;
  busy: boolean;
  state: ReturnType<typeof useExportDestination>;
  showKindSelector?: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      {showKindSelector && <ExportKindSelect kind={kind} onKindChange={onKindChange} busy={busy} />}
      {children}
      {kind !== 'download' && (
        <>
          {state.loading ? (
            <Group>
              <Loader size="sm" />
              <Text>Loading destinations…</Text>
            </Group>
          ) : state.loadError ? (
            <Alert color="red">
              <Text>{state.loadError}</Text>
              <Button mt="sm" onClick={state.retry}>
                Try again
              </Button>
            </Alert>
          ) : (
            <NativeSelect
              label={kind === 'filesystem' ? 'File System' : 'Database'}
              value={resourceId}
              disabled={busy || !state.targets.length}
              onChange={(event) => onResourceChange(event.currentTarget.value)}
              data={[
                {
                  value: '',
                  label: state.targets.length
                    ? 'Choose a destination'
                    : state.nextCursor || state.hasEarlier
                      ? 'No destinations in loaded resources'
                      : 'No available destinations',
                },
                ...state.targets.map((resource) => ({
                  value: resource.id,
                  label: `${resource.name} · ${resource.kind === 'filesystem' ? (resource.provider === 'drive9-anonymous' ? 'Live' : 'Local') : resource.kind === 'mysql' ? 'MySQL' : resource.kind === 'postgresql' ? 'PostgreSQL' : 'DuckDB'}`,
                })),
              ]}
            />
          )}
          {state.nextCursor && (
            <Button
              type="button"
              disabled={busy}
              loading={state.loading}
              onClick={() => void state.loadMore()}
            >
              Load more resources
            </Button>
          )}
          {state.hasEarlier && (
            <Button type="button" disabled={busy} onClick={state.retry}>
              Back to first resources
            </Button>
          )}
          {kind === 'filesystem' ? (
            <TextInput
              label="New file path"
              description="Use an existing folder. An existing file will not be replaced."
              value={path}
              disabled={busy}
              onChange={(event) => onPathChange(event.currentTarget.value)}
            />
          ) : (
            <TextInput
              label="New table name"
              description="An existing table will not be replaced."
              value={table}
              disabled={busy}
              onChange={(event) => onTableChange(event.currentTarget.value)}
            />
          )}
        </>
      )}
    </>
  );
}
