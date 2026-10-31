import { Button, Paper, Text } from '@tidbcloud/uikit';
import { IconDatabase01, IconFolder, IconPlus } from '@tidbcloud/uikit/icons';
import { Heading } from '../../ui/WorkspaceHeading';
import { GuestExpiryNotice, ResourceQuickStart } from './ResourceQuickStart';

export function WorkspaceFirstSteps({
  onCreate,
  showDatabase,
  showFileSystem,
  isGuest,
}: {
  onCreate: (target: 'database' | 'filesystem') => void;
  showDatabase: boolean;
  showFileSystem: boolean;
  isGuest: boolean;
}) {
  return (
    <section aria-label="Get started">
      {isGuest && <GuestExpiryNotice />}
      <div className="resource-grid">
        {showDatabase && (
          <Paper className="panel first-value-choice" withBorder p="xl">
            <IconDatabase01 size={28} aria-hidden />
            <Heading level={2}>Query your data</Heading>
            <Text>Store structured data and get your first SQL result.</Text>
            <ResourceQuickStart kind="database" />
            <Button
              variant="filled"
              leftSection={<IconPlus size={18} />}
              onClick={() => onCreate('database')}
            >
              Create database
            </Button>
          </Paper>
        )}
        {showFileSystem && (
          <Paper className="panel first-value-choice" withBorder p="xl">
            <IconFolder size={28} aria-hidden />
            <Heading level={2}>Work with files</Heading>
            <Text>Give your agent persistent context and explore your files.</Text>
            <ResourceQuickStart kind="filesystem" />
            <Button
              variant="filled"
              leftSection={<IconPlus size={18} />}
              onClick={() => onCreate('filesystem')}
            >
              Create file system
            </Button>
          </Paper>
        )}
      </div>
    </section>
  );
}
