import { lazy, Suspense, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
} from '@tidbcloud/uikit';
import { Heading } from '../../ui/WorkspaceHeading';
const WorkspaceSqlInput = lazy(() => import('../sql/WorkspaceSqlInput'));
import { errorMessage, RaftError } from './raft-api';
import type { RaftApi, RaftFile, RaftResource } from './raft-api';

type Query = Awaited<ReturnType<RaftApi['query']>>;
export function RaftResourcePanel({
  api,
  workspaceId,
  resource,
  onChanged,
  onDirty,
}: {
  api: RaftApi;
  workspaceId: string;
  resource: RaftResource;
  onChanged: () => Promise<void>;
  onDirty?: (dirty: boolean) => void;
}) {
  const [path, setPath] = useState('note.txt');
  const [content, setContent] = useState('');
  const [file, setFile] = useState<RaftFile>();
  const [loadedPath, setLoadedPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sql, setSql] = useState('SELECT 1 AS hello;');
  const storageKey = `agentspace-query:${workspaceId}:${resource.id}`;
  const [requestId, setRequestId] = useState(
    () => sessionStorage.getItem(storageKey) || crypto.randomUUID(),
  );
  const [submitted, setSubmitted] = useState(() => sessionStorage.getItem(storageKey) !== null);
  const [query, setQuery] = useState<Query>();
  const [tagKey, setTagKey] = useState('project');
  const [tagValue, setTagValue] = useState('');
  const dirty = resource.kind === 'filesystem' && content !== (file?.content || '');
  useEffect(() => {
    onDirty?.(dirty);
    return () => onDirty?.(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function read() {
    const result = await api.read(workspaceId, resource.id, path);
    setFile(result);
    setContent(result.content);
    setLoadedPath(path);
  }
  async function execute() {
    if (submitted) return;
    if (!sql.trim() || new TextEncoder().encode(sql).length > 65536)
      throw new Error('Enter a SQL query of at most 64 KiB.');
    // Retain the original key before sending SQL. Reload offers observation, never replay.
    sessionStorage.setItem(storageKey, requestId);
    setSubmitted(true);
    try {
      const result = await api.query({ workspaceId, resourceId: resource.id, requestId, sql });
      setQuery(result);
    } catch (error) {
      // Only these documented pre-intent rejections prove this submission did not execute.
      if (
        error instanceof RaftError &&
        ((error.status === 400 && error.code === 'INVALID_SQL') ||
          (error.status === 403 && error.code === 'READ_ONLY_SQL_REQUIRED'))
      ) {
        sessionStorage.removeItem(storageKey);
        setSubmitted(false);
      }
      throw error;
    }
  }
  const result = query?.result;
  const columns =
    result && 'columns' in result && Array.isArray(result.columns)
      ? result.columns.filter((c: unknown): c is string => typeof c === 'string')
      : [];
  const rows = result && 'rows' in result && Array.isArray(result.rows) ? result.rows : [];
  const terminal = query?.status === 'succeeded' || query?.status === 'failed';
  return (
    <Paper withBorder p="xl">
      <Stack>
        <Group justify="space-between">
          <Heading level={2}>{resource.name}</Heading>
          <Badge>{resource.status}</Badge>
        </Group>
        <Text size="sm" c="dimmed">
          {resource.kind === 'filesystem' ? 'File System' : 'PostgreSQL'} · {resource.region}
          {resource.provider === 'local' ? ' · Local storage' : ''}
        </Text>
        {error && (
          <Alert role="alert" color="red">
            {error}
          </Alert>
        )}
        {notice && <Alert role="status">{notice}</Alert>}
        {resource.kind === 'filesystem' ? (
          <>
            <Group align="flex-end">
              <TextInput
                label="Relative file path"
                value={path}
                disabled={dirty || busy}
                onChange={(e) => {
                  setPath(e.currentTarget.value);
                  setFile(undefined);
                  setLoadedPath('');
                }}
              />
              <Button
                variant="default"
                disabled={busy || dirty || !resource.allowedActions.includes('files:read')}
                onClick={() => void run(read)}
              >
                Read file
              </Button>
            </Group>
            <Textarea
              label="File content"
              minRows={7}
              autosize
              maxRows={18}
              value={content}
              readOnly={!resource.allowedActions.includes('files:write')}
              onChange={(e) => setContent(e.currentTarget.value)}
            />
            <Group>
              <Button
                disabled={
                  busy ||
                  !resource.allowedActions.includes('files:write') ||
                  (file !== undefined && (!file.revision || loadedPath !== path))
                }
                onClick={() =>
                  void run(async () => {
                    await api.write(workspaceId, resource.id, path, content, file?.revision);
                    await read();
                    setNotice('File saved.');
                  })
                }
              >
                {file ? 'Save changes' : 'Create file'}
              </Button>
              {dirty && (
                <Button variant="default" onClick={() => setContent(file?.content || '')}>
                  Discard changes
                </Button>
              )}
            </Group>
            <Text size="sm" c="dimmed">
              New files are created only if the path is unused. Replacing a file requires its
              current revision. Text writes are limited to 64 KiB; reads to 128 KiB.
            </Text>
          </>
        ) : (
          <>
            <Suspense fallback={<Text>Loading SQL editor…</Text>}>
              <WorkspaceSqlInput
                databaseId={`raft:${resource.id}`}
                dialect="postgresql"
                value={sql}
                onChange={setSql}
                onRun={() => {
                  if (!busy) void run(execute);
                }}
                disabled={
                  busy ||
                  submitted ||
                  !resource.allowedActions.some(
                    (a) => a === 'queries:read' || a === 'queries:execute',
                  )
                }
              />
            </Suspense>
            <Group>
              <Button
                disabled={
                  busy ||
                  submitted ||
                  !resource.allowedActions.some(
                    (a) => a === 'queries:read' || a === 'queries:execute',
                  )
                }
                onClick={() => void run(execute)}
              >
                Run query
              </Button>
              <Button
                variant="default"
                disabled={busy || !submitted}
                onClick={() =>
                  void run(async () => {
                    setQuery(await api.queryStatus(workspaceId, resource.id, requestId));
                  })
                }
              >
                Check query status
              </Button>
              {terminal && (
                <Button
                  variant="default"
                  onClick={() => {
                    sessionStorage.removeItem(storageKey);
                    setRequestId(crypto.randomUUID());
                    setSubmitted(false);
                    setQuery(undefined);
                  }}
                >
                  New query
                </Button>
              )}
            </Group>
            <Text size="sm" className="raft-identity">
              Request ID: {requestId}
            </Text>
            {submitted && (
              <Text role="status">
                {query?.status === 'outcomeUnknown'
                  ? 'The database outcome is unknown. Inspect the data before deciding on another write; a new ID would create a different operation.'
                  : query?.status === 'succeeded'
                    ? 'Query completed.'
                    : query?.status === 'failed'
                      ? 'Query failed.'
                      : 'Request retained. Check its status before submitting another query.'}
              </Text>
            )}
            {!!result && (
              <div
                className="raft-result"
                role="region"
                aria-label="Query result data"
                tabIndex={0}
              >
                {columns.length ? (
                  <Table>
                    <Table.Thead>
                      <Table.Tr>
                        {columns.map((c) => (
                          <Table.Th key={c}>{c}</Table.Th>
                        ))}
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {rows.map((row: unknown, i: number) => (
                        <Table.Tr key={i}>
                          {columns.map((c) => (
                            <Table.Td key={c}>
                              {row && typeof row === 'object' && c in row
                                ? String(Reflect.get(row, c) ?? 'NULL')
                                : ''}
                            </Table.Td>
                          ))}
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                ) : (
                  <Text>Operation completed.</Text>
                )}
              </div>
            )}
          </>
        )}
        <Group>
          {Object.entries(resource.tags?.values || {}).map(([key, value]) => (
            <Badge key={key}>
              {key}: {value}
            </Badge>
          ))}
        </Group>
        {resource.allowedActions.includes('tags:write') && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api.tags(workspaceId, resource.id, {
                  version: resource.tags?.version || 0,
                  values: { ...resource.tags?.values, [tagKey]: tagValue },
                });
                await onChanged();
                setNotice('Tags saved.');
              });
            }}
          >
            <Group align="flex-end">
              <TextInput
                label="Tag key"
                value={tagKey}
                required
                maxLength={64}
                onChange={(e) => setTagKey(e.currentTarget.value)}
              />
              <TextInput
                label="Tag value"
                value={tagValue}
                maxLength={256}
                onChange={(e) => setTagValue(e.currentTarget.value)}
              />
              <Button type="submit" variant="default" disabled={busy}>
                Save tag
              </Button>
            </Group>
          </form>
        )}
      </Stack>
    </Paper>
  );
}
