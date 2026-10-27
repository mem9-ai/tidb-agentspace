import React, { lazy, Suspense, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Loader,
  NativeSelect,
  Paper,
  Table,
  Text,
  UnstyledButton,
} from '@tidbcloud/uikit';
import {
  IconDatabase01 as Database,
  IconPlay as Play,
  IconStars01 as Sparkles,
  IconDownload01 as ArrowDownToLine,
  IconCheckCircle as CheckCircle2,
} from '@tidbcloud/uikit/icons';
import { Heading } from '../../ui/WorkspaceHeading';
const WorkspaceSqlInput = lazy(() => import('./WorkspaceSqlInput'));
type DatabaseResource = {
  id: string;
  name: string;
  kind: 'mysql' | 'postgresql' | 'filesystem';
  provider?: string;
};
const kindLabel = { mysql: 'MySQL', postgresql: 'PostgreSQL', filesystem: 'File System' };
export type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  mode: 'demo' | 'live';
  affectedRows?: number;
  durationMs: number;
};
type Props = {
  database: DatabaseResource;
  databases: DatabaseResource[];
  execute: (sql: string) => Promise<QueryResult>;
  onComplete: () => Promise<void>;
  onSelect: (id: string) => void;
  onExport: (result: QueryResult) => void;
};
export function SqlQueryPanel({
  database,
  databases,
  execute,
  onComplete,
  onSelect,
  onExport,
}: Props) {
  const dbs = databases;
  const resourceId = database.id;
  const live = database.provider === 'tidb-cloud-starter';
  const [sql, setSql] = useState(
      live ? 'SELECT 1 AS connected;' : 'SELECT * FROM agent_events LIMIT 10;',
    ),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<QueryResult | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const running = useRef(false);
  async function run() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setResult(null);
    try {
      setResult(await execute(sql));
      await onComplete().catch(() =>
        setNotice(
          'Statement completed, but the workspace summary could not refresh. Do not repeat the statement to refresh the page.',
        ),
      );
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Alert className="notice" color="peacock" icon={<Sparkles size={17} />}>
        <span>
          {live ? (
            'Queries run on your TiDB Cloud Starter database. Run one statement at a time; writes change real data. Results are limited to 1,000 rows / 1 MiB, with a 15-second timeout.'
          ) : (
            <>
              Local demo. Supports <code>SELECT 1</code> and{' '}
              <code>SELECT * FROM agent_events LIMIT n</code>. This resource is not connected to a
              cloud database.
            </>
          )}
        </span>
      </Alert>
      <Paper className="panel sql-panel" withBorder>
        <div className="sql-toolbar">
          <div className="inline-controls">
            <Database size={16} />
            <NativeSelect
              className="sql-database-select"
              aria-label="Database"
              value={resourceId}
              disabled={busy}
              onChange={(e) => onSelect(e.target.value)}
            >
              {dbs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {kindLabel[r.kind]}
                </option>
              ))}
            </NativeSelect>
            <Badge color={live ? 'green' : 'carbon'}>{live ? 'Live' : 'Demo'}</Badge>
          </div>
          <Button
            variant="filled"
            loading={busy}
            leftSection={<Play size={18} />}
            disabled={busy || !resourceId}
            onClick={run}
          >
            {busy ? 'Running…' : 'Run query'}
          </Button>
        </div>
        <Suspense
          fallback={
            <div className="editor-loading">
              <Loader size="md" />
              <Text>Loading SQL editor…</Text>
            </div>
          }
        >
          <WorkspaceSqlInput
            databaseId={database.id}
            protocol={database.kind}
            value={sql}
            onChange={setSql}
            onRun={() => void run()}
          />
        </Suspense>
        <div className="editor-bottom">
          <span>SQL · {kindLabel[database.kind]}</span>
          <span>⌘ / Ctrl + Enter to run</span>
        </div>
      </Paper>
      <div className="sample-queries">
        <span>Try a sample:</span>
        <UnstyledButton onClick={() => setSql('SELECT 1 AS connected;')}>
          Test connection
        </UnstyledButton>
        <UnstyledButton
          onClick={() =>
            setSql(
              live
                ? 'SELECT CURRENT_TIMESTAMP AS current_time;'
                : 'SELECT * FROM agent_events LIMIT 10;',
            )
          }
        >
          {live ? 'Server time' : 'Read agent events'}
        </UnstyledButton>
      </div>
      {notice && <Alert color="yellow">{notice}</Alert>}
      <Paper className="panel result-panel" withBorder>
        <div className="panel-header">
          <Heading level={2}>
            Results{' '}
            {result && (
              <Badge color="green">
                {result.columns.length
                  ? `${result.rowCount} rows`
                  : `${result.affectedRows ?? 0} affected`}
              </Badge>
            )}
          </Heading>
          {result && result.columns.length > 0 && (
            <Button
              leftSection={React.createElement(ArrowDownToLine, { size: 18 })}
              onClick={() => onExport(result)}
            >
              Export JSON
            </Button>
          )}
        </div>
        {error ? (
          <Alert className="inline-error" color="red">
            {error}
          </Alert>
        ) : result ? (
          <div className="table-scroll">
            <Table>
              <Table.Thead>
                <Table.Tr>
                  {result.columns.map((c: string) => (
                    <Table.Th key={c}>{c}</Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {result.rows.map((r: Record<string, unknown>, i: number) => (
                  <Table.Tr key={i}>
                    {result.columns.map((c: string) => (
                      <Table.Td key={c}>
                        <code>
                          {r[c] === null
                            ? 'NULL'
                            : typeof r[c] === 'object'
                              ? JSON.stringify(r[c])
                              : String(r[c])}
                        </code>
                      </Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <div className="result-footnote">
              <CheckCircle2 size={13} />{' '}
              {result.mode === 'live'
                ? `Statement completed in ${result.durationMs} ms.${result.columns.length ? '' : ` ${result.affectedRows ?? 0} rows affected.`}`
                : 'Demo query completed. Results are sample data.'}
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <Text>Run a query to see its results here.</Text>
          </div>
        )}
      </Paper>
    </>
  );
}
