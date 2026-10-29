import { Anchor, Badge, Button, Group, Paper, Table, Text } from '@tidbcloud/uikit';
import { IconArrowUpRight, IconFolder, IconPlus } from '@tidbcloud/uikit/icons';
import type { Resource } from '../../api/client';
import { Heading } from '../../ui/WorkspaceHeading';
import { ResourceKindIcon } from '../../ui/ResourceKindIcon';
import { regionLabel } from '../resources/regions';
import { fileSystemHash } from './file-location';

export function FileSystemsList({
  resources,
  onCreate,
  onConnect,
}: {
  resources: Resource[];
  onCreate: () => void;
  onConnect: (resource: Resource) => void;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">WORKSPACE RESOURCES</div>
          <Heading level={1}>File Systems</Heading>
          <Text component="p">Select a File System to browse, preview and analyze its files.</Text>
        </div>
        <div className="heading-actions">
          <Button variant="filled" leftSection={<IconPlus size={18} />} onClick={onCreate}>
            Create file system
          </Button>
        </div>
      </div>
      {!resources.length ? (
        <Paper className="panel" withBorder>
          <div className="empty">
            <IconFolder size={28} />
            <Heading level={3}>Create your first File System</Heading>
            <Text component="p">Keep agent context and outputs together in a File System.</Text>
          </div>
        </Paper>
      ) : (
        <Paper className="panel table-panel" withBorder>
          <Table aria-label="File systems">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>File System</Table.Th>
                <Table.Th>Region</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Provider</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {resources.map((resource) => (
                <Table.Tr key={resource.id}>
                  <Table.Td>
                    <div className="table-resource">
                      <ResourceKindIcon kind="filesystem" small />
                      <div>
                        <Anchor fw={600} href={fileSystemHash(resource.id)}>
                          {resource.name}
                        </Anchor>
                        <small>{resource.id}</small>
                      </div>
                    </div>
                  </Table.Td>
                  <Table.Td>{regionLabel(resource.region)}</Table.Td>
                  <Table.Td>
                    <Badge color={resource.status === 'active' ? 'green' : 'yellow'}>
                      {resource.status}
                    </Badge>
                    {resource.connectionError && (
                      <Text size="sm" c="red" mt="xs">
                        {resource.connectionError}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Badge color={resource.provider === 'drive9-anonymous' ? 'peacock' : 'carbon'}>
                      {resource.provider === 'drive9-anonymous'
                        ? 'Live · Anonymous trial'
                        : 'Local demo'}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Group gap="sm" wrap="nowrap">
                      <Button component="a" href={fileSystemHash(resource.id)}>
                        Open files
                      </Button>
                      <Button
                        onClick={() => onConnect(resource)}
                        rightSection={<IconArrowUpRight size={16} />}
                      >
                        Connect
                      </Button>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Paper>
      )}
    </>
  );
}
