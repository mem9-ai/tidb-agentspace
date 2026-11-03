import { useCallback, useEffect, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Typography,
} from '@tidbcloud/uikit';
import { IconCode02, IconRefreshCw01, IconSearchLg, IconDatabase01 } from '@tidbcloud/uikit/icons';
import { workspaceApi, type Resource, type TableDetail, type TableList } from '../../api/client';
import { ChoiceTabs } from '../../ui/ChoiceTabs';
import { Heading } from '../../ui/WorkspaceHeading';
import { WorkspaceBrowserPanel } from '../../ui/WorkspaceBrowserPanel';
import { DatabaseTableItem } from './DatabaseTableItem';
import type { TableMetadata } from './use-table-metadata';
import { readDatabase } from './database-read';
import './database-browser.css';
import { tutorialHash } from '../navigation/workspace-route';

function useRead<T>(load: (signal: AbortSignal) => Promise<T>, refreshVersion = 0, initial?: T) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({
    data: initial,
    loading: !initial,
  });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (initial) {
      setState({ data: initial, loading: false });
      return;
    }
    const controller = new AbortController();
    setState({ loading: true });
    readDatabase(load, controller.signal).then(
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
  }, [load, revision, refreshVersion, initial]);
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
function Rows({
  resourceId,
  name,
  onLoadingChange,
}: {
  resourceId: string;
  name: string;
  onLoadingChange: (loading: boolean) => void;
}) {
  const load = useCallback(
    (signal: AbortSignal) => workspaceApi.tableRows(resourceId, name, signal),
    [resourceId, name],
  );
  const rows = useRead(load);
  useEffect(() => {
    onLoadingChange(rows.loading);
    return () => onLoadingChange(false);
  }, [rows.loading, onLoadingChange]);
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
export function TableInspector({
  resourceId,
  name,
  onQuery,
  busy,
  onLoadingChange,
  metadata,
}: {
  resourceId: string;
  name: string;
  onQuery: () => void;
  busy: boolean;
  onLoadingChange: (loading: boolean) => void;
  metadata: TableMetadata;
}) {
  const detail = metadata;
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
            onClick={onQuery}
            disabled={busy}
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
                <Rows resourceId={resourceId} name={name} onLoadingChange={onLoadingChange} />
              )}
            </ChoiceTabs>
          )
        )}
      </Stack>
    </Paper>
  );
}
export function DatabaseTableList({
  database,
  revision,
  busy,
  tableName,
  expandedTable,
  metadata,
  waiting,
  collapsed,
  onToggle,
  onSelect,
  onQuery,
  onRefresh,
  onLoadingChange,
  initialSnapshot,
}: {
  database: Resource;
  revision: number;
  busy: boolean;
  tableName?: string;
  expandedTable?: string;
  metadata: TableMetadata;
  waiting: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onSelect: (name: string) => void;
  onQuery: (name: string) => void;
  onRefresh: () => void;
  onLoadingChange: (loading: boolean) => void;
  initialSnapshot?: TableList;
}) {
  const load = useCallback(
    (signal: AbortSignal) => workspaceApi.tables(database.id, signal),
    [database.id],
  );
  const listing = useRead(load, revision, initialSnapshot);
  useEffect(() => {
    onLoadingChange(listing.loading);
  }, [listing.loading, onLoadingChange]);
  const [search, setSearch] = useState('');
  const matches =
    listing.data?.data.filter((table) =>
      table.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    ) ?? [];
  return (
    <WorkspaceBrowserPanel
      className="database-table-list"
      label="Table browser"
      railLabel="Tables"
      listLabel="Table list"
      collapsed={collapsed}
      onToggle={onToggle}
      heading={
        <Group gap="sm" wrap="nowrap">
          <IconDatabase01 size={20} aria-hidden />
          <Typography component="h2" variant="title-lg" fz={16}>
            Tables
          </Typography>
          <Badge>{listing.data?.data.length ?? '…'}</Badge>
        </Group>
      }
      toolbar={
        <>
          <TextInput
            aria-label="Find a table"
            placeholder="Filter tables…"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            leftSection={<IconSearchLg size={18} />}
          />
          <ActionIcon
            aria-label="Refresh tables"
            title="Refresh tables"
            onClick={() => {
              listing.retry();
              onRefresh();
            }}
            disabled={listing.loading || busy || waiting || metadata.loading}
          >
            <IconRefreshCw01 size={20} />
          </ActionIcon>
        </>
      }
    >
      <Stack gap="sm" p={8}>
        {initialSnapshot && (
          <>
            <Text size="sm">Tables when created. Load current tables to see later changes.</Text>
            <Button onClick={onRefresh} disabled={busy || waiting}>
              Load current tables
            </Button>
          </>
        )}
        {!['tidb-cloud-zero', 'duckdb-drive9', 'db9-anonymous'].includes(
          database.provider || '',
        ) && <Badge>Local demo</Badge>}
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
                  : initialSnapshot
                    ? 'No tables when created.'
                    : 'No tables yet. Try the sample orders, import a file, or create a table in SQL Editor.'}
              </Text>
            )}
            {!initialSnapshot &&
              !listing.data?.data.length &&
              database.status === 'active' &&
              !database.connectionError && (
                <Button
                  variant="filled"
                  disabled={busy || waiting}
                  onClick={() => {
                    location.hash = tutorialHash(database.id);
                  }}
                >
                  Try sample data
                </Button>
              )}
            <nav aria-label="Database tables">
              {matches.map((table) => (
                <DatabaseTableItem
                  key={table.name}
                  active={tableName === table.name}
                  expanded={expandedTable === table.name}
                  busy={busy}
                  waiting={waiting}
                  metadata={metadata}
                  onToggle={() => onSelect(table.name)}
                  onQuery={() => onQuery(table.name)}
                  name={table.name}
                  type={table.type}
                />
              ))}
            </nav>
          </>
        )}
      </Stack>
    </WorkspaceBrowserPanel>
  );
}
