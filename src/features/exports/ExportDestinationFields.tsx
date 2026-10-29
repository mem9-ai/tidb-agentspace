import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Group, Loader, NativeSelect, Text, TextInput } from '@tidbcloud/uikit';
import { workspaceApi, type Resource } from '../../api/client';
export type DestinationKind = 'download' | 'filesystem' | 'database';
const liveProviders = ['tidb-cloud-zero', 'duckdb-drive9', 'db9-anonymous'];
export function useExportDestination(kind: DestinationKind, resourceId: string) {
  const [resources, setResources] = useState<Resource[]>([]),
    [loading, setLoading] = useState(false),
    [loadError, setLoadError] = useState(''),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    if (kind === 'download') return;
    let current = true;
    setLoading(true);
    setLoadError('');
    workspaceApi
      .resources()
      .then((value) => {
        if (current) setResources(value.data);
      })
      .catch((cause: unknown) => {
        if (current)
          setLoadError(cause instanceof Error ? cause.message : 'Unable to load destinations.');
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [kind, revision]);
  const targets = resources.filter(
    (resource) =>
      resource.status === 'active' &&
      (kind === 'filesystem'
        ? resource.kind === 'filesystem'
        : resource.kind !== 'filesystem' && liveProviders.includes(resource.provider || '')),
  );
  return {
    targets,
    destination: targets.find((resource) => resource.id === resourceId),
    loading,
    loadError,
    retry: () => setRevision((value) => value + 1),
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
  children?: ReactNode;
}) {
  return (
    <>
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
                    : 'No available destinations',
                },
                ...state.targets.map((resource) => ({
                  value: resource.id,
                  label: `${resource.name} · ${resource.kind === 'filesystem' ? (resource.provider === 'drive9-anonymous' ? 'Live' : 'Local') : resource.kind === 'mysql' ? 'MySQL' : resource.kind === 'postgresql' ? 'PostgreSQL' : 'DuckDB'}`,
                })),
              ]}
            />
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
