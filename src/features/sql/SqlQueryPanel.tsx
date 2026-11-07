import type { QueryResult } from '../../api/client';
import React, { lazy, Suspense, useRef, useState } from 'react';
import { Alert, Loader, Text } from '@tidbcloud/uikit';
import { WorkspaceExecutionPanel } from '../../ui/WorkspaceExecutionPanel';
import { WorkspaceQueryResults } from '../../ui/WorkspaceQueryResults';
const WorkspaceSqlInput = lazy(() => import('./WorkspaceSqlInput'));
type DatabaseResource = {
  id: string;
  name: string;
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
  readBusyReason?: string;
  execute: (sql: string) => Promise<QueryResult>;
  onComplete: () => Promise<void>;
  onExportSaved: () => Promise<void>;
};
export function SqlQueryPanel({
  sql,
  onSqlChange: setSql,
  onRunStart,
  onRunningChange,
  renderResults,
  database,
  readBusy,
  readBusyReason,
  execute,
  onComplete,
  onExportSaved,
}: Props) {
  const live = database.provider === 'db9-anonymous';
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const running = useRef(false);
  async function run() {
    if (running.current || readBusy || database.status !== 'active' || !sql.trim()) return;
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
  const samples = [
    ...(live
      ? [
          {
            label: 'List tables',
            value:
              "SELECT table_name FROM information_schema.tables WHERE table_schema = 'workspace';",
          },
        ]
      : []),
    { label: 'Test connection', value: 'SELECT 1 AS connected;' },
    {
      label: live ? 'Server time' : 'Read agent events',
      value: live
        ? 'SELECT CURRENT_TIMESTAMP AS current_time;'
        : 'SELECT * FROM agent_events LIMIT 10;',
    },
  ];
  return (
    <div className="workspace-tool">
      {readBusyReason && (
        <Alert color="peacock" role="status">
          {readBusyReason} You can run SQL when this finishes.
        </Alert>
      )}
      <WorkspaceExecutionPanel
        busy={busy}
        disabled={readBusy || !database.id || database.status !== 'active' || !sql.trim()}
        onRun={() => void run()}
        context={live ? 'Live · Writes change data' : 'Demo · Sample data only'}
        samples={samples}
        onSample={setSql}
        limits={
          live
            ? 'One statement at a time · 1,000 rows / 1 MiB · 15-second timeout. Writes change real data.'
            : 'This resource is not connected to a cloud database. Supports SELECT 1 and SELECT * FROM agent_events LIMIT n.'
        }
      >
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
            dialect="postgresql"
            value={sql}
            onChange={setSql}
            onRun={() => void run()}
            disabled={busy}
          />
        </Suspense>
      </WorkspaceExecutionPanel>
      {notice && <Alert color="yellow">{notice}</Alert>}
      {renderResults(
        <WorkspaceQueryResults
          result={result}
          busy={busy}
          error={error}
          sourceResourceId={database.id}
          onExportSaved={onExportSaved}
          footnote={
            result?.mode === 'live'
              ? `Statement completed in ${result.durationMs} ms.${result.columns.length ? '' : ` ${result.affectedRows ?? 0} rows affected.`}`
              : 'Demo query completed. Results are sample data.'
          }
        />,
      )}
    </div>
  );
}
