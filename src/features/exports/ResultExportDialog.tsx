import { useRef, useState } from 'react';
import { Alert, Button, Group, NativeSelect, Stack, Text } from '@tidbcloud/uikit';
import { IconDownload01 } from '@tidbcloud/uikit/icons';
import { workspaceApi, type ResultExportInput, type ResultExportOutput } from '../../api/client';
import { ExportDestinationFields, useExportDestination } from './ExportDestinationFields';
import { WorkspaceModal } from '../../ui/WorkspaceModal';
import { WorkspaceApiError } from '../../api/transport';
import { fileHash } from '../files/file-location';
import { databaseEditorHash } from '../navigation/workspace-route';
import { useSnapshotDownload } from './snapshot-download';

type TargetKind = ResultExportInput['target']['kind'];
type Format = 'csv' | 'json' | 'jsonl';
const formats = [
  { value: 'csv', label: 'CSV (.csv)' },
  { value: 'json', label: 'JSON (.json)' },
  { value: 'jsonl', label: 'JSON Lines (.jsonl)' },
];

export function ResultExportDialog({
  sourceResourceId,
  result,
  onClose,
  onSaved,
}: {
  sourceResourceId: string;
  result: ResultExportInput['result'];
  onClose: () => void;
  onSaved?: () => Promise<void> | void;
}) {
  const [kind, setKind] = useState<TargetKind>('download');
  const [format, setFormat] = useState<Format>('csv');
  const [resourceId, setResourceId] = useState('');
  const [stamp] = useState(() =>
    new Date().toISOString().replace(/[-:]/g, '').replace(/T/, '_').slice(0, 15),
  );
  const [path, setPath] = useState(`/query-results-${stamp}.csv`);
  const [table, setTable] = useState(`query_results_${stamp}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [outcome, setOutcome] = useState<ResultExportOutput | null>(null);
  const submitting = useRef(false);
  const destinationState = useExportDestination(kind, resourceId);
  const download = useSnapshotDownload();
  const { destination, loading, loadError } = destinationState;
  const action =
    kind === 'download' ? 'Download' : kind === 'filesystem' ? 'Save file' : 'Create table';
  async function submit() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const target: ResultExportInput['target'] =
        kind === 'download'
          ? { kind, format }
          : kind === 'filesystem'
            ? { kind, format, resourceId, path }
            : { kind, resourceId, table };
      const exported = await workspaceApi.exportResult({ sourceResourceId, result, target });
      if (exported.kind === 'download') {
        download.start(exported.content, exported.mimeType, exported.filename);
      }
      if (exported.kind !== 'download') {
        try {
          await onSaved?.();
        } catch {
          setNotice('Export saved. Refresh the destination to see it; do not repeat the export.');
        }
      }
      setOutcome(exported);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Export failed.';
      const uncertain = !(cause instanceof WorkspaceApiError) || cause.status >= 500;
      setError(
        kind !== 'download' && uncertain && !/inspect|before repeating a write/i.test(message)
          ? `${message} The write may have completed. Inspect the destination before retrying.`
          : message,
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const destinationUrl =
    outcome?.kind === 'filesystem'
      ? fileHash(outcome.resourceId, outcome.path, 'preview')
      : outcome?.kind === 'database'
        ? databaseEditorHash(outcome.resourceId, outcome.table)
        : undefined;
  return (
    <WorkspaceModal title="Export results" size={560} busy={busy} onClose={onClose}>
      <Stack gap="lg">
        <Text c="carbon.7">
          SQL result · {result.rows.length} {result.rows.length === 1 ? 'row' : 'rows'} from the
          current result. The query will not run again.
        </Text>
        {outcome ? (
          <>
            <Alert
              color="green"
              title={outcome.kind === 'download' ? 'Download ready' : 'Export saved'}
              role="status"
            >
              {outcome.kind === 'download'
                ? outcome.filename
                : outcome.kind === 'filesystem'
                  ? outcome.path
                  : outcome.table}
              {outcome.kind !== 'download' && (
                <Text size="sm" mt="xs">
                  {outcome.rowCount} {outcome.rowCount === 1 ? 'row' : 'rows'} exported to{' '}
                  {destination?.name}.
                </Text>
              )}
            </Alert>
            {notice && <Alert color="yellow">{notice}</Alert>}
            <Group justify="flex-end" wrap="wrap">
              <Button onClick={onClose}>Done</Button>
              {outcome.kind === 'download' && (
                <Button
                  component="a"
                  href={download.url}
                  download={outcome.filename}
                  variant="filled"
                >
                  Download results
                </Button>
              )}
              {destinationUrl && (
                <Button component="a" href={destinationUrl} variant="filled" onClick={onClose}>
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
              busy={busy}
              state={destinationState}
            >
              {kind !== 'database' && (
                <NativeSelect
                  label="Format"
                  value={format}
                  disabled={busy}
                  data={formats}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (value === 'csv' || value === 'json' || value === 'jsonl') {
                      setFormat(value);
                      setPath((current) => current.replace(/\.(csv|jsonl?)$/, `.${value}`));
                      setError('');
                    }
                  }}
                />
              )}
            </ExportDestinationFields>
            <Text size="sm" c="carbon.7">
              {kind === 'database'
                ? 'Numbers and booleans keep their types. Strings, dates and nested values use text. Keys and indexes are not copied. Large results may exceed the database export limit.'
                : format === 'csv'
                  ? 'CSV uses empty cells for null and JSON text for nested values. Formula-like strings start with an apostrophe for spreadsheet safety.'
                  : 'Preserves the JSON values in the current result, including precision-bearing strings.'}
            </Text>
            {destination && (
              <Text size="sm">
                {kind === 'filesystem' ? 'Save a new file in' : 'Create a new table in'}{' '}
                <strong>{destination.name}</strong>.
              </Text>
            )}
            {error && (
              <Alert color="red" title="Export could not finish" role="alert">
                {error}
              </Alert>
            )}
            <Group justify="flex-end" wrap="wrap">
              <Button disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="filled"
                loading={busy}
                leftSection={kind === 'download' ? <IconDownload01 size={18} /> : undefined}
                disabled={
                  busy ||
                  (kind !== 'download' &&
                    (loading ||
                      !!loadError ||
                      !destination ||
                      !(kind === 'filesystem' ? path.trim() : table.trim())))
                }
                onClick={() => void submit()}
              >
                {busy ? 'Exporting…' : action}
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </WorkspaceModal>
  );
}
