import { Button, Paper, Text } from '@tidbcloud/uikit';
import { IconDatabase01, IconFolder, IconPlus } from '@tidbcloud/uikit/icons';
import { Heading } from '../../ui/WorkspaceHeading';

export function WorkspaceFirstSteps({
  onCreate,
}: {
  onCreate: (target: 'database' | 'filesystem') => void;
}) {
  return (
    <section className="resource-grid" aria-label="Get started">
      <Paper className="panel first-value-choice" withBorder p="xl">
        <IconDatabase01 size={28} aria-hidden />
        <Heading level={2}>Query your data</Heading>
        <Text>Store structured data and query it with SQL.</Text>
        <Button
          variant="filled"
          leftSection={<IconPlus size={18} />}
          onClick={() => onCreate('database')}
        >
          Create database
        </Button>
      </Paper>
      <Paper className="panel first-value-choice" withBorder p="xl">
        <IconFolder size={28} aria-hidden />
        <Heading level={2}>Work with files</Heading>
        <Text>Upload, preview, and analyze files in one place.</Text>
        <Button
          variant="filled"
          leftSection={<IconPlus size={18} />}
          onClick={() => onCreate('filesystem')}
        >
          Create file system
        </Button>
      </Paper>
    </section>
  );
}
