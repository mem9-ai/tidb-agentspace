import { useReducer, useRef, useState } from 'react';
import { Button, Group, Paper, Stack, Text } from '@tidbcloud/uikit';
import { workspaceApi, type QueryResult, type Resource } from '../../api/client';
import { DatabaseWorkspaceHeader } from './DatabaseWorkspaceHeader';
import { ChoiceTabs } from '../../ui/ChoiceTabs';
import { WorkspaceModal } from '../../ui/WorkspaceModal';
import { Heading } from '../../ui/WorkspaceHeading';
import { SqlQueryPanel } from '../sql/SqlQueryPanel';
import {
  databaseEditorHash,
  tableSelectSql,
  type WorkspaceRoute,
} from '../navigation/workspace-route';
import { DatabaseTableList, TableInspector } from './DatabaseBrowser';
import { createQueryDraft, queryDraftReducer } from './query-draft';
import { useTableMetadata } from './use-table-metadata';

type Props = {
  database: Resource;
  databases: Resource[];
  routeLocation: WorkspaceRoute;
  refresh: () => Promise<void>;
  onSelect: (id: string) => void;
  onExport: (result: QueryResult) => void;
  onConnect: () => void;
  onRetry: () => void;
};
export function DatabaseWorkspace({
  database,
  databases,
  routeLocation,
  refresh,
  onSelect,
  onExport,
  onConnect,
  onRetry,
}: Props) {
  const { tableName } = routeLocation;
  const [draft, dispatch] = useReducer(
    queryDraftReducer,
    tableName
      ? tableSelectSql(
          tableName,
          database.kind === 'duckdb'
            ? 'duckdb'
            : database.kind === 'postgresql'
              ? 'postgresql'
              : 'mysql',
        )
      : ['tidb-cloud-zero', 'duckdb-drive9', 'db9-anonymous'].includes(database.provider || '')
        ? 'SELECT 1 AS connected;'
        : 'SELECT * FROM agent_events LIMIT 10;',
    createQueryDraft,
  );
  const [outputView, setOutputView] = useState(
    routeLocation.databaseView === 'tables' && tableName ? 'Table details' : 'Query results',
  );
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [listingBusy, setListingBusy] = useState(true);
  const [rowBusy, setRowBusy] = useState(false);
  const [browserCollapsed, setBrowserCollapsed] = useState(false);
  const [collapsedTable, setCollapsedTable] = useState<string | null>(null);
  const waitingForRead = busy || listingBusy || rowBusy;
  const metadata = useTableMetadata(database.id, tableName, revision, waitingForRead);
  const editor = useRef<HTMLDivElement>(null);
  const showEditor = () => {
    setOutputView('Query results');
    editor.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    editor.current
      ?.querySelector<HTMLElement>('[aria-label="SQL query"]')
      ?.focus({ preventScroll: true });
  };
  const queryTable = (name: string) => {
    setCollapsedTable(null);
    if (tableName !== name || routeLocation.databaseView !== 'sql') {
      location.hash = databaseEditorHash(database.id, name);
    }
    dispatch({
      type: 'queryTable',
      sql: tableSelectSql(
        name,
        database.kind === 'duckdb'
          ? 'duckdb'
          : database.kind === 'postgresql'
            ? 'postgresql'
            : 'mysql',
      ),
    });
    showEditor();
  };
  return (
    <>
      <DatabaseWorkspaceHeader
        database={database}
        databases={databases}
        busy={busy}
        onSelect={onSelect}
        onConnect={onConnect}
        onRetry={onRetry}
      />
      <div
        className="resource-workspace database-workspace"
        data-browser-collapsed={browserCollapsed || undefined}
      >
        <DatabaseTableList
          database={database}
          busy={busy}
          tableName={tableName}
          expandedTable={tableName !== collapsedTable ? tableName : undefined}
          metadata={metadata}
          waiting={waitingForRead}
          collapsed={browserCollapsed}
          onToggle={() => setBrowserCollapsed((value) => !value)}
          onSelect={(name) => {
            setCollapsedTable((current) => (tableName === name && current !== name ? name : null));
            setOutputView('Query results');
            if (tableName !== name || routeLocation.databaseView !== 'sql')
              location.hash = databaseEditorHash(database.id, name);
          }}
          onQuery={queryTable}
          onLoadingChange={setListingBusy}
          onRefresh={() => {
            setListingBusy(true);
            setRevision((value) => value + 1);
          }}
        />
        <div className="database-editor-area" ref={editor}>
          <SqlQueryPanel
            sql={draft.sql}
            onSqlChange={(sql) => dispatch({ type: 'edit', sql })}
            database={database}
            readBusy={database.kind === 'duckdb' && (listingBusy || metadata.loading || rowBusy)}
            execute={(sql) => workspaceApi.query({ resourceId: database.id, sql })}
            onComplete={refresh}
            onExport={onExport}
            onRunningChange={setBusy}
            onRunStart={() => setOutputView('Query results')}
            renderResults={(results) => (
              <ChoiceTabs
                panelSpacing={12}
                value={outputView}
                onChange={setOutputView}
                options={['Query results', 'Table details']}
              >
                {outputView === 'Query results' ? (
                  results
                ) : tableName && (listingBusy || busy) ? (
                  <Paper className="panel" p="xl" withBorder>
                    <Text>Loading database…</Text>
                  </Paper>
                ) : tableName ? (
                  <TableInspector
                    key={`${tableName}:${revision}`}
                    resourceId={database.id}
                    name={tableName}
                    busy={busy}
                    metadata={metadata}
                    onLoadingChange={setRowBusy}
                    onQuery={() => queryTable(tableName)}
                  />
                ) : (
                  <Paper className="panel" withBorder p="xl">
                    <Stack gap="lg">
                      <Heading level={2}>Explore your tables</Heading>
                      <Text>
                        Expand a table on the left to see its columns. Use Query table to prepare a
                        SELECT in SQL Editor, or choose this tab for indexes and data.
                      </Text>
                    </Stack>
                  </Paper>
                )}
              </ChoiceTabs>
            )}
          />
        </div>
        {draft.pendingSql !== null && (
          <WorkspaceModal
            title="Replace your query?"
            description="You have edited the current query. Keep it, or replace it with the selected table’s SELECT statement."
            onClose={() => dispatch({ type: 'cancel' })}
          >
            <Group justify="flex-end">
              <Button onClick={() => dispatch({ type: 'cancel' })}>Keep my query</Button>
              <Button
                variant="filled"
                onClick={() => {
                  dispatch({ type: 'replace' });
                  showEditor();
                }}
              >
                Replace query
              </Button>
            </Group>
          </WorkspaceModal>
        )}
      </div>
    </>
  );
}
