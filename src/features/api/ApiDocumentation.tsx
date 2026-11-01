import { useEffect, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  NativeSelect,
  Paper,
  Text,
  TextInput,
} from '@tidbcloud/uikit';
import { WorkspacePageHeader } from '../../ui/WorkspacePageHeader';
import { Heading } from '../../ui/WorkspaceHeading';
import { CodeExample } from '../../ui/CodeExample';
import { ChoiceTabs } from '../../ui/ChoiceTabs';
import { apiBaseUrl, globalApiSettings, type Data } from '../../api/client';
import { agentInstructions } from '../../api/agent-instructions';
import { apiExamples } from './api-examples';
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
  const [settings, setSettings] = useState<{ baseUrl: string; regionId: string }>(),
    [error, setError] = useState('');
  const [tab, setTab] = useState('cURL'),
    [authority, setAuthority] = useState('Region'),
    [search, setSearch] = useState(''),
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
  const root = authority === 'Global' ? settings?.baseUrl : apiBaseUrl;
  useEffect(() => {
    let active = true;
    setOperations([]);
    setSelected('');
    if (root)
      void fetch(root + '/openapi.json', { redirect: 'error' })
        .then(async (r) => {
          if (!r.ok) throw new Error('Unable to load API reference.');
          return r.json() as Promise<unknown>;
        })
        .then((v) => {
          if (active) setOperations(catalog(v));
        })
        .catch((e) => {
          if (active) setError(String(e.message));
        });
    return () => {
      active = false;
    };
  }, [root]);
  const examples = apiExamples(
    settings?.baseUrl || 'GLOBAL_API_URL',
    apiBaseUrl,
    data.workspace.id,
    settings?.regionId || '',
    data.resources.find((r) => r.kind !== 'filesystem')?.id,
    data.resources.find((r) => r.kind === 'filesystem')?.id,
  );
  const filtered = operations.filter((o) =>
    search
      .toLowerCase()
      .split(/\s+/)
      .every((term) => (o.method + ' ' + o.path + ' ' + o.summary).toLowerCase().includes(term)),
  );
  const operation = filtered.find((o) => o.method + ' ' + o.path === selected) || filtered[0];
  function downloadInstructions() {
    const url = URL.createObjectURL(
      new Blob(
        [agentInstructions(data.workspace.id, apiBaseUrl, settings?.baseUrl, settings?.regionId)],
        { type: 'text/markdown' },
      ),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'WORKSPACE.md';
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <WorkspacePageHeader
        title={connect ? 'Connect an agent' : 'API documentation'}
        description="Create a Global Key, exchange it for a Token, then work directly with your Region."
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
        <Heading level={2}>One Key. Two API endpoints.</Heading>
        <Text>
          Global manages Keys, policy and discovery. Region handles databases, files, analysis,
          imports and exports. Data requests go directly to Region.
        </Text>
        <div className="api-addresses">
          <div>
            <Badge>Global</Badge>
            <code>{settings?.baseUrl || 'Not configured'}</code>
            {settings && (
              <Anchor href={settings.baseUrl + '/openapi.json'} target="_blank" rel="noreferrer">
                Global OpenAPI
              </Anchor>
            )}
          </div>
          <div>
            <Badge>Region</Badge>
            <code>{apiBaseUrl}</code>
            <Anchor href={apiBaseUrl + '/openapi.json'} target="_blank" rel="noreferrer">
              Region OpenAPI
            </Anchor>
          </div>
        </div>
      </Paper>
      <Paper className="panel api-guide" p={24} withBorder>
        <Heading level={2}>Start with a scoped Token</Heading>
        <Text>
          1. Create a Key in <Anchor href="#keys">API keys</Anchor>. Choose resources and actions.
          Save its one-time secret in your secret manager.
        </Text>
        <Text>2. Set these endpoint variables. The cURL examples use curl and jq.</Text>
        <CodeExample label="SHELL" value={examples.setup} copy={copy} />
        <Text>
          3. Exchange the Key at Global and call Region. Access Tokens last at most 15 minutes and
          never outlive their parent Key.
        </Text>
        <ChoiceTabs value={tab} onChange={setTab} options={['cURL', 'JavaScript', 'Python']}>
          <CodeExample
            label={tab.toUpperCase()}
            value={
              tab === 'Python'
                ? examples.python
                : tab === 'JavaScript'
                  ? examples.javascript
                  : examples.exchange
            }
            copy={copy}
          />
        </ChoiceTabs>
        <Alert color="peacock">
          Use a Global-audience Token for Global discovery; use a Region-audience Token for Region
          data. A raw Key is accepted only by Global Token issuance.
        </Alert>
        <Heading level={3}>Long-running agents</Heading>
        <Text>
          Use the repository’s <code>connectAgentWorkspace</code> client with an Ed25519 proof key
          and application secret storage. It enrolls a client-bound refresh family and renews
          directly at Region, including during a Global outage. It never falls back to routing data
          through Global. Received revocations and actual Key expiry still apply.
        </Text>
        <Button onClick={downloadInstructions}>Download WORKSPACE.md</Button>
      </Paper>
      <Paper className="panel api-guide" p={24} withBorder>
        <Heading level={2}>Read a database</Heading>
        <CodeExample value={examples.sql} copy={copy} />
        <Text>
          Check <code>GET /context</code> for effective permissions and limits. Follow{' '}
          <code>nextCursor</code> when listing resources. SQL writes require{' '}
          <code>queries:execute</code>; never automatically retry an uncertain write.
        </Text>
      </Paper>
      <Paper className="panel api-guide" p={24} withBorder>
        <Heading level={2}>Create and safely update a file</Heading>
        <CodeExample value={examples.files} copy={copy} />
        <Text>
          A stale version returns 412 without writing. Use a new path after a create-only conflict;
          re-read and review before an update. Analysis requires both read and analyze grants.
        </Text>
      </Paper>
      <Paper className="panel api-guide" p={24} withBorder>
        <Heading level={2}>Review and import a file</Heading>
        <CodeExample value={examples.imports} copy={copy} />
        <Text>
          Inspect the sample and field mapping before confirmation. Preparations expire after five
          minutes and are unavailable after restart. Imports create new tables; an unknown outcome
          requires inspection before another attempt.
        </Text>
      </Paper>
      <Paper className="panel api-guide" p={24} withBorder>
        <Heading level={2}>Export a query result</Heading>
        <CodeExample value={examples.exports} copy={copy} />
        <Text>
          Download exports return JSON containing the file content. Copies to a File System or a new
          table check destination permissions separately.
        </Text>
      </Paper>
      {!connect && (
        <Paper className="panel api-guide" p={24} withBorder>
          <Heading level={2}>API reference</Heading>
          <Text>
            Every documented operation is listed below, with its authentication, parameters, request
            and response schemas. Owner operations use an Owner session; agent Tokens do not acquire
            Owner privileges.
          </Text>
          <Group grow>
            <NativeSelect
              label="API authority"
              value={authority}
              onChange={(e) => setAuthority(e.target.value)}
              data={['Region', 'Global']}
            />
            <TextInput
              label="Find an operation"
              placeholder="files, queries, import…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Group>
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
