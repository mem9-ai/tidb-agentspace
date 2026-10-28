import { Alert, Anchor, Button, Group, Popover, Stack, Text } from '@tidbcloud/uikit';
import { IconArrowLeft, IconArrowUpRight } from '@tidbcloud/uikit/icons';
import type { Resource } from '../../api/client';
import { Heading } from '../../ui/WorkspaceHeading';
import { ResourceWorkspaceBar, ResourceWorkspaceHeader } from '../../ui/ResourceWorkspaceHeader';
import { regionLabel } from '../resources/regions';

export function DatabaseWorkspaceHeader({
  database,
  databases,
  busy,
  onSelect,
  onConnect,
  onRetry,
}: {
  database: Resource;
  databases: Resource[];
  busy: boolean;
  onSelect: (id: string) => void;
  onConnect: () => void;
  onRetry: () => void;
}) {
  const provider =
    database.provider === 'db9-anonymous'
      ? 'PostgreSQL · db9'
      : database.provider === 'duckdb-drive9'
        ? 'DuckDB · Experimental'
        : database.provider === 'tidb-cloud-zero'
          ? 'MySQL · TiDB Cloud Zero'
          : 'MySQL · Local demo';
  const expiry = database.expiresAt ? new Date(database.expiresAt) : null;
  const live = ['tidb-cloud-zero', 'duckdb-drive9', 'db9-anonymous'].includes(
    database.provider || '',
  );
  return (
    <>
      <ResourceWorkspaceHeader
        title="Databases"
        description="Browse tables and query your databases."
        actions={
          <>
            <Button
              component="a"
              href="#databases"
              variant="subtle"
              leftSection={<IconArrowLeft size={18} />}
            >
              All databases
            </Button>
            <Popover width={340} position="bottom-end" withinPortal trapFocus returnFocus>
              <Popover.Target>
                <Button variant="subtle">Details</Button>
              </Popover.Target>
              <Popover.Dropdown maw="calc(100vw - 32px)">
                <Stack gap="sm">
                  <Heading level={2}>Database details</Heading>
                  <Text>{provider}</Text>
                  <Text>Region: {regionLabel(database.region)}</Text>
                  {database.kind === 'postgresql' && (
                    <Text>
                      db9 is PostgreSQL-compatible. NUMERIC supports up to 28–29 significant digits.{' '}
                      <Anchor
                        href="https://db9.ai/docs/sql/data-types/"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Data type compatibility
                      </Anchor>
                    </Text>
                  )}
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
          </>
        }
      />
      <ResourceWorkspaceBar
        resource={database}
        resources={databases}
        label="Database"
        description={provider}
        live={live}
        mode={live ? 'Live' : 'Local demo'}
        disabled={busy}
        onSelect={onSelect}
      >
        {expiry && (
          <span>
            Expires {expiry.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </span>
        )}
      </ResourceWorkspaceBar>
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
            {(database.status === 'provisioning' ||
              (database.provider === 'db9-anonymous' && database.status === 'failed')) && (
              <Button onClick={onRetry}>
                {database.status === 'failed' ? 'Recover database' : 'Retry setup'}
              </Button>
            )}
          </Group>
        </Alert>
      )}
    </>
  );
}
