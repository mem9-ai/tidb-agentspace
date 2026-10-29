import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Loader,
  NativeSelect,
  Progress,
  Stack,
  Text,
  TextInput,
} from '@tidbcloud/uikit';
import { IconUpload01 } from '@tidbcloud/uikit/icons';
import {
  workspaceApi,
  type Resource,
  type DatabaseImportParsing,
  type DatabaseImportResult,
  type FileExportPreparation,
} from '../../api/client';
import { WorkspaceApiError } from '../../api/transport';
import { WorkspaceModal } from '../../ui/WorkspaceModal';
import { ImportReview, type ReviewedField } from '../exports/ImportReview';
import { ImportFileSource } from './ImportFileSource';
import { databaseEditorHash } from '../navigation/workspace-route';
import '../exports/file-export.css';

type Phase = 'uploading' | 'parsing' | 'writing' | 'refreshing' | null;
export function DatabaseImportDialog({
  database,
  onClose,
  onSaved,
  onBusyChange,
}: {
  database: Resource;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [source, setSource] = useState('local');
  const [file, setFile] = useState<File | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [path, setPath] = useState('');
  const [format, setFormat] = useState<'csv' | 'parquet'>('csv');
  const [header, setHeader] = useState(true);
  const [delimiter, setDelimiter] = useState<',' | '\t' | ';' | '|'>(',');
  const [table, setTable] = useState(() => `imported_${Date.now()}`);
  const [phase, setPhase] = useState<Phase>(null);
  const [percent, setPercent] = useState<number | undefined>();
  const [review, setReview] = useState<FileExportPreparation | null>(null);
  const [fields, setFields] = useState<ReviewedField[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [outcome, setOutcome] = useState<DatabaseImportResult | null>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const section = useRef<HTMLDivElement>(null);
  const progressSection = useRef<HTMLDivElement>(null);
  const errorSection = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const working = useRef(false);
  const busy = phase !== null;
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (phase) progressSection.current?.focus();
  }, [phase]);
  useEffect(() => {
    if (error) errorSection.current?.focus();
  }, [error]);
  function invalidate() {
    setReview(null);
    setFields([]);
    setConfirmed(false);
    setError('');
    setUncertain(false);
    setNotice('');
  }
  function begin(next: Phase) {
    working.current = true;
    setPhase(next);
    onBusyChange(true);
    setError('');
    setNotice('');
  }
  function end() {
    working.current = false;
    setPhase(null);
    onBusyChange(false);
  }
  const parsing: DatabaseImportParsing =
    format === 'csv' ? { format, header, delimiter } : { format };
  async function prepare() {
    if (working.current) return;
    if (source === 'local' && (!file || file.size > 1024 * 1024)) {
      setError('Choose a CSV/Parquet file no larger than 1 MiB.');
      return;
    }
    const previousFields = fields;
    invalidate();
    begin(source === 'local' ? 'uploading' : 'parsing');
    setPercent(0);
    const controller = new AbortController();
    request.current = controller;
    try {
      const parsed =
        source === 'local' && file
          ? await workspaceApi.prepareDatabaseImportUpload(
              database.id,
              file,
              parsing,
              (update) => {
                if (update.phase === 'saving') {
                  setPhase('parsing');
                  setPercent(undefined);
                } else
                  setPercent(
                    update.total
                      ? Math.min(100, Math.floor((update.loaded / update.total) * 100))
                      : undefined,
                  );
              },
              controller.signal,
            )
          : await workspaceApi.prepareDatabaseImport(
              { resourceId: database.id, source: { resourceId: sourceId, path }, parsing },
              controller.signal,
            );
      setReview(parsed);
      setFields(
        parsed.fields.map(
          (field) =>
            previousFields.find((old) => old.source === field.source) || {
              ...field,
              selected: true,
            },
        ),
      );
      requestAnimationFrame(() => section.current?.focus());
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'Unable to parse this file.');
    } finally {
      request.current = null;
      end();
    }
  }
  async function commit() {
    if (working.current || !review || !confirmed) return;
    if (
      !table.trim() ||
      new TextEncoder().encode(table).length > 63 ||
      Array.from(table).some((c) => c < ' ' || c === String.fromCharCode(127))
    ) {
      setError('Choose a table name with at most 63 UTF-8 bytes and no control characters.');
      return;
    }
    begin('writing');
    try {
      const saved = await workspaceApi.commitDatabaseImport({
        resourceId: database.id,
        preparationId: review.preparationId,
        confirmed: true,
        table,
        fields: fields
          .filter((f) => f.selected)
          .map(({ source, name, type }) => ({ source, name, type })),
      });
      setOutcome(saved);
      setPhase('refreshing');
      try {
        await onSaved();
      } catch {
        setNotice(
          'The table was created, but the browser could not refresh. Refresh tables to see it; do not import again.',
        );
      }
    } catch (cause) {
      const unknown =
        !(cause instanceof WorkspaceApiError) ||
        cause.status >= 500 ||
        cause.code === 'IMPORT_ALREADY_COMMITTED';
      setUncertain(unknown);
      setError(
        `${cause instanceof Error ? cause.message : 'Import was not confirmed.'}${unknown ? ' Inspect the destination table before preparing another import.' : ''}`,
      );
    } finally {
      end();
    }
  }
  const status =
    phase === 'uploading'
      ? `Uploading${percent === undefined ? '…' : ` · ${percent}%`}`
      : phase === 'parsing'
        ? 'Parsing data…'
        : phase === 'writing'
          ? 'Creating table and writing rows…'
          : 'Table created · Refreshing tables…';
  return (
    <WorkspaceModal title={`Import into ${database.name}`} size={800} busy={busy} onClose={onClose}>
      <Stack gap="lg">
        <Text>
          Destination: {database.name} ·{' '}
          {database.kind === 'postgresql'
            ? 'PostgreSQL'
            : database.kind === 'mysql'
              ? 'MySQL'
              : 'DuckDB'}{' '}
          · New table
        </Text>
        {busy && (
          <Stack ref={progressSection} tabIndex={-1} gap="xs" aria-label="Import progress">
            <Group gap="sm">
              <Loader size="sm" />
              <Text role="status">{status}</Text>
            </Group>
            <Progress.Root
              role="progressbar"
              aria-label="Database import progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={phase === 'uploading' ? percent : undefined}
              aria-valuetext={status}
            >
              <Progress.Section
                value={phase === 'uploading' && percent !== undefined ? percent : 100}
                striped={phase !== 'uploading' || percent === undefined}
                withAria={false}
              />
            </Progress.Root>
          </Stack>
        )}
        {outcome ? (
          <>
            <Alert color="green" title="Import complete" role="status">
              {outcome.rowCount} rows imported into {outcome.table}.
            </Alert>
            {notice && <Alert color="yellow">{notice}</Alert>}
            <Group justify="flex-end">
              <Button disabled={busy} onClick={onClose}>
                Done
              </Button>
              <Button
                component="a"
                href={databaseEditorHash(database.id, outcome.table)}
                disabled={busy}
                onClick={onClose}
                variant="filled"
              >
                Open table
              </Button>
            </Group>
          </>
        ) : (
          <>
            {(busy || review) && (
              <Text style={{ overflowWrap: 'anywhere' }}>
                Source: {source === 'local' ? file?.name : path} · {format.toUpperCase()}
              </Text>
            )}
            {!review && !busy && (
              <>
                <NativeSelect
                  label="Source"
                  value={source}
                  disabled={busy}
                  data={[
                    { value: 'local', label: 'Local file' },
                    { value: 'filesystem', label: 'Workspace File System' },
                  ]}
                  onChange={(e) => {
                    setSource(e.currentTarget.value);
                    invalidate();
                  }}
                />
                {source === 'local' ? (
                  <>
                    <input
                      ref={chooser}
                      type="file"
                      hidden
                      accept=".csv,.parquet"
                      aria-label="Local import file"
                      onChange={(e) => {
                        const value = e.target.files?.[0];
                        if (value) {
                          setFile(value);
                          setFormat(
                            value.name.toLowerCase().endsWith('.parquet') ? 'parquet' : 'csv',
                          );
                          invalidate();
                        }
                        e.currentTarget.value = '';
                      }}
                    />
                    <Group>
                      <Button
                        disabled={busy}
                        leftSection={<IconUpload01 size={18} />}
                        onClick={() => chooser.current?.click()}
                      >
                        Choose file
                      </Button>
                      <Text style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                        {file
                          ? `${file.name} · ${file.size.toLocaleString()} bytes`
                          : 'No file selected'}
                      </Text>
                    </Group>
                    <Text size="sm" c="dimmed">
                      Local files are used for this import without being added to File System.
                      Maximum 1 MiB.
                    </Text>
                  </>
                ) : (
                  <ImportFileSource
                    resourceId={sourceId}
                    path={path}
                    busy={busy}
                    onChange={(id, nextPath) => {
                      setSourceId(id);
                      setPath(nextPath);
                      if (nextPath.toLowerCase().endsWith('.csv')) setFormat('csv');
                      if (nextPath.toLowerCase().endsWith('.parquet')) setFormat('parquet');
                      invalidate();
                    }}
                  />
                )}
                <Group align="flex-end" grow>
                  <NativeSelect
                    label="Format"
                    value={format}
                    disabled={busy}
                    data={[
                      { value: 'csv', label: 'CSV' },
                      { value: 'parquet', label: 'Parquet' },
                    ]}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      if (value === 'csv' || value === 'parquet') {
                        setFormat(value);
                        invalidate();
                      }
                    }}
                  />
                  {format === 'csv' && (
                    <NativeSelect
                      label="Separator"
                      value={delimiter}
                      disabled={busy}
                      data={[
                        { value: ',', label: 'Comma' },
                        { value: '\t', label: 'Tab' },
                        { value: ';', label: 'Semicolon' },
                        { value: '|', label: 'Pipe' },
                      ]}
                      onChange={(e) => {
                        const v = e.currentTarget.value;
                        if (v === ',' || v === '\t' || v === ';' || v === '|') {
                          setDelimiter(v);
                          invalidate();
                        }
                      }}
                    />
                  )}
                </Group>
                {format === 'csv' && (
                  <Checkbox
                    label="First row contains column names"
                    checked={header}
                    disabled={busy}
                    onChange={(e) => {
                      setHeader(e.currentTarget.checked);
                      invalidate();
                    }}
                  />
                )}
                <Text size="sm" c="dimmed">
                  Review up to 1,000 rows per import. Oversized data is rejected; a preview sample
                  is never imported as the whole file.
                </Text>
                <Group justify="flex-end">
                  <Button
                    disabled={
                      busy ||
                      (source === 'local' && !file) ||
                      (source === 'filesystem' && (!sourceId || !path))
                    }
                    onClick={() => void prepare()}
                  >
                    {review ? 'Parse again' : 'Parse and review'}
                  </Button>
                </Group>
              </>
            )}
            {review && !busy && (
              <Group justify="space-between">
                <Button onClick={invalidate}>Change source</Button>
                <Button onClick={() => void prepare()}>Parse again</Button>
              </Group>
            )}
            {review && !busy && (
              <div ref={section} tabIndex={-1} className="import-review-focus">
                <Stack gap="lg">
                  <ImportReview
                    review={review}
                    fields={fields}
                    busy={busy}
                    onChange={(value) => {
                      setFields(value);
                      setConfirmed(false);
                    }}
                  />
                  <TextInput
                    label="New table name"
                    description="An existing table will not be replaced."
                    value={table}
                    disabled={busy}
                    onChange={(e) => {
                      setTable(e.currentTarget.value);
                      setConfirmed(false);
                    }}
                  />
                  <Checkbox
                    label={`I reviewed the fields and will create a new table in ${database.name}`}
                    checked={confirmed}
                    disabled={busy}
                    onChange={(e) => setConfirmed(e.currentTarget.checked)}
                  />
                </Stack>
              </div>
            )}
            {error && (
              <Alert ref={errorSection} tabIndex={-1} color="red" role="alert">
                {error}
              </Alert>
            )}
            <Group justify="flex-end">
              <Button disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              {review && !busy && (
                <Button
                  variant="filled"
                  disabled={
                    busy ||
                    !confirmed ||
                    !table.trim() ||
                    !fields.some((f) => f.selected) ||
                    uncertain
                  }
                  onClick={() => void commit()}
                >
                  Confirm and create table
                </Button>
              )}
            </Group>
          </>
        )}
      </Stack>
    </WorkspaceModal>
  );
}
