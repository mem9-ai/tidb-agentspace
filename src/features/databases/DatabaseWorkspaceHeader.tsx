import { ActionIcon, Alert, Badge, Button, Group, Popover, Stack, Text } from '@tidbcloud/uikit';
import { IconArrowLeft, IconArrowUpRight } from '@tidbcloud/uikit/icons';
import type { Resource } from '../../api/client';
import { Heading } from '../../ui/WorkspaceHeading';
import { regionLabel } from '../resources/regions';

export function DatabaseWorkspaceHeader({
  database,
  onConnect,
  onRetry,
}: {
  database: Resource;
  onConnect: () => void;
  onRetry: () => void;
}) {
  const provider =
    database.provider === 'duckdb-drive9'
      ? 'DuckDB · Experimental'
      : database.provider === 'tidb-cloud-zero'
        ? 'MySQL · TiDB Cloud Zero'
        : 'MySQL · Local demo';
  const expiry = database.expiresAt ? new Date(database.expiresAt) : null;
  return (
    <>
      <header className="database-workspace-header">
        <Group gap="sm" wrap="nowrap" className="database-workspace-identity">
          <ActionIcon
            component="a"
            href="#databases"
            size={48}
            variant="subtle"
            aria-label="All databases"
            title="All databases"
          >
            <IconArrowLeft size={22} />
          </ActionIcon>
          <div>
            <Heading level={1}>{database.name}</Heading>
            <Text size="sm" c="carbon.7">
              {provider}
              {expiry && (
                <>
                  {' '}
                  · Expires{' '}
                  {expiry.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </>
              )}
            </Text>
          </div>
        </Group>
        <Group gap="sm" className="database-workspace-actions">
          {database.status !== 'active' && <Badge color="yellow">{database.status}</Badge>}
          <Popover width={340} position="bottom-end" withinPortal trapFocus returnFocus>
            <Popover.Target>
              <Button variant="subtle">Details</Button>
            </Popover.Target>
            <Popover.Dropdown maw="calc(100vw - 32px)">
              <Stack gap="sm">
                <Heading level={2}>Database details</Heading>
                <Text>{provider}</Text>
                <Text>Region: {regionLabel(database.region)}</Text>
                {expiry && (
                  <Text>
                    Temporary database · Expires {expiry.toLocaleString()}. Export important data
                    before expiry.
                  </Text>
                )}
                {database.kind === 'duckdb' && (
                  <Text>Persistent DuckDB with private backing storage.</Text>
                )}
              </Stack>
            </Popover.Dropdown>
          </Popover>
          <Button onClick={onConnect} rightSection={<IconArrowUpRight size={16} />}>
            Connect
          </Button>
        </Group>
      </header>
      {(database.connectionError ||
        database.status === 'expired' ||
        database.status === 'provisioning') && (
        <Alert color="yellow" mb="md">
          <Group justify="space-between">
            <Text>
              {database.connectionError ||
                (database.status === 'expired'
                  ? 'This temporary database has expired.'
                  : 'Database setup is incomplete.')}
            </Text>
            {database.status === 'provisioning' && <Button onClick={onRetry}>Retry setup</Button>}
          </Group>
        </Alert>
      )}
    </>
  );
}
