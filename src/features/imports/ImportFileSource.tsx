import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Group,
  NativeSelect,
  ScrollArea,
  Stack,
  Text,
  TextInput,
} from '@tidbcloud/uikit';
import { IconFile01, IconFolder } from '@tidbcloud/uikit/icons';
import { workspaceApi, type WorkspaceFile } from '../../api/client';
import { WorkspaceBrowserItem } from '../../ui/WorkspaceBrowserItem';
import { useResourcePages } from '../resources/use-resource-pages';

export function ImportFileSource({
  resourceId,
  path,
  busy,
  onChange,
}: {
  resourceId: string;
  path: string;
  busy: boolean;
  onChange: (resourceId: string, path: string) => void;
}) {
  const resourcePages = useResourcePages(true);
  const systems = resourcePages.resources.filter(
    (r) => r.kind === 'filesystem' && r.status === 'active',
  );
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [folder, setFolder] = useState('/');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!resourceId) {
      setFiles([]);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    workspaceApi
      .listFiles(resourceId, folder, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted)
          setFiles(
            value.data.filter(
              (file) => (file.path.slice(0, file.path.lastIndexOf('/')) || '/') === folder,
            ),
          );
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Unable to list files.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [resourceId, folder, revision]);
  return (
    <Stack gap="md">
      <NativeSelect
        label="Source File System"
        value={resourceId}
        disabled={busy}
        data={[
          {
            value: '',
            label: systems.length
              ? 'Choose a File System'
              : resourcePages.loading
                ? 'Loading File Systems…'
                : resourcePages.nextCursor
                  ? 'No File Systems in loaded resources'
                  : 'No available File Systems',
          },
          ...systems.map((r) => ({ value: r.id, label: r.name })),
        ]}
        onChange={(e) => {
          setFolder('/');
          onChange(e.currentTarget.value, '');
        }}
      />
      {resourcePages.error && (
        <Alert color="red">
          <Text>{resourcePages.error}</Text>
          <Button mt="sm" disabled={busy} onClick={resourcePages.retry}>
            Try again
          </Button>
        </Alert>
      )}
      {resourcePages.nextCursor && (
        <Button
          type="button"
          disabled={busy}
          loading={resourcePages.loading}
          onClick={() => void resourcePages.loadMore()}
        >
          Load more resources
        </Button>
      )}
      {resourceId && (
        <>
          <Group justify="space-between">
            <Text c="dimmed" style={{ overflowWrap: 'anywhere' }}>
              {folder}
            </Text>
            <Button disabled={busy || loading} onClick={() => setRevision((v) => v + 1)}>
              Refresh files
            </Button>
          </Group>
          {loading ? (
            <Text role="status">Loading files…</Text>
          ) : (
            <ScrollArea.Autosize mah={220} type="auto">
              <Stack gap={4} aria-label="Import source files">
                {folder !== '/' && (
                  <Button
                    disabled={busy}
                    onClick={() => setFolder(folder.slice(0, folder.lastIndexOf('/')) || '/')}
                  >
                    Parent folder
                  </Button>
                )}
                {files.map((file) => (
                  <WorkspaceBrowserItem
                    key={file.id}
                    name={file.path.split('/').pop() || file.path}
                    description={file.type === 'directory' ? 'Folder' : `${file.size} bytes`}
                    icon={
                      file.type === 'directory' ? (
                        <IconFolder size={18} />
                      ) : (
                        <IconFile01 size={18} />
                      )
                    }
                    active={path === file.path}
                    disabled={busy}
                    onClick={() =>
                      file.type === 'directory'
                        ? setFolder(file.path)
                        : onChange(resourceId, file.path)
                    }
                  />
                ))}
                {!files.length && !error && <Text c="dimmed">No files in this folder.</Text>}
              </Stack>
            </ScrollArea.Autosize>
          )}
          <TextInput
            label="Source file path"
            placeholder="/datasets/orders.csv"
            value={path}
            disabled={busy}
            onChange={(e) => onChange(resourceId, e.currentTarget.value)}
          />
        </>
      )}
      {error && (
        <Alert color="red">
          {error}
          <Button ml="sm" disabled={busy} onClick={() => setRevision((v) => v + 1)}>
            Try again
          </Button>
        </Alert>
      )}
    </Stack>
  );
}
