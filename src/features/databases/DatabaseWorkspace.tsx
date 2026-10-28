import { useReducer, useRef, useState } from 'react';
import { Button, Group, Paper, Stack, Text } from '@tidbcloud/uikit';
import { workspaceApi, type QueryResult, type QuerySource, type Resource } from '../../api/client';
import { DuckdbSources } from './DuckdbSources';
import { DatabaseWorkspaceHeader } from './DatabaseWorkspaceHeader';
import { ChoiceTabs } from '../../ui/ChoiceTabs';
import { WorkspaceModal } from '../../ui/WorkspaceModal';
import { Heading } from '../../ui/WorkspaceHeading';
import { SqlQueryPanel } from '../sql/SqlQueryPanel';
import { tableSelectSql, type WorkspaceRoute } from '../navigation/workspace-route';
import { DatabaseTableList, TableInspector } from './DatabaseBrowser';
import { createQueryDraft, queryDraftReducer } from './query-draft';

type Props = {
  database: Resource;
  databases: Resource[];
  fileSystems: Resource[];
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
  fileSystems,
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
  const [inspectionBusy, setInspectionBusy] = useState(false);
  const [browserCollapsed, setBrowserCollapsed] = useState(false);
  const [sources, setSources] = useState<QuerySource[]>([]);
  const [sourceRevision, setSourceRevision] = useState(0);
  const editor = useRef<HTMLDivElement>(null);
  const showEditor = () => {
    setOutputView('Query results');
    editor.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    editor.current
      ?.querySelector<HTMLElement>('[aria-label="SQL query"]')
      ?.focus({ preventScroll: true });
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
          tableName={tableName}
          collapsed={browserCollapsed}
          onToggle={() => setBrowserCollapsed((value) => !value)}
          onSelect={() => setOutputView('Table details')}
          onLoadingChange={setListingBusy}
          onRefresh={() => {
            setListingBusy(true);
            setRevision((value) => value + 1);
          }}
        />
        <div className="database-editor-area" ref={editor}>
          <SqlQueryPanel
            fileSources={
              database.kind === 'duckdb' ? (
                <DuckdbSources
                  fileSystems={fileSystems}
                  sources={sources}
                  busy={busy}
                  onChange={(next) => {
                    setSources(next);
                    setSourceRevision((value) => value + 1);
                  }}
                  onQuery={(name) => {
                    dispatch({
                      type: 'queryTable',
                      sql: `SELECT * FROM files."${name}" LIMIT 100;`,
                    });
                    showEditor();
                  }}
                />
              ) : undefined
            }
            queryContext={`${sourceRevision}:${JSON.stringify(sources)}`}
            hasFileSources={sources.length > 0}
            sql={draft.sql}
            onSqlChange={(sql) => dispatch({ type: 'edit', sql })}
            database={database}
            readBusy={database.kind === 'duckdb' && (listingBusy || inspectionBusy)}
            execute={(sql, signal) =>
              workspaceApi.query(
                {
                  resourceId: database.id,
                  sql,
                  ...(sources.length ? { sources } : {}),
                },
                signal,
              )
            }
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
                    onLoadingChange={setInspectionBusy}
                    onQuery={() => {
                      dispatch({
                        type: 'queryTable',
                        sql: tableSelectSql(
                          tableName,
                          database.kind === 'duckdb'
                            ? 'duckdb'
                            : database.kind === 'postgresql'
                              ? 'postgresql'
                              : 'mysql',
                        ),
                      });
                      showEditor();
                    }}
                  />
                ) : (
                  <Paper className="panel" withBorder p="xl">
                    <Stack gap="lg">
                      <Heading level={2}>Explore your tables</Heading>
                      <Text>
                        Select a table on the left to inspect columns, indexes and data. Your SQL
                        stays in the editor.
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
