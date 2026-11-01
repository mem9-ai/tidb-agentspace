import { Alert, Anchor, Button, Group, Text } from '@tidbcloud/uikit';
import { IconUpload01 } from '@tidbcloud/uikit/icons';
import type { Resource } from '../../api/client';
import {
  ResourceConnectButton,
  ResourceCollectionButton,
  ResourceDetails,
  ResourceWorkspaceBar,
  ResourceWorkspaceHeader,
  ResourceTutorialButton,
} from '../../ui/ResourceWorkspaceHeader';
import { regionLabel } from '../resources/regions';
import { resourceKindLabels } from '../resources/resource-creation';
import { tutorialHash } from '../navigation/workspace-route';

export function DatabaseWorkspaceHeader({
  database,
  databases,
  busy,
  onSelect,
  onConnect,
  onRetry,
  onImport,
  importDisabled,
}: {
  database: Resource;
  databases: Resource[];
  busy: boolean;
  onSelect: (id: string) => void;
  onConnect: () => void;
  onRetry: () => void;
  onImport: () => void;
  importDisabled: boolean;
}) {
  const provider =
    database.provider === 'db9-anonymous'
      ? 'PostgreSQL · db9'
      : database.provider === 'duckdb-drive9'
        ? 'DuckDB · Experimental'
        : database.provider === 'tidb-cloud-zero'
          ? 'MySQL · TiDB Cloud Zero'
          : `${resourceKindLabels[database.kind]} · Local demo`;
  const expiry = database.expiresAt ? new Date(database.expiresAt) : null;
  const live = ['tidb-cloud-zero', 'duckdb-drive9', 'db9-anonymous'].includes(
    database.provider || '',
  );
  return (
    <>
      <ResourceWorkspaceHeader
        title="Databases"
        actions={
          <>
            <ResourceCollectionButton
              label="All databases"
              onClick={() => {
                location.hash = 'databases';
              }}
              disabled={busy}
            />
            <ResourceDetails title="Database details">
              <Text>{provider}</Text>
              <Text>Status: {database.status}</Text>
              <Text>Workspace region: {regionLabel(database.regionId)}</Text>
              <Text>Provider data location: {regionLabel(database.region)}</Text>
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
            </ResourceDetails>
            <ResourceTutorialButton
              disabled={busy}
              onClick={() => {
                location.hash = tutorialHash(database.id);
              }}
            />
            <ResourceConnectButton onClick={onConnect} />
            <Button
              variant="filled"
              leftSection={<IconUpload01 size={18} />}
              disabled={busy || importDisabled || !live || database.status !== 'active'}
              title={
                !live || database.status !== 'active'
                  ? 'Import requires an active live database.'
                  : importDisabled
                    ? 'Wait for the database to finish loading.'
                    : undefined
              }
              onClick={onImport}
            >
              Import
            </Button>
          </>
        }
      >
        <ResourceWorkspaceBar
          resource={database}
          resources={databases}
          label="Database"
          live={live}
          mode={live ? 'Live' : 'Local demo'}
          disabled={busy}
          onSelect={onSelect}
        />
      </ResourceWorkspaceHeader>
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
