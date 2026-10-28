import type { QueryResult } from '../../api/client';
import React, { lazy, Suspense, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Loader,
  Menu,
  Popover,
  Paper,
  Table,
  Text,
} from '@tidbcloud/uikit';
import {
  IconPlay as Play,
  IconMaximize02,
  IconMinimize02,
  IconDownload01 as ArrowDownToLine,
  IconCheckCircle as CheckCircle2,
} from '@tidbcloud/uikit/icons';
import { Heading } from '../../ui/WorkspaceHeading';
const WorkspaceSqlInput = lazy(() => import('./WorkspaceSqlInput'));
type DatabaseResource = {
  id: string;
  name: string;
  kind: 'mysql' | 'postgresql' | 'duckdb' | 'filesystem';
  provider?: string;
  status: string;
};
type Props = {
  sql: string;
  onSqlChange: (sql: string) => void;
  onRunStart: () => void;
  onRunningChange: (running: boolean) => void;
  renderResults: (results: React.ReactNode) => React.ReactNode;
  database: DatabaseResource;
  readBusy: boolean;
  execute: (sql: string) => Promise<QueryResult>;
  onComplete: () => Promise<void>;
  onExport: (result: QueryResult) => void;
};
export function SqlQueryPanel({
  sql,
  onSqlChange: setSql,
  onRunStart,
  onRunningChange,
  renderResults,
  database,
  readBusy,
  execute,
  onComplete,
  onExport,
}: Props) {
  const resourceId = database.id;
  const live = ['tidb-cloud-zero', 'duckdb-drive9', 'db9-anonymous'].includes(
    database.provider || '',
  );
  const [busy, setBusy] = useState(false),
    [result, setResult] = useState<QueryResult | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const running = useRef(false);
  const [expanded, setExpanded] = useState(false);
  async function run() {
    if (running.current || readBusy || database.status !== 'active') return;
    running.current = true;
    setBusy(true);
    onRunningChange(true);
    onRunStart();
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
      setError(e instanceof Error ? e.message : 'Query failed.');
    } finally {
      running.current = false;
      setBusy(false);
      onRunningChange(false);
    }
  }
  const results = (
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
        <div className="table-scroll" role="region" aria-label="Query result data" tabIndex={0}>
          <Table verticalSpacing={12} stickyHeader>
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
          <Text>{busy ? 'Running query…' : 'Run a query to see its results here.'}</Text>
        </div>
      )}
    </Paper>
  );
  return (
    <>
      <Paper className={`panel sql-panel${expanded ? ' sql-panel-expanded' : ''}`} withBorder>
        <div className="sql-toolbar">
          <Heading level={2}>SQL Editor</Heading>
          <Button
            variant="filled"
            loading={busy}
            leftSection={<Play size={18} />}
            disabled={busy || readBusy || !resourceId || database.status !== 'active'}
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
            dialect={
              database.kind === 'duckdb'
                ? 'duckdb'
                : database.kind === 'postgresql'
                  ? 'postgresql'
                  : 'mysql'
            }
            value={sql}
            onChange={setSql}
            onRun={() => void run()}
            disabled={busy}
          />
        </Suspense>
        <div className="editor-bottom">
          <Text size="sm">
            {live ? 'Live SQL · Writes change data' : 'Local demo · Sample data only'}
          </Text>
          <div className="sql-editor-tools">
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <Button variant="subtle" disabled={busy}>
                  Samples
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {live && (
                  <Menu.Item
                    disabled={busy}
                    onClick={() =>
                      setSql(
                        database.kind === 'postgresql'
                          ? "SELECT table_name FROM information_schema.tables WHERE table_schema = 'workspace';"
                          : 'SHOW TABLES;',
                      )
                    }
                  >
                    List tables
                  </Menu.Item>
                )}
                <Menu.Item disabled={busy} onClick={() => setSql('SELECT 1 AS connected;')}>
                  Test connection
                </Menu.Item>
                <Menu.Item
                  disabled={busy}
                  onClick={() =>
                    setSql(
                      live
                        ? 'SELECT CURRENT_TIMESTAMP AS current_time;'
                        : 'SELECT * FROM agent_events LIMIT 10;',
                    )
                  }
                >
                  {live ? 'Server time' : 'Read agent events'}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
            <Popover width={320} position="bottom-end" withinPortal trapFocus returnFocus>
              <Popover.Target>
                <Button variant="subtle">Limits</Button>
              </Popover.Target>
              <Popover.Dropdown maw="calc(100vw - 32px)">
                <Text>
                  {live
                    ? 'One statement at a time · 1,000 rows / 1 MiB · 15-second timeout. Writes change real data.'
                    : 'This resource is not connected to a cloud database. Supports SELECT 1 and SELECT * FROM agent_events LIMIT n.'}
                </Text>
                <Text size="sm" mt="sm">
                  ⌘ / Ctrl + Enter to run
                </Text>
              </Popover.Dropdown>
            </Popover>
            <ActionIcon
              variant="subtle"
              size={48}
              aria-label={expanded ? 'Collapse editor' : 'Expand editor'}
              title={expanded ? 'Collapse editor' : 'Expand editor'}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <IconMinimize02 size={20} /> : <IconMaximize02 size={20} />}
            </ActionIcon>
          </div>
        </div>
      </Paper>
      {notice && <Alert color="yellow">{notice}</Alert>}
      {renderResults(results)}
    </>
  );
}
