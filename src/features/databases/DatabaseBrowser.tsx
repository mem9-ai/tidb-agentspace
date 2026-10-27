import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Loader,
  NavLink,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
} from '@tidbcloud/uikit';
import { IconCode02, IconRefreshCw01, IconSearchLg } from '@tidbcloud/uikit/icons';
import { workspaceApi, type Resource, type TableDetail } from '../../api/client';
import { ChoiceTabs } from '../../ui/ChoiceTabs';
import { Heading } from '../../ui/WorkspaceHeading';
import { databaseEditorHash, databaseTablesHash } from '../navigation/workspace-route';
import './database-browser.css';

function useRead<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({
    loading: true,
  });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true });
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data, loading: false });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            error:
              error instanceof Error ? error.message : 'Could not load the database. Try again.',
            loading: false,
          });
      },
    );
    return () => controller.abort();
  }, [load, revision]);
  return { ...state, retry: () => setRevision((value) => value + 1) };
}
function Loading({ children }: { children: string }) {
  return (
    <div className="database-loading" role="status">
      <Loader size="sm" />
      <Text>{children}</Text>
    </div>
  );
}
function Failure({ message, retry }: { message: string; retry: () => void }) {
  return (
    <Alert color="red" title="Unable to load">
      <Text>{message}</Text>
      <Button mt="md" onClick={retry}>
        Try again
      </Button>
    </Alert>
  );
}
function Columns({ detail }: { detail: TableDetail }) {
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Table columns">
      <Table>
        <Table.Thead>
          <Table.Tr>
            {['Column', 'Type', 'Nullable', 'Default', 'Key', 'Extra'].map((value) => (
              <Table.Th key={value}>{value}</Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {detail.columns.map((column) => (
            <Table.Tr key={column.name}>
              <Table.Td>
                <code>{column.name}</code>
              </Table.Td>
              <Table.Td>
                <code>{column.type}</code>
              </Table.Td>
              <Table.Td>{column.nullable ? 'Yes' : 'No'}</Table.Td>
              <Table.Td>
                <code>
                  {column.default === null ? 'NULL / none' : JSON.stringify(column.default)}
                </code>
              </Table.Td>
              <Table.Td>{column.key || '—'}</Table.Td>
              <Table.Td>{column.extra || '—'}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}
function Indexes({ detail }: { detail: TableDetail }) {
  if (!detail.indexes.length)
    return <Text>No indexes on this {detail.type === 'VIEW' ? 'view' : 'table'}.</Text>;
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Table indexes">
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Index</Table.Th>
            <Table.Th>Unique</Table.Th>
            <Table.Th>Columns in order</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {detail.indexes.map((index) => (
            <Table.Tr key={index.name}>
              <Table.Td>
                <code>{index.name}</code>
              </Table.Td>
              <Table.Td>{index.unique ? 'Yes' : 'No'}</Table.Td>
              <Table.Td>
                {index.columns
                  .map(
                    (part) =>
                      `${part.name ?? '(expression)'}${part.prefixLength === null ? '' : ` (${part.prefixLength})`}`,
                  )
                  .join(', ')}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}
function Rows({ resourceId, name }: { resourceId: string; name: string }) {
  const load = useCallback(
    (signal: AbortSignal) => workspaceApi.tableRows(resourceId, name, signal),
    [resourceId, name],
  );
  const rows = useRead(load);
  return (
    <div className="database-data">
      <div className="database-section-header">
        <Text>Up to 100 rows · Unordered preview</Text>
        <Button
          disabled={rows.loading}
          onClick={rows.retry}
          leftSection={<IconRefreshCw01 size={18} />}
        >
          Refresh data
        </Button>
      </div>
      {rows.loading ? (
        <Loading>Loading data…</Loading>
      ) : rows.error ? (
        <>
          <Failure message={rows.error} retry={rows.retry} />
          <Text>For large rows, open SQL Editor and select fewer columns or rows.</Text>
        </>
      ) : (
        rows.data && (
          <>
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Table data">
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    {rows.data.columns.map((column) => (
                      <Table.Th key={column}>{column}</Table.Th>
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.data.rows.map((row, index) => (
                    <Table.Tr key={index}>
                      {rows.data?.columns.map((column) => (
                        <Table.Td key={column}>
                          <code className="database-cell">
                            {row[column] === null
                              ? 'NULL'
                              : typeof row[column] === 'object'
                                ? JSON.stringify(row[column])
                                : String(row[column])}
                          </code>
                        </Table.Td>
                      ))}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
            <Text c="carbon.7">
              {rows.data.rowCount
                ? `${rows.data.rowCount} rows shown. This is a sample, not a total row count.`
                : 'This table is empty.'}
            </Text>
          </>
        )
      )}
    </div>
  );
}
function TableContent({ resourceId, name }: { resourceId: string; name: string }) {
  const load = useCallback(
    (signal: AbortSignal) => workspaceApi.table(resourceId, name, signal),
    [resourceId, name],
  );
  const detail = useRead(load);
  const [tab, setTab] = useState('Columns');
  return (
    <Paper className="panel database-detail" p="xl" withBorder>
      <Stack gap="xl">
        <div className="database-section-header">
          <div>
            <Heading level={2}>{name}</Heading>
            {detail.data && (
              <Text c="carbon.7">
                {detail.data.type === 'VIEW' ? 'View' : 'Table'} · {detail.data.columns.length}{' '}
                columns · {detail.data.indexes.length}{' '}
                {detail.data.indexes.length === 1 ? 'index' : 'indexes'}
              </Text>
            )}
          </div>
          <Button
            variant="filled"
            leftSection={<IconCode02 size={18} />}
            onClick={() => {
              location.hash = databaseEditorHash(resourceId, name);
            }}
          >
            Query table
          </Button>
        </div>
        {detail.loading ? (
          <Loading>Loading table structure…</Loading>
        ) : detail.error ? (
          <Failure message={detail.error} retry={detail.retry} />
        ) : (
          detail.data && (
            <ChoiceTabs value={tab} onChange={setTab} options={['Columns', 'Indexes', 'Data']}>
              {tab === 'Columns' ? (
                <Columns detail={detail.data} />
              ) : tab === 'Indexes' ? (
                <Indexes detail={detail.data} />
              ) : (
                <Rows resourceId={resourceId} name={name} />
              )}
            </ChoiceTabs>
          )
        )}
      </Stack>
    </Paper>
  );
}
export function DatabaseBrowser({
  database,
  tableName,
}: {
  database: Resource;
  tableName?: string;
}) {
  const load = useCallback(
    (signal: AbortSignal) => workspaceApi.tables(database.id, signal),
    [database.id],
  );
  const listing = useRead(load);
  const [search, setSearch] = useState('');
  const [revision, setRevision] = useState(0);
  const matches =
    listing.data?.data.filter((table) =>
      table.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    ) ?? [];
  return (
    <div className="database-browser">
      <Paper className="panel database-table-list" p="xl" withBorder>
        <Stack gap="xl">
          <div className="database-section-header">
            <Heading level={2}>Tables</Heading>
            <Badge>{listing.data?.data.length ?? '…'}</Badge>
          </div>
          <TextInput
            label="Find a table"
            placeholder="Search tables…"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            leftSection={<IconSearchLg size={18} />}
          />
          <Button
            onClick={() => {
              listing.retry();
              setRevision((value) => value + 1);
            }}
            disabled={listing.loading}
            leftSection={<IconRefreshCw01 size={18} />}
          >
            Refresh tables
          </Button>
          {database.provider !== 'tidb-cloud-zero' && <Badge>Local demo</Badge>}
          {listing.loading ? (
            <Loading>Loading tables…</Loading>
          ) : listing.error ? (
            <Failure message={listing.error} retry={listing.retry} />
          ) : (
            <>
              {listing.data?.truncated && (
                <Alert color="yellow">
                  Showing the first 500 tables. Use SQL Editor to find more.
                </Alert>
              )}
              {!matches.length && (
                <Text>
                  {listing.data?.data.length
                    ? 'No matching tables.'
                    : 'No tables yet. Create one in SQL Editor, then refresh.'}
                </Text>
              )}
              <nav aria-label="Database tables">
                {matches.map((table) => (
                  <NavLink
                    component="a"
                    key={table.name}
                    active={tableName === table.name}
                    href={databaseTablesHash(database.id, table.name)}
                    label={table.name}
                    description={table.type === 'VIEW' ? 'View' : undefined}
                  />
                ))}
              </nav>
            </>
          )}
        </Stack>
      </Paper>
      {tableName ? (
        <TableContent key={`${tableName}:${revision}`} resourceId={database.id} name={tableName} />
      ) : (
        <Paper className="panel database-detail" p="xl" withBorder>
          <Stack gap="xl">
            <Heading level={2}>Explore your database</Heading>
            <Text>Select a table to inspect its columns, indexes and data.</Text>
            <Button
              onClick={() => {
                location.hash = databaseEditorHash(database.id);
              }}
            >
              Open SQL editor
            </Button>
          </Stack>
        </Paper>
      )}
    </div>
  );
}
