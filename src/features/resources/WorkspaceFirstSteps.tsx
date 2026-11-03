import { Button, Group, Paper, Text } from '@tidbcloud/uikit';
import { IconFolder, IconPlus } from '@tidbcloud/uikit/icons';
import { Heading } from '../../ui/WorkspaceHeading';
import { GuestExpiryNotice } from './ResourceQuickStart';

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
      {showFileSystem && (
        <Paper className="panel agent-first-start" withBorder p="xl">
          <IconFolder size={28} aria-hidden />
          <div>
            <Heading level={2}>Start with a place for your files</Heading>
            <Text>
              Create a file system, add your data, and choose what your agent can do with it.
            </Text>
          </div>
          <Group>
            <Button
              variant="filled"
              leftSection={<IconPlus size={18} />}
              onClick={() => onCreate('filesystem')}
            >
              Create file system
            </Button>
            <Button component="a" href="#connect" variant="default">
              Connect an agent
            </Button>
          </Group>
        </Paper>
      )}
      {showDatabase && (
        <Group className="agent-first-alternative">
          <Text>Need a database?</Text>
          <Button variant="subtle" onClick={() => onCreate('database')}>
            Create database
          </Button>
        </Group>
      )}
    </section>
  );
}
