import { useEffect, useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, Paper, Text, TextInput } from '@tidbcloud/uikit';
import { WorkspacePageHeader } from '../../ui/WorkspacePageHeader';
import { Heading } from '../../ui/WorkspaceHeading';
import { CodeExample } from '../../ui/CodeExample';
import { apiBaseUrl, globalApiSettings, type Data } from '../../api/client';
import { agentInstructions } from '../../api/agent-instructions';
import agentClientUrl from '../../generated/workspace-agent.mjs?url';
import { WorkspaceApiPlayground } from './WorkspaceApiPlayground';
import './api-documentation.css';

type Operation = {
  method: string;
  path: string;
  summary: string;
  description: string;
  security: string;
  parameters: string[];
  request: unknown;
  responses: unknown;
};
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function catalog(value: unknown): Operation[] {
  const spec = record(value);
  return Object.entries(record(spec.paths)).flatMap(([path, item]) =>
    Object.entries(record(item))
      .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
      .map(([method, value]) => {
        const op = record(value);
        return {
          path,
          method: method.toUpperCase(),
          summary: String(op.summary || op.operationId || ''),
          description: String(op.description || ''),
          security: JSON.stringify(op.security || spec.security || []),
          parameters: [
            ...(Array.isArray(record(item).parameters)
              ? (record(item).parameters as unknown[])
              : []),
            ...(Array.isArray(op.parameters) ? op.parameters : []),
          ].map((p) => {
            const v = record(p);
            return `${v.in}: ${v.name}${v.required ? ' (required)' : ''} — ${v.description || JSON.stringify(v.schema)}`;
          }),
          request: op.requestBody,
          responses: op.responses,
        };
      }),
  );
}
export function ApiDocumentation({
  data,
  copy,
  connect = false,
  onNewKey,
}: {
  data: Data;
  copy: (value: string) => void;
  connect?: boolean;
  onNewKey?: () => void;
}) {
  const [settings, setSettings] = useState<{
      baseUrl: string;
      endpoint: string;
      regionId: string;
    }>(),
    [error, setError] = useState('');
  const [search, setSearch] = useState(''),
    [operations, setOperations] = useState<Operation[]>([]),
    [selected, setSelected] = useState('');
  useEffect(() => {
    let active = true;
    void globalApiSettings()
      .then((v) => {
        if (active) setSettings(v);
      })
      .catch((e) => {
        if (active) setError(String(e.message));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setOperations([]);
    setSelected('');
    if (!connect && settings?.endpoint)
      void Promise.all(
        [settings.endpoint, apiBaseUrl].map(async (root) => {
          const response = await fetch(root + '/openapi.json', { redirect: 'error' });
          if (!response.ok) throw new Error('Unable to load API reference.');
          return response.json() as Promise<unknown>;
        }),
      )
        .then((schemas) => {
          if (active) setOperations(schemas.flatMap(catalog));
        })
        .catch((e) => {
          if (active) setError(String(e.message));
        });
    return () => {
      active = false;
    };
  }, [connect, settings?.endpoint]);
  const setup = `export WORKSPACE_ENDPOINT='${settings?.endpoint || 'YOUR_API_ENDPOINT'}'\n# Set WORKSPACE_API_KEY to your API key.`;
  const example = `import { connectWorkspace } from './workspace-agent.mjs';\n\nconst workspace = await connectWorkspace({\n  endpoint: process.env.WORKSPACE_ENDPOINT,\n  apiKey: process.env.WORKSPACE_API_KEY,\n});\n\nconsole.log(await workspace.listResources());`;
  const filtered = operations.filter((o) =>
    search
      .toLowerCase()
      .split(/\s+/)
      .every((term) => (o.method + ' ' + o.path + ' ' + o.summary).toLowerCase().includes(term)),
  );
  const operation = filtered.find((o) => o.method + ' ' + o.path === selected) || filtered[0];
  function downloadInstructions() {
    const url = URL.createObjectURL(
      new Blob([agentInstructions(settings?.endpoint)], { type: 'text/markdown' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'WORKSPACE.md';
    link.click();
    URL.revokeObjectURL(url);
  }
  if (connect) {
    return (
      <>
        <WorkspacePageHeader
          title="Connect an agent"
          description="Give your agent access to the workspace resources you choose."
        />
        <Paper className="panel api-guide" p={24} withBorder>
          <Heading level={2}>1. Choose access</Heading>
          <Text>
            Create a Workspace API key and select the resources and actions your agent needs.
            Analyzing files requires file read and analyze access. File write access also permits
            editing and deleting files in the selected resources.
          </Text>
          <Group>
            <Button variant="filled" onClick={onNewKey}>
              Create API key
            </Button>
            <Anchor href="#keys">Manage existing keys</Anchor>
          </Group>
        </Paper>
        <Paper className="panel api-guide" p={24} withBorder>
          <Heading level={2}>2. Give your agent the instructions</Heading>
          <Text>
            Save the key in your agent’s environment or secret manager as WORKSPACE_API_KEY, then
            share these instructions. The instructions do not include your key.
          </Text>
          {error ? (
            <Alert color="yellow">Couldn’t load the API endpoint. Refresh to try again.</Alert>
          ) : !settings ? (
            <Text role="status">Loading connection details…</Text>
          ) : (
            <Group>
              <Button variant="filled" onClick={() => copy(agentInstructions(settings.endpoint))}>
                Copy agent instructions
              </Button>
              <Button onClick={downloadInstructions}>Download instructions</Button>
            </Group>
          )}
          <Text size="sm">
            Copying instructions does not confirm a connection. You can revoke a key from API keys.
          </Text>
          <details>
            <summary>Example: connect Pi</summary>
            <Text mt="sm">
              After creating a key, follow the terminal setup shown with it. In the same Bash or Zsh
              terminal, run <code>pi</code> to start a new Pi session. Copy the agent instructions
              above and paste them into Pi with your task. Pi must have a model configured and
              access to the Workspace API.
            </Text>
            <Text size="sm" mt="sm">
              The key stays in the terminal environment. Do not paste it into Pi or a chat.
            </Text>
          </details>
        </Paper>
        <Text>
          Want to connect with code? <Anchor href="#api">See the API documentation</Anchor>.
        </Text>
      </>
    );
  }
  return (
    <>
      <WorkspacePageHeader
        title={connect ? 'Connect an agent' : 'API documentation'}
        description="Use one endpoint and a scoped API key to connect your agent."
        actions={
          onNewKey ? (
            <Button variant="filled" onClick={onNewKey}>
              Create API key
            </Button>
          ) : undefined
        }
      />
      {error && <Alert color="yellow">{error}</Alert>}
      <Paper className="panel api-guide" p={24} withBorder>
        <Heading level={2}>API endpoint</Heading>
        <Text>
          Use this endpoint with a <Anchor href="#keys">Workspace API key</Anchor> to connect your
          agent or application.
        </Text>
        <Group>
          <code>{settings?.endpoint || 'Not available'}</code>
          {settings && <Button onClick={() => copy(settings.endpoint)}>Copy endpoint</Button>}
        </Group>
      </Paper>
      <Paper className="panel api-guide" p={24} withBorder>
        <Heading level={2}>Connect your agent</Heading>
        <Text>
          Create an API key, then give your agent the endpoint and the key. Keep the key in an
          environment variable or secret manager.
        </Text>
        <Group>
          <Button variant="filled" onClick={() => copy(agentInstructions(settings?.endpoint))}>
            Copy agent instructions
          </Button>
          <Button onClick={downloadInstructions}>Download agent instructions</Button>
        </Group>
      </Paper>
      <Paper className="panel api-guide" p={24} withBorder>
        <Heading level={2}>Use JavaScript</Heading>
        <Text>
          Download the client into your project, then set the endpoint and API key in your
          environment. Requires Node.js 24 or later.
        </Text>
        <Anchor href={agentClientUrl} download="workspace-agent.mjs">
          Download JavaScript client
        </Anchor>
        <CodeExample label="SHELL" value={setup} copy={copy} />
        <CodeExample label="JAVASCRIPT" value={example} copy={copy} />
      </Paper>
      {!connect && <WorkspaceApiPlayground data={data} copy={copy} />}
      {!connect && (
        <Paper className="panel api-guide" p={24} withBorder>
          <Heading level={2}>API reference</Heading>
          <Text>
            Every documented operation is listed below, with its authentication, parameters, request
            and response schemas. The Portal uses its own signed-in session for account and Key
            management.
          </Text>
          <TextInput
            label="Find an operation"
            placeholder="files, queries, import…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="api-reference">
            <div className="api-operation-list">
              {filtered.map((o) => (
                <Button
                  key={o.method + o.path}
                  variant={operation === o ? 'light' : 'subtle'}
                  onClick={() => setSelected(o.method + ' ' + o.path)}
                >
                  <span>
                    <Badge>{o.method}</Badge> {o.summary}
                  </span>
                </Button>
              ))}
            </div>
            {operation ? (
              <div className="api-operation-detail">
                <Heading level={3}>{operation.summary}</Heading>
                <code>
                  {operation.method} {operation.path}
                </code>
                <Text>{operation.description}</Text>
                <Text fw={600}>Authentication</Text>
                <code>{operation.security}</code>
                {operation.parameters.map((p, i) => (
                  <Text key={i} size="sm">
                    {p}
                  </Text>
                ))}
                {operation.request !== undefined && (
                  <CodeExample
                    label="JSON"
                    value={JSON.stringify(operation.request, null, 2)}
                    copy={copy}
                  />
                )}
                <CodeExample
                  label="JSON"
                  value={JSON.stringify(operation.responses, null, 2)}
                  copy={copy}
                />
              </div>
            ) : (
              <Text>No operations found.</Text>
            )}
          </div>
        </Paper>
      )}
    </>
  );
}
