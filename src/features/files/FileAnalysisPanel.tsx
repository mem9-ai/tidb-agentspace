import { useEffect, useId, useState } from 'react';
import { Alert, Button, Group, Loader, SegmentedControl, Text } from '@tidbcloud/uikit';
import { workspaceApi, type FileAnalysisCapabilities } from '../../api/client';
import { FileAnalysisEditor } from './FileAnalysisEditor';
import './file-analysis.css';

type AnalysisEngine = NonNullable<FileAnalysisCapabilities['engine']>;

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
  const descriptionId = useId();
  const [cap, setCap] = useState<FileAnalysisCapabilities | null>(null);
  const [engine, setEngine] = useState<AnalysisEngine | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onRunningChange(busy);
  }, [busy, onRunningChange]);
  useEffect(() => () => onRunningChange(false), [onRunningChange]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setCap(null);
    workspaceApi
      .fileAnalysisCapabilities(resourceId, path, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setCap(value);
          setEngine(value.engine);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Unable to check this file.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [resourceId, path, revision]);
  if (loading)
    return (
      <Group>
        <Loader size="sm" />
        <Text>Checking file analysis…</Text>
      </Group>
    );
  if (!cap)
    return (
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
    );
  // An independently deployed older API still supplies the original default-engine fields.
  const options =
    cap.engines ??
    (cap.engine ? [{ engine: cap.engine, available: cap.available, reason: cap.reason }] : []);
  const selected = engine ?? options[0]?.engine;
  return (
    <div className="file-analysis">
      {options.length > 1 && (
        <div className="file-analysis-method">
          <Group gap="sm">
            <Text component="span" size="sm" fw={600}>
              Analyze with
            </Text>
            <SegmentedControl
              aria-label="Analysis method"
              aria-describedby={descriptionId}
              size="lg"
              value={selected}
              disabled={busy}
              data={options.map((option) => ({
                value: option.engine,
                label: option.engine === 'duckdb' ? 'DuckDB SQL' : 'Just Bash',
              }))}
              onChange={(value) => {
                const option = options.find((candidate) => candidate.engine === value);
                if (option && !busy) setEngine(option.engine);
              }}
            />
          </Group>
          <Text id={descriptionId} size="sm" c="carbon.7" mt="xs">
            {selected === 'duckdb'
              ? 'Query parsed rows and columns as table file. Use Just Bash to inspect the raw text.'
              : 'Process raw UTF-8 text with read-only commands. Use DuckDB SQL for CSV rows and columns; shell tools do not parse CSV quoting.'}
          </Text>
        </div>
      )}
      {options.length === 0 && (
        <Alert color="yellow">{cap.reason} Use Download to open the file in another tool.</Alert>
      )}
      {options.map((option) => (
        <div key={option.engine} hidden={selected !== option.engine}>
          <FileAnalysisEditor
            resourceId={resourceId}
            path={path}
            cap={option}
            onRunningChange={setBusy}
            onExportSaved={onExportSaved}
          />
        </div>
      ))}
    </div>
  );
}
