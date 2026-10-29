import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Alert, Badge, Button, Code, Loader, Paper, Text, Textarea, Tabs } from '@tidbcloud/uikit';
import {
  workspaceApi,
  type FileAnalysisResult,
  type FileAnalysisCapabilities,
} from '../../api/client';
import { WorkspaceExecutionPanel } from '../../ui/WorkspaceExecutionPanel';
import { WorkspaceQueryResults, WorkspaceResultPanel } from '../../ui/WorkspaceQueryResults';
import { BashAnalysisHelp } from './BashAnalysisHelp';
import { legacyBashInput, bashPreviewCommand, bashSamples } from './bash-analysis';
import { isTabularFile } from './file-preview';
import './file-analysis.css';
const FileExportDialog = lazy(() =>
  import('../exports/FileExportDialog').then((module) => ({ default: module.FileExportDialog })),
);
const WorkspaceSqlInput = lazy(() => import('../sql/WorkspaceSqlInput'));
const sqlSample = 'SELECT * FROM file LIMIT 100;';
export function FileAnalysisEditor({
  resourceId,
  path,
  cap,
  onRunningChange,
  onExportSaved,
  preview,
  editorId,
  expanded,
  active,
  onContentViewChange,
  blocked,
  previewVersion,
  onRefreshPreview,
}: {
  preview: ReactNode;
  editorId: string;
  expanded: boolean;
  active: boolean;
  onContentViewChange: (view: 'preview' | 'result') => void;
  blocked: boolean;
  previewVersion?: string;
  onRefreshPreview: () => void;
  resourceId: string;
  path: string;
  cap: FileAnalysisCapabilities['engines'][number];
  onRunningChange: (running: boolean) => void;
  onExportSaved: () => Promise<void>;
}) {
  const bashHelpId = useId();
  const bashInput = cap.input ?? legacyBashInput;
  const previewCommand = bashPreviewCommand(bashInput.path);
  const [script, setScript] = useState(cap.engine === 'duckdb' ? sqlSample : previewCommand);
  const [result, setResult] = useState<FileAnalysisResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [contentView, setContentView] = useState<string | null>('preview');
  const [exportOpen, setExportOpen] = useState(false);
  const hasExecution = !!(result || busy || error);
  const visibleContentView = hasExecution ? contentView : 'preview';
  useEffect(() => {
    if (active) onContentViewChange(visibleContentView === 'result' ? 'result' : 'preview');
  }, [active, visibleContentView, onContentViewChange]);
  const execution = useRef<AbortController | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    onRunningChange(busy);
  }, [busy, onRunningChange]);
  useEffect(
    () => () => {
      execution.current?.abort();
      onRunningChange(false);
    },
    [onRunningChange],
  );
  async function run() {
    if (pending.current || blocked || !expanded || !cap.available || !script.trim()) return;
    pending.current = true;
    setBusy(true);
    setContentView('result');
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
    setError(cap.engine === 'duckdb' ? 'Query canceled.' : 'Command canceled.');
  }
  function sample(value: string) {
    setScript(value);
    setResult(null);
    setError('');
  }
  const sql = cap.engine === 'duckdb';
  const footnote = result
    ? `Completed in ${result.durationMs} ms · ${result.inputBytes.toLocaleString()} input bytes · Original file unchanged`
    : undefined;
  return (
    <div className="file-analysis workspace-tool">
      <div id={editorId} hidden={!expanded}>
        {!cap.available && (
          <Alert color="yellow">{cap.reason} Use Download to open the file in another tool.</Alert>
        )}
        {cap.available && (
          <>
            <WorkspaceExecutionPanel
              language={sql ? 'SQL' : 'Bash'}
              runLabel={sql ? 'Run query' : 'Run command'}
              cancelLabel={sql ? 'Cancel query' : 'Cancel command'}
              busy={busy}
              disabled={blocked || !script.trim()}
              onRun={() => void run()}
              onCancel={cancel}
              context={sql ? 'Read-only · Table: file' : 'Read-only · Saved file'}
              limits={
                <>
                  One saved file · Fresh snapshot per run · Up to 16 MiB input · 15 seconds · 1 MiB
                  output.
                  {sql ? (
                    ' SELECT only · Up to 1,000 rows. Query this file as the table file.'
                  ) : (
                    <>
                      {' '}
                      Just Bash runs supported text commands on the selected saved file at{' '}
                      <Code className="analysis-input-path" fz="inherit">
                        {bashInput.path}
                      </Code>
                      , with working directory{' '}
                      <Code fz="inherit">{bashInput.workingDirectory}</Code>. Other files, writes,
                      network access and native programs are unavailable.
                    </>
                  )}
                </>
              }
              samples={
                sql
                  ? [
                      { label: 'Preview rows', value: sqlSample },
                      { label: 'Count rows', value: 'SELECT COUNT(*) AS row_count FROM file;' },
                    ]
                  : bashSamples(bashInput.path, bashInput.fileVariable)
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
                    disabled={busy || blocked}
                  />
                </Suspense>
              ) : (
                <>
                  <BashAnalysisHelp
                    id={bashHelpId}
                    input={bashInput}
                    busy={busy}
                    onSample={sample}
                  />
                  <Textarea
                    aria-label="Bash command"
                    aria-describedby={bashHelpId}
                    className="workspace-command-input"
                    value={script}
                    onChange={(event) => setScript(event.currentTarget.value)}
                    disabled={busy || blocked}
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
          </>
        )}
      </div>
      {result?.fileVersion && previewVersion && result.fileVersion !== previewVersion && (
        <Alert color="yellow" title="File version changed" m="md">
          This result and the data preview use different saved versions. Refresh the preview, then
          rerun to compare the same data.
          <Button variant="subtle" onClick={onRefreshPreview} disabled={busy || blocked}>
            Refresh preview
          </Button>
        </Alert>
      )}
      <Tabs value={visibleContentView} onChange={setContentView} keepMounted>
        <Tabs.List
          px="md"
          hidden={!hasExecution}
          style={{ display: hasExecution ? undefined : 'none' }}
        >
          <Tabs.Tab value="preview">{isTabularFile(path) ? 'Data preview' : 'Preview'}</Tabs.Tab>
          <Tabs.Tab value="result">{sql ? 'Query result' : 'Command output'}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="preview">{preview}</Tabs.Panel>
        <Tabs.Panel value="result">
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
              actions={
                result?.engine === 'bash' && (
                  <Button disabled={busy} onClick={() => setExportOpen(true)}>
                    Export output
                  </Button>
                )
              }
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
                      The selected saved file is available at{' '}
                      <Code className="analysis-input-path" fz="inherit">
                        {bashInput.path}
                      </Code>
                      . Check the full path and quote spaces or special characters. Other files are
                      not mounted.
                      <Button variant="subtle" onClick={() => sample(previewCommand)} mt="sm">
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
        </Tabs.Panel>
      </Tabs>
      {exportOpen && result?.engine === 'bash' && (
        <Suspense fallback={<Loader aria-label="Loading output export" />}>
          <FileExportDialog
            source={{ kind: 'output', resourceId, stream: 'stdout', text: result.stdout }}
            sourcePath={path}
            outputStreams={{ stdout: result.stdout, stderr: result.stderr }}
            exitCode={result.exitCode}
            onClose={() => setExportOpen(false)}
            onSaved={onExportSaved}
          />
        </Suspense>
      )}
    </div>
  );
}
