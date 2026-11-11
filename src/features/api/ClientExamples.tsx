import { Anchor, Group, Paper, Stack, Tabs, Text } from '@tidbcloud/uikit';
import { CodeExample } from '../../ui/CodeExample';
import { Heading } from '../../ui/WorkspaceHeading';
import javascriptUrl from '../../generated/workspace-agent.mjs?url';
import pythonUrl from '../../clients/python/workspace_agent.py?url&inline';

const source = 'https://github.com/mem9-ai/tidb.ai/blob/main/src/clients';
const clients = [
  {
    name: 'JavaScript',
    runtime: 'Node.js 24 or later',
    url: javascriptUrl,
    file: 'workspace-agent.mjs',
    source: source + '/javascript/workspace-agent.ts',
    example: `import { connectWorkspace } from './workspace-agent.mjs';

const workspace = await connectWorkspace({
  endpoint: process.env.WORKSPACE_ENDPOINT,
  apiKey: process.env.WORKSPACE_API_KEY,
});

console.log(await workspace.listResources());`,
  },
  {
    name: 'Python',
    runtime: 'Python 3.9 or later',
    url: pythonUrl,
    file: 'workspace_agent.py',
    source: source + '/python/workspace_agent.py',
    example: `import os
from workspace_agent import connect_workspace

workspace = connect_workspace(
    endpoint=os.environ["WORKSPACE_ENDPOINT"],
    api_key=os.environ["WORKSPACE_API_KEY"],
)

print(workspace.list_resources())`,
  },
];

export function ClientExamples({
  endpoint,
  copy,
}: {
  endpoint?: string;
  copy: (value: string) => void;
}) {
  return (
    <Paper className="panel api-guide" p={24} withBorder>
      <Heading level={2}>API clients</Heading>
      <Tabs defaultValue="JavaScript" keepMounted={false}>
        <Tabs.List aria-label="Client language">
          {clients.map(({ name }) => (
            <Tabs.Tab key={name} value={name}>
              {name}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {clients.map((client) => (
          <Tabs.Panel key={client.name} value={client.name} pt="md">
            <Stack>
              <Text>Save the client next to your script. Requires {client.runtime}.</Text>
              <Group>
                <Anchor href={client.url} download={client.file}>
                  Download {client.name} client
                </Anchor>
                <Anchor href={client.source} target="_blank" rel="noreferrer">
                  View source on GitHub
                </Anchor>
              </Group>
              {endpoint && (
                <CodeExample
                  label="SHELL"
                  value={`export WORKSPACE_ENDPOINT='${endpoint}'\n# Set WORKSPACE_API_KEY in your environment.`}
                  copy={copy}
                />
              )}
              <CodeExample label={client.name.toUpperCase()} value={client.example} copy={copy} />
            </Stack>
          </Tabs.Panel>
        ))}
      </Tabs>
    </Paper>
  );
}
