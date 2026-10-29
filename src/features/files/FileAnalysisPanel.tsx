import { useEffect, useId, useState, type ReactNode } from 'react';
import { Alert, Button, Group, Loader, SegmentedControl, Text } from '@tidbcloud/uikit';
import { workspaceApi, type FileAnalysisCapabilities } from '../../api/client';
import { FileAnalysisEditor } from './FileAnalysisEditor';
import { IconChevronDown, IconChevronRight } from '@tidbcloud/uikit/icons';
import './file-analysis.css';

type AnalysisEngine = NonNullable<FileAnalysisCapabilities['engine']>;

export default function FileAnalysisPanel({
  resourceId,
  path,
  onRunningChange,
  onExportSaved,
  preview,
  expanded,
  onExpandedChange,
  blocked,
  previewVersion,
  onRefreshPreview,
  savedContent,
  onContentViewChange,
}: {
  savedContent: string;
  onContentViewChange: (view: 'preview' | 'result') => void;
  preview: ReactNode;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  blocked: boolean;
  previewVersion?: string;
  onRefreshPreview: () => void;
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
    setError('');
    workspaceApi
      .fileAnalysisCapabilities(resourceId, path, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setCap(value);
          setEngine((current) =>
            (value.engines ?? []).some((option) => option.engine === current)
              ? current
              : value.engine,
          );
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
  }, [resourceId, path, revision, savedContent]);
  if (loading && !cap)
    return (
      <>
        <div>{preview}</div>
        <Group p="md">
          <Loader size="sm" />
          <Text>Checking file analysis…</Text>
        </Group>
      </>
    );
  if (!cap)
    return (
      <>
        <div>{preview}</div>
        <Alert color="red" role="alert" m="md">
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
      </>
    );
  // An independently deployed older API still supplies the original default-engine fields.
  const options =
    cap.engines ??
    (cap.engine ? [{ engine: cap.engine, available: cap.available, reason: cap.reason }] : []);
  const selected = engine ?? options[0]?.engine;
  return (
    <div className="file-analysis">
      {error && (
        <Alert color="yellow" m="md">
          {error}
          <Button ml="md" onClick={() => setRevision((value) => value + 1)}>
            Retry analysis setup
          </Button>
        </Alert>
      )}
      {options.length > 0 && (
        <Group className="file-workspace-tool-toggle" justify="space-between">
          <Button
            variant="subtle"
            aria-expanded={expanded}
            aria-controls={[
              descriptionId + '-tools',
              ...options.map((option) => descriptionId + '-' + option.engine),
            ].join(' ')}
            leftSection={expanded ? <IconChevronDown size={18} /> : <IconChevronRight size={18} />}
            disabled={busy || blocked || loading || !!error}
            onClick={() => onExpandedChange(!expanded)}
          >
            {expanded
              ? 'Hide analysis tools'
              : selected === 'duckdb'
                ? 'Analyze with SQL'
                : 'Analyze with Bash'}
          </Button>
          <Text size="sm" c="carbon.7">
            Read-only analysis
          </Text>
        </Group>
      )}
      {blocked && (
        <Alert color="yellow" m="md">
          Save or discard your draft before analyzing the saved file.
        </Alert>
      )}
      <div id={descriptionId + '-tools'} hidden={!expanded}>
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
                disabled={busy || loading || !!error}
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
      </div>
      {options.length === 0 && <>{preview}</>}
      {options.length === 0 && expanded && (
        <Alert color="yellow">{cap.reason} Use Download to open the file in another tool.</Alert>
      )}
      {options.map((option) => (
        <div key={option.engine} hidden={selected !== option.engine}>
          <FileAnalysisEditor
            resourceId={resourceId}
            path={path}
            cap={option}
            editorId={descriptionId + '-' + option.engine}
            expanded={expanded}
            active={selected === option.engine}
            onContentViewChange={onContentViewChange}
            blocked={blocked || loading || !!error}
            preview={selected === option.engine ? preview : null}
            previewVersion={previewVersion}
            onRefreshPreview={onRefreshPreview}
            onRunningChange={setBusy}
            onExportSaved={onExportSaved}
          />
        </div>
      ))}
    </div>
  );
}
