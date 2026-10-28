import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Paper,
  Table,
  Text,
  Textarea,
} from '@tidbcloud/uikit';
import {
  workspaceApi,
  type FileAnalysisResult,
  type FileAnalysisCapabilities,
} from '../../api/client';
import { WorkspaceExecutionPanel } from '../../ui/WorkspaceExecutionPanel';
import { WorkspaceQueryResults, WorkspaceResultPanel } from '../../ui/WorkspaceQueryResults';
import { BashAnalysisHelp } from './BashAnalysisHelp';
import { bashInputPath, bashPreviewCommand, bashSamples } from './bash-analysis';
import './file-analysis.css';
const WorkspaceSqlInput = lazy(() => import('../sql/WorkspaceSqlInput'));
const sqlSample = 'SELECT * FROM file LIMIT 100;';
export default function FileAnalysisPanel({
  resourceId,
  path,
  onRunningChange,
  onExportSaved,
}: {
  resourceId: string;
  path: string;
  onRunningChange: (running: boolean) => void;
  onExportSaved: () => Promise<void>;
}) {
  const bashHelpId = useId();
  const [cap, setCap] = useState<FileAnalysisCapabilities | null>(null);
  const [script, setScript] = useState('');
  const [result, setResult] = useState<FileAnalysisResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const execution = useRef<AbortController | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    onRunningChange(busy);
  }, [busy, onRunningChange]);
  useEffect(() => () => onRunningChange(false), [onRunningChange]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    workspaceApi
      .fileAnalysisCapabilities(resourceId, path, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setCap(value);
          setScript(value.engine === 'duckdb' ? sqlSample : bashPreviewCommand);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Unable to check this file.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      execution.current?.abort();
    };
  }, [resourceId, path, revision]);
  async function run() {
    if (pending.current || !cap?.available || !cap.engine || !script.trim()) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setResult(null);
    const controller = new AbortController();
    execution.current = controller;
    try {
      const value = await workspaceApi.analyzeFile(
        cap.engine === 'duckdb'
          ? { resourceId, path, engine: 'duckdb', sql: script }
          : { resourceId, path, engine: 'bash', command: script },
        controller.signal,
      );
      if (!controller.signal.aborted) setResult(value);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'Analysis failed.');
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        pending.current = false;
      }
    }
  }
  function cancel() {
    execution.current?.abort();
    pending.current = false;
    setBusy(false);
    setError(cap?.engine === 'duckdb' ? 'Query canceled.' : 'Command canceled.');
  }
  function sample(value: string) {
    setScript(value);
    setResult(null);
    setError('');
  }
  if (loading)
    return (
      <Group>
        <Loader size="sm" />
        <Text>Checking file analysis…</Text>
      </Group>
    );
  const sql = cap?.engine === 'duckdb';
  const footnote = result
    ? `Completed in ${result.durationMs} ms · ${result.inputBytes.toLocaleString()} input bytes · Original file unchanged`
    : undefined;
  return (
    <div className="file-analysis workspace-tool">
      {!cap && error && (
        <Alert color="red" role="alert">
          {error}
          <Button
            ml="md"
            onClick={() => {
              setError('');
              setRevision((n) => n + 1);
            }}
          >
            Retry analysis setup
          </Button>
        </Alert>
      )}
      {cap && !cap.available && (
        <Alert color="yellow">{cap.reason} Use Download to open the file in another tool.</Alert>
      )}
      {cap?.available && (
        <>
          <WorkspaceExecutionPanel
            language={sql ? 'SQL' : 'Bash'}
            runLabel={sql ? 'Run query' : 'Run command'}
            cancelLabel={sql ? 'Cancel query' : 'Cancel command'}
            busy={busy}
            disabled={!script.trim()}
            onRun={() => void run()}
            onCancel={cancel}
            context={sql ? 'Read-only · Table: file' : 'Read-only · Saved file'}
            limits={
              <>
                One saved file · Fresh snapshot per run · Up to 16 MiB input · 15 seconds · 1 MiB
                output.
                {sql
                  ? ' SELECT only · Up to 1,000 rows. Query this file as the table file.'
                  : ' Just Bash runs supported text commands on one saved file at /workspace/input.log, with working directory /workspace. Other Workspace paths, writes, network access and native programs are unavailable.'}
              </>
            }
            samples={
              sql
                ? [
                    { label: 'Preview rows', value: sqlSample },
                    { label: 'Count rows', value: 'SELECT COUNT(*) AS row_count FROM file;' },
                  ]
                : bashSamples
            }
            onSample={sample}
          >
            {sql ? (
              <Suspense
                fallback={
                  <div className="editor-loading">
                    <Loader />
                    <Text>Loading SQL editor…</Text>
                  </div>
                }
              >
                <WorkspaceSqlInput
                  databaseId={'analysis:' + resourceId + path}
                  dialect="duckdb"
                  value={script}
                  onChange={setScript}
                  onRun={() => void run()}
                  disabled={busy}
                />
              </Suspense>
            ) : (
              <>
                <BashAnalysisHelp id={bashHelpId} busy={busy} onSample={sample} />
                <Textarea
                  aria-label="Bash command"
                  aria-describedby={bashHelpId}
                  className="workspace-command-input"
                  value={script}
                  onChange={(event) => setScript(event.currentTarget.value)}
                  disabled={busy}
                  spellCheck={false}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault();
                      void run();
                    }
                  }}
                  styles={{
                    input: {
                      fontFamily: 'var(--mantine-font-family-monospace)',
                      border: 0,
                      borderRadius: 0,
                      height: 'var(--workspace-sql-editor-height)',
                      padding: '12px 20px',
                    },
                  }}
                />
              </>
            )}
          </WorkspaceExecutionPanel>
          {sql ? (
            <WorkspaceQueryResults
              sourceResourceId={resourceId}
              onExportSaved={onExportSaved}
              result={result?.engine === 'duckdb' ? result : null}
              busy={busy}
              error={error}
              footnote={footnote}
            />
          ) : (
            <WorkspaceResultPanel
              badge={
                result?.engine === 'bash' && (
                  <Badge color={result.exitCode ? 'yellow' : 'green'}>Exit {result.exitCode}</Badge>
                )
              }
              footnote={footnote}
            >
              {error ? (
                <Alert className="workspace-result-message" color="red" role="alert" p="lg">
                  {error}
                </Alert>
              ) : result?.engine === 'bash' ? (
                <div className="analysis-command-result">
                  {result.exitCode !== 0 && /No such file or directory/.test(result.stderr) && (
                    <Alert color="yellow" title="Use the selected file’s input path" mb="md">
                      The selected file is mounted at <Code fz="inherit">{bashInputPath}</Code>. Its
                      original Workspace path is not mounted in Just Bash.
                      <Button variant="subtle" onClick={() => sample(bashPreviewCommand)} mt="sm">
                        Use a working preview command
                      </Button>
                    </Alert>
                  )}
                  <Text fw={600}>Standard output</Text>
                  <Paper withBorder p="md" component="pre" className="analysis-output">
                    {result.stdout || '(empty)'}
                  </Paper>
                  {result.stderr && (
                    <>
                      <Text fw={600}>Standard error</Text>
                      <Paper withBorder p="md" component="pre" className="analysis-output">
                        {result.stderr}
                      </Paper>
                    </>
                  )}
                </div>
              ) : (
                <Text className="workspace-result-message" role="status" p="lg" m={0}>
                  {busy ? 'Running command…' : 'Run a command to see its results here.'}
                </Text>
              )}
            </WorkspaceResultPanel>
          )}
          {result?.engine === 'duckdb' && (
            <Paper withBorder p="lg">
              <details>
                <summary>File columns ({result.schema.length})</summary>
                <div className="analysis-table">
                  <Table>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Column</Table.Th>
                        <Table.Th>Type</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {result.schema.map((column) => (
                        <Table.Tr key={column.column_name}>
                          <Table.Td>{column.column_name}</Table.Td>
                          <Table.Td>{column.column_type}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              </details>
            </Paper>
          )}
        </>
      )}
    </div>
  );
}
