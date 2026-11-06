import { useEffect, useState } from 'react';
import { Alert, Anchor, Button, Stack, Text } from '@tidbcloud/uikit';
import { globalApiSettings, type Resource } from '../../api/client';
import { workspaceSkillTask, workspaceSkillUrl } from '../../api/agent-instructions';
import agentClientUrl from '../../generated/workspace-agent.mjs?url';
import { WorkspaceModal } from '../../ui/WorkspaceModal';
import { ChoiceTabs } from '../../ui/ChoiceTabs';
import { CodeExample } from '../../ui/CodeExample';

export function ResourceConnection({
  resource,
  copy,
  onClose,
  onOpen,
  onManageKeys,
}: {
  resource: Resource;
  copy: (value: string) => void;
  onClose: () => void;
  onOpen: () => void;
  onManageKeys: () => void;
}) {
  const [tab, setTab] = useState('Agent');
  const [endpoint, setEndpoint] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    void globalApiSettings()
      .then((settings) => {
        if (active) setEndpoint(settings.endpoint);
      })
      .catch(() => {
        if (active) setError('The connection details could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  const files = resource.kind === 'filesystem';
  const task = files
    ? `List the files in ${JSON.stringify(resource.name)} (resource ID ${resource.id}). Reuse the existing resource; do not create another file system or modify files.`
    : `Connect to ${JSON.stringify(resource.name)} (resource ID ${resource.id}) and run SELECT 1 AS connected with readOnly:true. Reuse this database; do not create another resource.`;
  const prompt = workspaceSkillTask(
    endpoint,
    workspaceSkillUrl(location.origin, location.pathname),
    task,
  );
  const example = `import { connectWorkspace } from './workspace-agent.mjs';\n\nconst workspace = await connectWorkspace({\n  endpoint: ${JSON.stringify(endpoint)},\n  apiKey: process.env.WORKSPACE_API_KEY,\n});\n\nconsole.log(await workspace.${files ? `listFiles(${JSON.stringify(resource.id)})` : `query(${JSON.stringify(resource.id)}, 'SELECT 1 AS connected;', { readOnly: true })`});`;
  return (
    <WorkspaceModal
      wide
      title={`Connect to ${resource.name}`}
      description="Use your Workspace Key"
      onClose={onClose}
    >
      <Text mb="md">
        Use an existing Workspace Key with access to <strong>{resource.name}</strong>. The same key
        works with your other permitted resources.
      </Text>
      {error ? (
        <Alert color="red">
          <Stack gap="xs">
            <Text>{error}</Text>
            <Button variant="default" onClick={() => setAttempt(attempt + 1)}>
              Try again
            </Button>
          </Stack>
        </Alert>
      ) : !endpoint ? (
        <Text role="status">Loading connection details…</Text>
      ) : (
        <ChoiceTabs value={tab} onChange={setTab} options={['Agent', 'JavaScript']}>
          {tab === 'Agent' ? (
            <Stack gap="md">
              <Text>
                Keep your key in the agent’s environment or secret store as{' '}
                <code>WORKSPACE_API_KEY</code>. Paste these instructions into your agent to connect
                to this {files ? 'file system' : 'database'}.
              </Text>
              <Button variant="filled" w="fit-content" onClick={() => copy(prompt)}>
                Copy agent prompt
              </Button>
              <details>
                <summary>Preview instructions</summary>
                <Text component="pre" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {prompt}
                </Text>
              </details>
            </Stack>
          ) : (
            <Stack gap="md">
              <Text>
                Download the client into your project and set <code>WORKSPACE_API_KEY</code> in your
                environment. The client handles authentication and connection automatically.
                Requires Node.js 24 or later.
              </Text>
              <Anchor href={agentClientUrl} download="workspace-agent.mjs">
                Download JavaScript client
              </Anchor>
              <CodeExample label="JAVASCRIPT" value={example} copy={copy} />
            </Stack>
          )}
        </ChoiceTabs>
      )}
      <Text mt="md">
        For direct HTTP and other languages, see the{' '}
        <Anchor href="#api" onClick={onClose}>
          API documentation
        </Anchor>
        .
      </Text>
      <div className="modal-actions">
        <Button onClick={onManageKeys}>Manage keys</Button>
        <Button onClick={onOpen}>Open {files ? 'file browser' : 'SQL editor'}</Button>
      </div>
    </WorkspaceModal>
  );
}
