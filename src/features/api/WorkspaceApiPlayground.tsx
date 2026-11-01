import { useState } from 'react';
import { Alert, Badge, Button, Group, NativeSelect, Paper, Text } from '@tidbcloud/uikit';
import { apiBaseUrl, workspaceApi, type Data } from '../../api/client';
import { Heading } from '../../ui/WorkspaceHeading';
import { CodeExample } from '../../ui/CodeExample';

/** Console-only read controls. Agent examples use scoped Tokens and the same Region API. */
export function WorkspaceApiPlayground({
  data,
  copy,
}: {
  data: Data;
  copy: (value: string) => void;
}) {
  const [endpoint, setEndpoint] = useState('/resources'),
    [result, setResult] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const filesystem = data.resources.find((r) => r.kind === 'filesystem');
  const endpoints = [
    { value: '/resources', label: 'GET /resources' },
    { value: '/usage', label: 'GET /usage' },
    { value: '/events', label: 'GET /events' },
    ...(filesystem ? [{ value: '/files', label: 'GET /files' }] : []),
  ];
  async function run() {
    setBusy(true);
    setError('');
    setResult('');
    try {
      const value =
        endpoint === '/resources'
          ? await workspaceApi.resources()
          : endpoint === '/usage'
            ? await workspaceApi.usage()
            : endpoint === '/events'
              ? await workspaceApi.events()
              : await workspaceApi.listFiles(filesystem?.id || '');
      setResult(JSON.stringify(value, null, 2));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to read from your Workspace.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Paper className="panel api-guide" p={24} withBorder>
      <Heading level={2}>Try a read from your Workspace</Heading>
      <Group>
        <Badge>Workspace owner session</Badge>
        <Text>
          These read controls use your signed-in Console session. Agents use the Region access
          Tokens shown above.
        </Text>
      </Group>
      <Group align="end">
        <NativeSelect
          label="Read operation"
          disabled={busy}
          value={endpoint}
          data={endpoints}
          onChange={(e) => {
            setEndpoint(e.target.value);
            setResult('');
            setError('');
          }}
        />
        <Button variant="filled" loading={busy} disabled={busy} onClick={() => void run()}>
          Send request
        </Button>
      </Group>
      <code>
        {apiBaseUrl}/api/v1/workspaces/{data.workspace.id}
        {endpoint}
        {endpoint === '/files' ? '?resourceId=' + encodeURIComponent(filesystem?.id || '') : ''}
      </code>
      {error && <Alert color="red">{error}</Alert>}
      {result ? (
        <CodeExample label="JSON" value={result} copy={copy} />
      ) : (
        <Text c="dimmed">Send a request to see current data from your Workspace.</Text>
      )}
    </Paper>
  );
}
