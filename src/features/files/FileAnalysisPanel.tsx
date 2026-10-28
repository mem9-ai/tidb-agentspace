import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  Table,
  Text,
  Textarea,
} from '@tidbcloud/uikit';
import { Heading } from '../../ui/WorkspaceHeading';
import {
  workspaceApi,
  type FileAnalysisResult,
  type FileAnalysisCapabilities,
} from '../../api/client';
import './file-analysis.css';
const WorkspaceSqlInput = lazy(() => import('../sql/WorkspaceSqlInput'));
const sqlSample = 'SELECT * FROM file LIMIT 100;';
const bashSample = "grep -n 'ERROR' /workspace/input.log | head -20";
export default function FileAnalysisPanel({
  resourceId,
  path,
}: {
  resourceId: string;
  path: string;
}) {
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
    const controller = new AbortController();
    setLoading(true);
    workspaceApi
      .fileAnalysisCapabilities(resourceId, path, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setCap(value);
          setScript(value.engine === 'duckdb' ? sqlSample : bashSample);
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
    if (pending.current || !cap?.available || !cap.engine) return;
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
    setError('Analysis canceled.');
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
  return (
    <div className="file-analysis">
      <Group justify="space-between">
        <Heading level={3}>
          {cap?.engine === 'duckdb'
            ? 'DuckDB SQL'
            : cap?.engine === 'bash'
              ? 'Just Bash'
              : 'File analysis'}
        </Heading>
        <Badge color="peacock">Read only</Badge>
      </Group>
      <Text component="p">
        {cap?.engine === 'duckdb'
          ? 'Query the saved file as the table file. Each run uses a fresh snapshot.'
          : cap?.engine === 'bash'
            ? 'Search the saved text at /workspace/input.log. Commands run in an isolated interpreter.'
            : 'Analyze one saved file with read-only server-side tools.'}
      </Text>
      <Text c="carbon.7" size="sm">
        Runs on the Workspace server · Up to 16 MiB input · 15 seconds · 1 MiB output
      </Text>
      {error && (
        <Alert color="red" role="alert">
          {error}
        </Alert>
      )}
      {!cap && error && (
        <Button
          onClick={() => {
            setError('');
            setRevision((n) => n + 1);
          }}
        >
          Retry analysis setup
        </Button>
      )}
      {cap && !cap.available && (
        <Alert color="yellow">{cap.reason} Use Download to open the file in another tool.</Alert>
      )}
      {cap?.available && (
        <>
          {cap.engine === 'duckdb' ? (
            <Paper withBorder>
              <Suspense fallback={<Loader />}>
                <WorkspaceSqlInput
                  databaseId={'analysis:' + resourceId + path}
                  dialect="duckdb"
                  value={script}
                  onChange={setScript}
                  onRun={() => void run()}
                />
              </Suspense>
            </Paper>
          ) : (
            <Textarea
              label="Bash command"
              aria-label="Bash command"
              value={script}
              onChange={(e) => setScript(e.currentTarget.value)}
              minRows={4}
              autosize
              spellCheck={false}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void run();
                }
              }}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            />
          )}
          <Group>
            <Button
              variant="filled"
              loading={busy}
              disabled={busy || !script.trim()}
              onClick={() => void run()}
            >
              {busy ? 'Running…' : 'Run analysis'}
            </Button>
            {busy && <Button onClick={cancel}>Cancel analysis</Button>}
          </Group>
          <Group gap="xs">
            {cap.engine === 'duckdb' ? (
              <>
                <Button variant="subtle" onClick={() => sample(sqlSample)}>
                  Preview rows
                </Button>
                <Button
                  variant="subtle"
                  onClick={() => sample('SELECT COUNT(*) AS row_count FROM file;')}
                >
                  Count rows
                </Button>
              </>
            ) : (
              <>
                <Button variant="subtle" onClick={() => sample(bashSample)}>
                  Find errors
                </Button>
                <Button variant="subtle" onClick={() => sample('head -20 /workspace/input.log')}>
                  First lines
                </Button>
                <Button variant="subtle" onClick={() => sample('wc -l /workspace/input.log')}>
                  Count lines
                </Button>
              </>
            )}
          </Group>
        </>
      )}
      {result && (
        <>
          <Group justify="space-between">
            <Heading level={3}>Results</Heading>
            <Badge color="green">
              {result.engine === 'duckdb' ? `${result.rowCount} rows` : `Exit ${result.exitCode}`}
            </Badge>
          </Group>
          {result.engine === 'duckdb' ? (
            <>
              <div className="analysis-table">
                <Table>
                  <Table.Thead>
                    <Table.Tr>
                      {result.columns.map((c) => (
                        <Table.Th key={c}>{c}</Table.Th>
                      ))}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {result.rows.map((row, i) => (
                      <Table.Tr key={i}>
                        {result.columns.map((c) => (
                          <Table.Td key={c}>
                            {row[c] === null
                              ? 'NULL'
                              : typeof row[c] === 'object'
                                ? JSON.stringify(row[c])
                                : String(row[c])}
                          </Table.Td>
                        ))}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
              {!result.rowCount && <Text>No rows returned.</Text>}
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
                      {result.schema.map((c) => (
                        <Table.Tr key={c.column_name}>
                          <Table.Td>{c.column_name}</Table.Td>
                          <Table.Td>{c.column_type}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              </details>
            </>
          ) : (
            <>
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
            </>
          )}
          <Text c="carbon.7" size="sm">
            Completed in {result.durationMs} ms · {result.inputBytes.toLocaleString()} input bytes ·
            Original file unchanged
          </Text>
        </>
      )}
    </div>
  );
}
