import { Alert, Anchor, Badge, Button, Group, Paper, Table, Text } from '@tidbcloud/uikit';
import { IconArrowRight, IconDatabase01, IconFolder, IconPlus } from '@tidbcloud/uikit/icons';
import type { Resource } from '../../api/client';
import { WorkspacePageHeader } from '../../ui/WorkspacePageHeader';
import { WorkspaceEmptyState } from '../../ui/WorkspaceEmptyState';
import { ResourceKindIcon } from '../../ui/ResourceKindIcon';
import { ResourceConnectButton } from '../../ui/ResourceWorkspaceHeader';
import { resourceWorkspaceHref, resourceServiceLabel } from './resource-presentation';
import { resourceKindLabels } from './resource-creation';
import { regionLabel } from './regions';
import { GuestExpiryNotice, ResourceQuickStart } from './ResourceQuickStart';

export function ResourceCollectionPage({
  kind,
  resources,
  onCreate,
  onConnect,
  isGuest,
  hasMore,
  hasEarlier,
  loadingMore,
  pageError,
  onLoadMore,
  onRestart,
}: {
  kind: 'database' | 'filesystem';
  resources: Resource[];
  onCreate: () => void;
  onConnect: (resource: Resource) => void;
  isGuest: boolean;
  hasMore: boolean;
  hasEarlier: boolean;
  loadingMore: boolean;
  pageError: string;
  onLoadMore: () => Promise<void>;
  onRestart: () => Promise<void>;
}) {
  const files = kind === 'filesystem';
  const title = files ? 'File Systems' : 'Databases';
  const createLabel = files ? 'Create file system' : 'Create database';
  const create = (
    <Button variant="filled" leftSection={<IconPlus size={18} />} onClick={onCreate}>
      {createLabel}
    </Button>
  );
  return (
    <>
      <WorkspacePageHeader
        eyebrow="WORKSPACE RESOURCES"
        title={title}
        description={
          files
            ? 'Store files, preview their contents, and analyze your data.'
            : 'Store structured data, explore tables, and run SQL queries.'
        }
        actions={resources.length || hasMore || hasEarlier ? create : undefined}
      />
      {!resources.length && !hasMore && !hasEarlier ? (
        <Paper className="panel" withBorder>
          <WorkspaceEmptyState
            label={`${title} empty state`}
            headingLevel={2}
            icon={files ? IconFolder : IconDatabase01}
            title={files ? 'Create your first File System' : 'Create your first database'}
            description={
              files
                ? 'Upload a file to preview or analyze its contents.'
                : 'Add your data and run your first SQL query.'
            }
            details={
              <>
                {isGuest && <GuestExpiryNotice />}
                <ResourceQuickStart kind={kind} />
              </>
            }
            action={create}
          />
        </Paper>
      ) : (
        <Paper className="panel table-panel" withBorder>
          {hasEarlier && (
            <Text p="md" size="sm">
              Earlier resources are hidden to keep this page responsive.
            </Text>
          )}
          {!resources.length ? (
            <Text p="md">
              No {files ? 'File Systems' : 'databases'} in the loaded resources.
              {hasMore ? ' Load more to continue.' : ' Return to the first resources to continue.'}
            </Text>
          ) : (
            <Table aria-label={files ? 'File systems' : 'Databases'}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Region</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Service</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {resources.map((resource) => (
                  <Table.Tr key={resource.id}>
                    <Table.Td>
                      <div className="table-resource">
                        <ResourceKindIcon kind={resource.kind} small />
                        <div>
                          <Anchor fw={600} href={resourceWorkspaceHref(resource)}>
                            {resource.name}
                          </Anchor>
                          <small>
                            {resourceKindLabels[resource.kind]} · {resource.id}
                          </small>
                        </div>
                      </div>
                    </Table.Td>
                    <Table.Td>{regionLabel(resource.region)}</Table.Td>
                    <Table.Td>
                      <Badge
                        miw="max-content"
                        color={
                          resource.status === 'active'
                            ? 'green'
                            : resource.status === 'failed'
                              ? 'red'
                              : 'yellow'
                        }
                      >
                        {resource.status}
                      </Badge>
                      {resource.connectionError && (
                        <Text size="sm" c="red" mt="xs">
                          {resource.connectionError}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        miw="max-content"
                        color={
                          !resource.provider || resource.provider === 'local' ? 'carbon' : 'peacock'
                        }
                      >
                        {resourceServiceLabel(resource)}
                      </Badge>
                      {resource.expiresAt && (
                        <small>Expires {new Date(resource.expiresAt).toLocaleDateString()}</small>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Group gap="sm" wrap="nowrap">
                        <Button
                          component="a"
                          href={resourceWorkspaceHref(resource)}
                          aria-label={`Open ${resource.name}`}
                          rightSection={<IconArrowRight size={16} />}
                        >
                          Open
                        </Button>
                        <ResourceConnectButton
                          onClick={() => onConnect(resource)}
                          ariaLabel={`Connect to ${resource.name}`}
                        />
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
          {pageError && (
            <Alert color="red" mt="md">
              {pageError}
            </Alert>
          )}
          {(hasMore || hasEarlier) && (
            <Group justify="center" my="md">
              {hasEarlier && (
                <Button onClick={() => void onRestart()}>Back to first resources</Button>
              )}
              {hasMore && (
                <Button loading={loadingMore} onClick={() => void onLoadMore()}>
                  Load more resources
                </Button>
              )}
            </Group>
          )}
        </Paper>
      )}
    </>
  );
}
