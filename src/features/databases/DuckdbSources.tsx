import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  NativeSelect,
  Stack,
  Text,
  TextInput,
  Typography,
} from '@tidbcloud/uikit';
import {
  workspaceApi,
  type QuerySource,
  type Resource,
  type WorkspaceFile,
} from '../../api/client';

type Props = {
  fileSystems: Resource[];
  sources: QuerySource[];
  busy: boolean;
  onChange: (sources: QuerySource[]) => void;
  onQuery: (name: string) => void;
};
const supported = (file: WorkspaceFile) => /\.(csv|json|jsonl|ndjson|parquet)$/i.test(file.path);
export function DuckdbSources({ fileSystems, sources, busy, onChange, onQuery }: Props) {
  const [opened, setOpened] = useState(false);
  const [resourceId, setResourceId] = useState(
    (fileSystems.find((resource) => resource.provider === 'drive9-anonymous') || fileSystems[0])
      ?.id || '',
  );
  const [directory, setDirectory] = useState('/');
  const [pathInput, setPathInput] = useState('/');
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [listing, setListing] = useState<{
    files: WorkspaceFile[];
    loading: boolean;
    error?: string;
  }>({ files: [], loading: false });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!opened || !resourceId) return;
    const controller = new AbortController();
    setListing({ files: [], loading: true });
    workspaceApi.listFiles(resourceId, directory, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setListing({ files: result.data, loading: false });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setListing({
            files: [],
            loading: false,
            error: error instanceof Error ? error.message : 'Could not list files.',
          });
      },
    );
    return () => controller.abort();
  }, [opened, resourceId, directory, revision]);
  const file = listing.files.find((file) => file.path === selected);
  const valid =
    /^[a-z][a-z0-9_]{0,31}$/.test(name) && !sources.some((source) => source.name === name);
  return (
    <section className="database-file-sources" aria-label="Workspace file sources">
      <Stack gap="sm">
        <Group justify="space-between">
          <Typography component="h3" variant="title-lg">
            File sources <Badge>{sources.length} / 4</Badge>
          </Typography>
          <Button variant="subtle" disabled={busy} onClick={() => setOpened(!opened)}>
            {opened ? 'Hide file picker' : 'Add file source'}
          </Button>
        </Group>
        {opened && (
          <Text>
            Query selected CSV, JSON and Parquet as files.name. Sources last for one read-only query
            · 16 MiB total.
          </Text>
        )}
        {sources.map((source) => (
          <Group align="center" justify="space-between" key={source.name}>
            <Text style={{ overflowWrap: 'anywhere', flex: '1 1 220px', minWidth: 0 }}>
              <code>files.{source.name}</code> ·{' '}
              {fileSystems.find((resource) => resource.id === source.resourceId)?.name} ·{' '}
              {source.path}
            </Text>
            <Group>
              <Button disabled={busy} onClick={() => onQuery(source.name)}>
                Query {source.name}
              </Button>
              <Button
                disabled={busy}
                aria-label={`Remove source ${source.name}`}
                onClick={() => onChange(sources.filter((item) => item.name !== source.name))}
              >
                Remove
              </Button>
            </Group>
          </Group>
        ))}
        {opened &&
          (!fileSystems.length ? (
            <Text>Create a File System and upload CSV, JSON or Parquet to query it here.</Text>
          ) : (
            <Stack gap="lg">
              <NativeSelect
                label="Source File System"
                value={resourceId}
                disabled={busy}
                onChange={(event) => {
                  setResourceId(event.currentTarget.value);
                  setDirectory('/');
                  setPathInput('/');
                  setSelected('');
                  setName('');
                }}
              >
                {fileSystems.map((resource) => (
                  <option key={resource.id} value={resource.id}>
                    {resource.name}
                  </option>
                ))}
              </NativeSelect>
              <Group align="flex-end" grow>
                <TextInput
                  label="Source directory"
                  value={pathInput}
                  disabled={busy}
                  onChange={(event) => setPathInput(event.currentTarget.value)}
                />
                <Button
                  disabled={busy || listing.loading}
                  onClick={() => {
                    setDirectory(pathInput);
                    setSelected('');
                    setRevision((value) => value + 1);
                  }}
                >
                  Browse directory
                </Button>
              </Group>
              {listing.error && <Alert color="red">{listing.error}</Alert>}
              <NativeSelect
                label="Source file"
                value={selected}
                disabled={busy || listing.loading}
                onChange={(event) => {
                  const path = event.currentTarget.value;
                  setSelected(path);
                  setName(
                    path
                      .split('/')
                      .pop()
                      ?.replace(/\.[^.]+$/, '')
                      .toLowerCase()
                      .replace(/[^a-z0-9_]/g, '_')
                      .replace(/^[^a-z]+/, '')
                      .slice(0, 32) || `source_${sources.length + 1}`,
                  );
                }}
              >
                <option value="">
                  {listing.loading ? 'Loading files…' : 'Choose a file or folder'}
                </option>
                {listing.files.map((file) => (
                  <option
                    key={file.path}
                    value={file.path}
                    disabled={file.type !== 'directory' && (!supported(file) || file.size === 0)}
                  >
                    {file.path.split('/').pop()}
                    {file.type === 'directory' ? '/' : ` · ${file.size} bytes`}
                  </option>
                ))}
              </NativeSelect>
              <TextInput
                label="Source table name"
                description="Lower-case letters, digits and underscores; start with a letter."
                value={name}
                disabled={busy || file?.type === 'directory'}
                onChange={(event) => setName(event.currentTarget.value)}
                error={
                  name && !valid ? 'Use a unique source name, up to 32 characters.' : undefined
                }
              />
              <Button
                variant="filled"
                disabled={
                  busy ||
                  !file ||
                  (file.type !== 'directory' &&
                    (!valid || sources.length >= 4 || !supported(file) || file.size === 0))
                }
                onClick={() => {
                  if (!file) return;
                  if (file.type === 'directory') {
                    setDirectory(file.path);
                    setPathInput(file.path);
                    setSelected('');
                    return;
                  }
                  onChange([...sources, { name, resourceId, path: file.path }]);
                  setSelected('');
                  setName('');
                }}
              >
                {file?.type === 'directory' ? 'Open folder' : 'Add source'}
              </Button>
              <Text c="carbon.7">
                API Keys need queries:execute, files:read and files:analyze, plus access to this
                database and each source File System. Unsupported or oversized files can be
                downloaded from File System.
              </Text>
            </Stack>
          ))}
      </Stack>
    </section>
  );
}
