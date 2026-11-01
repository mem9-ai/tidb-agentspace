import { useState } from 'react';
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
import { useRemoteFiles } from '../files/remote-files';
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
  const resourcePages = useResourcePages(true, resourceId);
  const systems = resourcePages.resources.filter(
    (r) => r.kind === 'filesystem' && r.status === 'active',
  );
  const [folder, setFolder] = useState('/');
  const listing = useRemoteFiles(resourceId, folder, Boolean(resourceId));
  const { files, error, loading } = listing;
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
                : resourcePages.nextCursor || resourcePages.hasEarlier
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
      {resourcePages.hasEarlier && (
        <Button type="button" disabled={busy} onClick={resourcePages.retry}>
          Back to first resources
        </Button>
      )}
      {resourceId && (
        <>
          <Group justify="space-between">
            <Text c="dimmed" style={{ overflowWrap: 'anywhere' }}>
              {folder}
            </Text>
            <Button disabled={busy || loading} onClick={listing.refresh}>
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
                {listing.earlier && (
                  <Button disabled={busy} onClick={listing.refresh}>
                    Back to first files
                  </Button>
                )}
                {listing.nextCursor && (
                  <Button disabled={busy} loading={loading} onClick={() => void listing.loadMore()}>
                    Load more files
                  </Button>
                )}
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
          <Button ml="sm" disabled={busy} onClick={listing.refresh}>
            Try again
          </Button>
        </Alert>
      )}
    </Stack>
  );
}
