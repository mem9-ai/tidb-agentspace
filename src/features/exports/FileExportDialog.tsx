import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Group, NativeSelect, Stack, Text } from '@tidbcloud/uikit';
import {
  workspaceApi,
  type FileExportInput,
  type FileExportOutput,
  type FileExportSource,
  type FileExportPreparation,
  type FileExportParsing,
} from '../../api/client';
import { WorkspaceApiError } from '../../api/transport';
import { WorkspaceModal } from '../../ui/WorkspaceModal';
import {
  ExportDestinationFields,
  useExportDestination,
  type DestinationKind,
} from './ExportDestinationFields';
import { ImportReview, type ReviewedField } from './ImportReview';
import { useSnapshotDownload } from './snapshot-download';
import { fileHash } from '../files/file-location';
import { databaseEditorHash } from '../navigation/workspace-route';
import './file-export.css';
export function FileExportDialog({
  source: initialSource,
  sourcePath,
  outputStreams,
  exitCode,
  size,
  onClose,
  onSaved,
  onDownloadOriginal,
}: {
  source: FileExportSource;
  sourcePath: string;
  outputStreams?: { stdout: string; stderr: string };
  exitCode?: number;
  size?: number;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  onDownloadOriginal?: () => void;
}) {
  const [kind, setKind] = useState<DestinationKind>('download');
  const [stream, setStream] = useState<'stdout' | 'stderr'>(
    initialSource.kind === 'output' ? initialSource.stream : 'stdout',
  );
  const source: FileExportSource =
    initialSource.kind === 'output'
      ? { ...initialSource, stream, text: outputStreams?.[stream] ?? initialSource.text }
      : initialSource;
  const basename = sourcePath.split('/').pop() || 'file';
  const parent = sourcePath.slice(0, sourcePath.lastIndexOf('/'));
  const [resourceId, setResourceId] = useState('');
  const [path, setPath] = useState(
    source.kind === 'original'
      ? `${parent}/${basename.replace(/(\.[^.]+)?$/, '-copy$1')}`
      : `${parent}/${basename}.stdout.txt`,
  );
  const [table, setTable] = useState(
    'imported_' +
      basename
        .replace(/\.[^.]+$/, '')
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .slice(0, 35),
  );
  const [format, setFormat] = useState<'csv' | 'parquet' | 'lines'>(
    source.kind === 'original' && /\.parquet$/i.test(sourcePath)
      ? 'parquet'
      : source.kind === 'original' && /\.csv$/i.test(sourcePath)
        ? 'csv'
        : 'lines',
  );
  const [header, setHeader] = useState(true),
    [delimiter, setDelimiter] = useState<',' | '\t' | ';' | '|'>(',');
  const [review, setReview] = useState<FileExportPreparation | null>(null),
    [fields, setFields] = useState<ReviewedField[]>([]);
  const [busy, setBusy] = useState<'parse' | 'export' | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [outcome, setOutcome] = useState<FileExportOutput | null>(null);
  const pending = useRef(false),
    controller = useRef<AbortController | null>(null);
  const reviewSection = useRef<HTMLDivElement | null>(null);
  const destinationState = useExportDestination(kind, resourceId);
  const download = useSnapshotDownload();
  const outputText = source.kind === 'output' ? source.text : '';
  const bytes = useMemo(
    () => (source.kind === 'output' ? new TextEncoder().encode(outputText).length : size),
    [source.kind, outputText, size],
  );
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (review) {
      reviewSection.current?.scrollIntoView({ block: 'start' });
      reviewSection.current?.focus({ preventScroll: true });
    }
  }, [review]);
  function invalidate() {
    setReview(null);
    setFields([]);
    setError('');
  }
  async function parse() {
    if (pending.current) return;
    pending.current = true;
    setBusy('parse');
    setError('');
    setReview(null);
    const abort = new AbortController();
    controller.current = abort;
    const parsing: FileExportParsing =
      format === 'csv' ? { format, header, delimiter } : { format };
    try {
      const value = await workspaceApi.prepareFileExport({ source, parsing }, abort.signal);
      if (!abort.signal.aborted) {
        setReview(value);
        setFields(value.fields.map((field) => ({ ...field, selected: true })));
      }
    } catch (cause) {
      if (!abort.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'Parsing failed.');
    } finally {
      if (!abort.signal.aborted) {
        pending.current = false;
        setBusy(null);
      }
    }
  }
  function cancelParse() {
    controller.current?.abort();
    pending.current = false;
    setBusy(null);
    setError('Parsing canceled.');
  }
  async function submit() {
    if (pending.current) return;
    if (kind === 'download' && source.kind === 'original') {
      onDownloadOriginal?.();
      onClose();
      return;
    }
    let input: FileExportInput;
    if (kind === 'database') {
      if (!review) return;
      input = {
        preparationId: review.preparationId,
        confirmed: true,
        fields: fields
          .filter((field) => field.selected)
          .map(({ source, name, type }) => ({ source, name, type })),
        target: { kind, resourceId, table },
      };
    } else if (kind === 'filesystem') {
      if (source.kind === 'original') input = { source, target: { kind, resourceId, path } };
      else input = { source, target: { kind, resourceId, path } };
    } else if (source.kind === 'output') input = { source, target: { kind: 'download' } };
    else return;
    pending.current = true;
    setBusy('export');
    setError('');
    setNotice('');
    try {
      const value = await workspaceApi.exportFileContent(input);
      if (value.kind === 'download') {
        download.start(value.content, value.mimeType, value.filename);
      } else {
        try {
          await onSaved();
        } catch {
          setNotice('Export saved. Refresh the destination to see it; do not repeat the export.');
        }
      }
      setOutcome(value);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Export failed.';
      const uncertain = !(cause instanceof WorkspaceApiError) || cause.status >= 500;
      setError(
        kind !== 'download' && uncertain && !/inspect|before repeating/i.test(message)
          ? `${message} The write may have completed. Inspect the destination before retrying.`
          : message,
      );
      if (
        kind === 'database' &&
        (uncertain ||
          (cause instanceof WorkspaceApiError &&
            ['IMPORT_ALREADY_COMMITTED', 'IMPORT_PREPARATION_UNAVAILABLE', 'FILE_CHANGED'].includes(
              cause.code || '',
            )))
      ) {
        setReview(null);
        setFields([]);
      }
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }
  const invalidDestination =
    kind !== 'download' &&
    (destinationState.loading ||
      !!destinationState.loadError ||
      !destinationState.destination ||
      !(kind === 'filesystem' ? path.trim() : table.trim()));
  const destinationUrl =
    outcome?.kind === 'filesystem'
      ? fileHash(outcome.resourceId, outcome.path, 'preview')
      : outcome?.kind === 'database'
        ? databaseEditorHash(outcome.resourceId, outcome.table)
        : undefined;
  return (
    <WorkspaceModal
      title={source.kind === 'original' ? 'Export original file' : 'Export command output'}
      size={kind === 'database' && review ? 900 : 560}
      busy={!!busy}
      onClose={onClose}
    >
      <Stack gap="lg">
        <div className="file-export-source">
          <Text fw={600}>
            {source.kind === 'original'
              ? 'Original file'
              : stream === 'stdout'
                ? 'Standard output'
                : 'Standard error'}{' '}
            · {basename}
          </Text>
          <Text size="sm" c="carbon.7">
            {bytes?.toLocaleString()} bytes
            {source.kind === 'output'
              ? ` · Last completed command · Exit ${exitCode ?? 0} · The command will not run again.`
              : ' · Saved original; copies preserve its bytes.'}
          </Text>
        </div>
        {source.kind === 'output' && outputStreams && (
          <NativeSelect
            label="Output stream"
            value={stream}
            disabled={!!busy || !!outcome}
            data={[
              { value: 'stdout', label: 'Standard output' },
              { value: 'stderr', label: 'Standard error' },
            ]}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === 'stdout' || value === 'stderr') {
                setStream(value);
                setPath((current) => current.replace(/\.(stdout|stderr)\.txt$/, `.${value}.txt`));
                invalidate();
              }
            }}
          />
        )}
        {outcome ? (
          <>
            <Alert
              color="green"
              title={outcome.kind === 'download' ? 'Download ready' : 'Export saved'}
            >
              {outcome.kind === 'download'
                ? outcome.filename
                : outcome.kind === 'filesystem'
                  ? outcome.path
                  : outcome.table}
              {outcome.kind === 'database' && (
                <Text mt="xs">{outcome.rowCount} rows imported.</Text>
              )}
            </Alert>
            {notice && <Alert color="yellow">{notice}</Alert>}
            <Group justify="flex-end">
              <Button onClick={onClose}>Done</Button>
              {outcome.kind === 'download' && (
                <Button
                  component="a"
                  href={download.url}
                  download={outcome.filename}
                  variant="filled"
                >
                  Download output
                </Button>
              )}
              {destinationUrl && (
                <Button component="a" variant="filled" href={destinationUrl} onClick={onClose}>
                  {outcome.kind === 'filesystem' ? 'Open file' : 'Open table'}
                </Button>
              )}
            </Group>
          </>
        ) : (
          <>
            <ExportDestinationFields
              kind={kind}
              onKindChange={(value) => {
                setKind(value);
                setResourceId('');
                setError('');
              }}
              resourceId={resourceId}
              onResourceChange={(value) => {
                setResourceId(value);
                setError('');
              }}
              path={path}
              onPathChange={(value) => {
                setPath(value);
                setError('');
              }}
              table={table}
              onTableChange={(value) => {
                setTable(value);
                setError('');
              }}
              busy={!!busy}
              state={destinationState}
            />
            {kind === 'database' ? (
              <>
                <Text fw={600}>Parse and review before importing</Text>
                <NativeSelect
                  label="Input format"
                  value={format}
                  disabled={!!busy}
                  data={[
                    { value: 'csv', label: 'CSV' },
                    { value: 'lines', label: 'Text (one row per line)' },
                    ...(source.kind === 'original' ? [{ value: 'parquet', label: 'Parquet' }] : []),
                  ]}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (value === 'csv' || value === 'parquet' || value === 'lines') {
                      setFormat(value);
                      invalidate();
                    }
                  }}
                />
                {format === 'csv' && (
                  <Group align="flex-end">
                    <NativeSelect
                      label="Separator"
                      value={delimiter}
                      disabled={!!busy}
                      data={[
                        { value: ',', label: 'Comma' },
                        { value: '\t', label: 'Tab' },
                        { value: ';', label: 'Semicolon' },
                        { value: '|', label: 'Pipe' },
                      ]}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        if (value === ',' || value === '\t' || value === ';' || value === '|') {
                          setDelimiter(value);
                          invalidate();
                        }
                      }}
                    />
                    <Checkbox
                      label="First row contains column names"
                      checked={header}
                      disabled={!!busy}
                      onChange={(event) => {
                        setHeader(event.currentTarget.checked);
                        invalidate();
                      }}
                    />
                  </Group>
                )}
                <Text size="sm" c="carbon.7">
                  {format === 'csv'
                    ? 'CSV keeps strings such as 001; empty unquoted cells become NULL. Quoted empty strings stay empty.'
                    : format === 'lines'
                      ? 'Each text line becomes one row in a TEXT field. No CSV or JSON interpretation is assumed.'
                      : 'Reads the original Parquet data and schema, not its 20-row preview.'}{' '}
                  Up to 1,000 rows and 100 columns; larger inputs are rejected instead of partially
                  imported.
                </Text>
                <Group>
                  <Button onClick={() => void parse()} disabled={!!busy} loading={busy === 'parse'}>
                    {review ? 'Parse again' : 'Parse and review'}
                  </Button>
                  {busy === 'parse' && <Button onClick={cancelParse}>Cancel parsing</Button>}
                </Group>
                {review && (
                  <div ref={reviewSection} tabIndex={-1} className="import-review-focus">
                    <ImportReview
                      review={review}
                      fields={fields}
                      onChange={(value) => {
                        setFields(value);
                        setError('');
                      }}
                      busy={!!busy}
                    />
                    <Text size="sm" c="carbon.7" mt="md">
                      Review expires at {new Date(review.expiresAt).toLocaleTimeString()}. Parse
                      again if it expires before confirmation.
                    </Text>
                  </div>
                )}
              </>
            ) : (
              <Text size="sm" c="carbon.7">
                {source.kind === 'original'
                  ? 'The original file is downloaded or copied without parsing or conversion.'
                  : 'Exports the selected output stream exactly as text, without rerunning the command.'}
              </Text>
            )}
            {error && (
              <Alert color="red" title="Export could not finish" role="alert">
                {error}
              </Alert>
            )}
            {kind === 'database' && review && destinationState.destination && (
              <Text size="sm" className="file-export-source">
                Create {table || 'a new table'} in {destinationState.destination.name} from{' '}
                {source.kind === 'original'
                  ? 'the original file'
                  : stream === 'stdout'
                    ? 'standard output'
                    : 'standard error'}
                . {fields.filter((field) => field.selected).length} selected fields ·{' '}
                {review.rowCount} rows.
              </Text>
            )}
            <Group justify="flex-end" wrap="wrap">
              <Button disabled={!!busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="filled"
                loading={busy === 'export'}
                disabled={
                  !!busy ||
                  invalidDestination ||
                  (kind === 'database' && (!review || !fields.some((field) => field.selected)))
                }
                onClick={() => void submit()}
              >
                {kind === 'download'
                  ? source.kind === 'original'
                    ? 'Download original'
                    : 'Download output'
                  : kind === 'filesystem'
                    ? source.kind === 'original'
                      ? 'Copy original'
                      : 'Save output'
                    : 'Confirm and create table'}
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </WorkspaceModal>
  );
}
