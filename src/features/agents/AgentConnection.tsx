import { Alert, Anchor, Button, Group, Paper, Text } from '@tidbcloud/uikit';
import { agentInstructions } from '../../api/agent-instructions';
import { Heading } from '../../ui/WorkspaceHeading';
import { WorkspacePageHeader } from '../../ui/WorkspacePageHeader';

export function AgentConnection({
  endpoint,
  error,
  hasResources,
  copy,
  onNewKey,
}: {
  endpoint?: string;
  error: string;
  hasResources: boolean;
  copy: (value: string) => void;
  onNewKey?: () => void;
}) {
  function downloadInstructions() {
    if (!endpoint) return;
    const url = URL.createObjectURL(
      new Blob([agentInstructions(endpoint)], { type: 'text/markdown' }),
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
        title="Agents"
        description="Connect Codex CLI, Claude Code, Pi, or another external agent to your Space."
      />
      <Text mb="xl">
        Your agent runs in its own app. TiDB AgentSpace gives it access to the files and databases
        you choose. Creating a key does not confirm that an agent is connected.
      </Text>
      <Paper
        component="section"
        aria-label="Choose agent access"
        className="panel api-guide"
        p={24}
        withBorder
      >
        <Heading level={2}>1. Choose access</Heading>
        <Text>
          Create a Workspace Key with only the resources and actions your task needs. Analyzing
          files requires file read and analyze access. File write access also permits editing and
          deleting files in the selected resources.
        </Text>
        {!hasResources && (
          <Text>
            Need data to work with? <Anchor href="#files">Add your files</Anchor> or{' '}
            <Anchor href="#overview?example=sales">start with the sales sample</Anchor>, then select
            its file system when creating a key.
          </Text>
        )}
        <Group>
          <Button variant="filled" onClick={onNewKey}>
            Create API key
          </Button>
          <Anchor href="#keys">Manage access</Anchor>
        </Group>
      </Paper>
      <Paper
        component="section"
        aria-label="Set up your agent"
        className="panel api-guide"
        p={24}
        withBorder
      >
        <Heading level={2}>2. Set up your agent</Heading>
        <Text>
          Keep the revealed key in your agent’s secret settings as <code>WORKSPACE_API_KEY</code>.
          The key creation flow also offers a terminal setup command. Start a new agent session with
          access to that key, then paste the instructions and your task into chat.
        </Text>
        <Text size="sm">
          Using a terminal? In the shell where you set the key, start Codex CLI with{' '}
          <code>codex</code>, Claude Code with <code>claude</code>, or Pi with <code>pi</code>. Keep
          the key out of chat and copied tasks.
        </Text>
        {error ? (
          <Alert color="yellow">Couldn’t load the API endpoint. Refresh to try again.</Alert>
        ) : !endpoint ? (
          <Text role="status">Loading connection details…</Text>
        ) : (
          <Group>
            <Button onClick={() => copy(agentInstructions(endpoint))}>
              Copy agent instructions
            </Button>
            <Button onClick={downloadInstructions}>Download instructions</Button>
          </Group>
        )}
        <Text size="sm">
          Copying instructions does not confirm a connection. Review or revoke keys in Access.
        </Text>
      </Paper>
      <Paper
        component="section"
        aria-label="Get your first result"
        className="panel api-guide"
        p={24}
        withBorder
      >
        <Heading level={2}>3. Get your first result</Heading>
        <Text>
          Try the US sales sample: let your agent analyze the saved CSV and write a Markdown report.
          The guided task prepares access to that file system and the actions it needs. Return to
          Files to reopen saved work in a later session.
        </Text>
        <Group>
          <Button component="a" href="#overview?example=sales">
            Try the sales task
          </Button>
          <Anchor href="#files">Open saved files</Anchor>
          <Anchor href="#tutorials?kind=database">Try a database quickstart</Anchor>
        </Group>
        <Text size="sm">
          A saved file confirms that the file exists. It does not verify who created it or whether
          an agent completed the task.
        </Text>
      </Paper>
      <Text>
        Building with code? <Anchor href="#api">Open API docs</Anchor>.
      </Text>
    </>
  );
}
