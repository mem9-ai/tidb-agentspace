import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Group, NativeSelect, Paper, Stack, Text } from '@tidbcloud/uikit';
import { IconDatabase01, IconFolder } from '@tidbcloud/uikit/icons';
import { workspaceApi, type Data, type QueryResult, type Resource } from '../../api/client';
import { Heading } from '../../ui/WorkspaceHeading';
import { CodeExample } from '../../ui/CodeExample';
import { WorkspaceQueryResults } from '../../ui/WorkspaceQueryResults';
import { databaseEditorHash, tutorialHash } from '../navigation/workspace-route';
import { fileHash } from '../files/file-location';
import {
  databaseTutorial,
  liveDatabase,
  matchesTotals,
  ordersCsv,
  totalsQuery,
  tutorialSample,
} from './tutorial-data';
import './tutorials.css';
import { loadDatabaseSample } from './tutorial-import';
import { getTutorialStore, type TutorialProgress, type TutorialStore } from './tutorial-progress';

type Props = {
  data: Data;
  resourceId?: string;
  kind?: 'database' | 'filesystem';
  onCreate: (kind: 'mysql' | 'filesystem') => void;
  refresh: () => Promise<void>;
  copy: (value: string) => void;
};
function freshSample(): TutorialProgress {
  return {
    id: crypto.randomUUID().replaceAll('-', ''),
    attempted: false,
    ready: false,
    completed: false,
  };
}

export function DataTutorials({
  data,
  resourceId,
  kind: requestedKind,
  onCreate,
  refresh,
  copy,
}: Props) {
  const store = useMemo(() => getTutorialStore(data.workspace.id), [data.workspace.id]);
  const [databaseId, setDatabaseId] = useState(() => store.readSelection('database'));
  const [filesystemId, setFilesystemId] = useState(() => store.readSelection('filesystem'));
  const [databaseBusy, setDatabaseBusy] = useState(false);
  const [filesystemBusy, setFilesystemBusy] = useState(false);
  const target = data.resources.find((resource) => resource.id === resourceId);
  const targetId = target?.id;
  const targetKind = target?.kind;
  useEffect(() => {
    const kind = targetKind
      ? targetKind === 'filesystem'
        ? 'filesystem'
        : 'database'
      : requestedKind;
    if (targetId && kind) {
      if (kind === 'filesystem') setFilesystemId(targetId);
      else setDatabaseId(targetId);
      store.saveSelection(kind, targetId);
    }
    if (kind) {
      const card = document.getElementById(`tutorial-${kind}`);
      card?.scrollIntoView({ block: 'start' });
      card?.focus({ preventScroll: true });
    }
  }, [targetId, targetKind, requestedKind, store]);
  if (resourceId && !target)
    return (
      <Alert color="yellow" mb="xl" title="Tutorial resource unavailable">
        This resource is no longer available in this workspace. Your saved tutorial has not been
        moved to another resource.
        <Button component="a" href="#tutorials" mt="sm" variant="default">
          Browse tutorials
        </Button>
      </Alert>
    );
  return (
    <section className="data-tutorials" aria-label="Hands-on tutorials">
      {(['database', 'filesystem'] as const).map((kind) => {
        const resources = data.resources.filter((resource) =>
          kind === 'filesystem' ? resource.kind === 'filesystem' : resource.kind !== 'filesystem',
        );
        const selectedId =
          target && (target.kind === 'filesystem') === (kind === 'filesystem')
            ? target.id
            : kind === 'filesystem'
              ? filesystemId
              : databaseId;
        const busy = kind === 'filesystem' ? filesystemBusy : databaseBusy;
        const selected =
          resources.find((resource) => resource.id === selectedId) ??
          resources.find(
            (resource) =>
              resource.status === 'active' && (kind === 'filesystem' || liveDatabase(resource)),
          ) ??
          resources[0];
        return (
          <Paper
            withBorder
            p="xl"
            className="data-tutorial"
            key={kind}
            id={`tutorial-${kind}`}
            tabIndex={-1}
          >
            <Group gap="sm">
              {kind === 'filesystem' ? <IconFolder size={24} /> : <IconDatabase01 size={24} />}
              <Badge color="peacock">Hands-on tutorial</Badge>
            </Group>
            <Heading level={2}>
              {kind === 'filesystem' ? 'Analyze sample files' : 'Query sample data'}
            </Heading>
            <Text component="p">
              {kind === 'filesystem'
                ? 'Save a ready-made CSV, run SQL over its rows, and see sales by region.'
                : 'Load a small dataset, run your first query, and check the result here.'}
            </Text>
            <Stack gap="lg" mt="lg">
              <div>
                <Heading level={3}>
                  1. Choose or create {kind === 'filesystem' ? 'a File System' : 'a database'}
                </Heading>
                {resources.length > 0 && (
                  <NativeSelect
                    mt="sm"
                    label={kind === 'filesystem' ? 'Tutorial File System' : 'Tutorial database'}
                    value={selected?.id ?? ''}
                    disabled={busy}
                    onChange={(event) => {
                      const id = event.currentTarget.value;
                      (kind === 'filesystem' ? setFilesystemId : setDatabaseId)(id);
                      store.saveSelection(kind, id);
                      location.hash = tutorialHash(id);
                    }}
                    data={resources.map((resource) => ({
                      value: resource.id,
                      label: `${resource.name} · ${resource.kind === 'filesystem' ? 'Files' : resource.kind} · ${resource.status}`,
                    }))}
                  />
                )}
                <Button
                  mt="sm"
                  variant={selected ? 'subtle' : 'filled'}
                  disabled={busy}
                  onClick={() => onCreate(kind === 'filesystem' ? 'filesystem' : 'mysql')}
                >
                  Create {kind === 'filesystem' ? 'File System' : 'database'}
                </Button>
                {!selected && (
                  <Text mt="sm">
                    After creation, continue here with your new resource selected.
                  </Text>
                )}
              </div>
              {selected ? (
                <TutorialSteps
                  key={selected.id}
                  resource={selected}
                  store={store}
                  refresh={refresh}
                  copy={copy}
                  onRunningChange={kind === 'filesystem' ? setFilesystemBusy : setDatabaseBusy}
                />
              ) : (
                <Text c="carbon.7">
                  Next: load the included sample and run a query. No upload or API key needed.
                </Text>
              )}
            </Stack>
          </Paper>
        );
      })}
    </section>
  );
}

function TutorialSteps({
  resource,
  refresh,
  copy,
  onRunningChange,
  store,
}: {
  resource: Resource;
  refresh: () => Promise<void>;
  copy: (value: string) => void;
  onRunningChange: (busy: boolean) => void;
  store: TutorialStore;
}) {
  const [sample, setSample] = useState(() => store.readSample(resource.id) ?? freshSample());
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<QueryResult | null>(null);
  const files = resource.kind === 'filesystem';
  const demo = !files && !liveDatabase(resource);
  const { path } = tutorialSample(sample.id);
  const database = databaseTutorial(resource, sample.id);
  const query = files ? totalsQuery('file') : database.query;
  const active = resource.status === 'active';
  const available = active && !resource.connectionError;
  const ready = sample.ready || demo;
  function updateSample(next: TutorialProgress) {
    setSample(next);
    store.saveSample(resource.id, next);
  }
  async function run(action: 'prepare' | 'query' | 'verify') {
    if (running.current || !available) return;
    running.current = true;
    setBusy(true);
    onRunningChange(true);
    setError('');
    setNotice('');
    if (action !== 'prepare') setResult(null);
    try {
      if (action === 'prepare') {
        if (sample.attempted || demo) return;
        if (files) {
          updateSample({ ...sample, attempted: true });
          if (resource.provider === 'drive9-anonymous') {
            await workspaceApi.uploadFile(
              { resourceId: resource.id, path },
              new Blob([ordersCsv], { type: 'text/csv' }),
              () => {},
            );
          } else {
            await workspaceApi.saveFile({
              resourceId: resource.id,
              path,
              type: 'file',
              content: ordersCsv,
            });
          }
        } else
          await loadDatabaseSample(workspaceApi, resource.id, sample.id, () =>
            updateSample({ ...sample, attempted: true }),
          );
        updateSample({ ...sample, attempted: true, ready: true });
        await refresh().catch(() =>
          setNotice('Sample saved. The workspace summary could not refresh; continue with step 3.'),
        );
      } else if (action === 'verify' && files) {
        const content = (await workspaceApi.previewFile({ resourceId: resource.id, path })).content;
        if (content !== ordersCsv)
          throw new Error(
            'The saved file does not match this tutorial sample. Open the File System to inspect it.',
          );
        updateSample({ ...sample, attempted: true, ready: true });
      } else {
        if (files) {
          const cap = await workspaceApi.fileAnalysisCapabilities(resource.id, path);
          const sqlEngine =
            cap.engines?.find((engine) => engine.engine === 'duckdb') ??
            (cap.engine === 'duckdb' ? cap : undefined);
          if (!sqlEngine?.available)
            throw new Error(
              sqlEngine?.reason ||
                'SQL analysis is unavailable. Open the file to preview or download the CSV.',
            );
          const output = await workspaceApi.analyzeFile({
            resourceId: resource.id,
            path,
            engine: 'duckdb',
            sql: query,
          });
          if (output.engine !== 'duckdb') throw new Error('Expected a SQL result.');
          setResult({ ...output, mode: 'live' });
          updateSample({ ...sample, completed: matchesTotals(output.rows) });
          if (!matchesTotals(output.rows))
            setNotice(
              'The result differs from the sample totals. The saved data may have changed; inspect the file.',
            );
        } else {
          const output = await workspaceApi.query({ resourceId: resource.id, sql: query });
          setResult(output);
          updateSample({
            ...sample,
            attempted: true,
            ready: true,
            completed: demo
              ? output.rows.length === 3 && output.rows.every((row) => row.status === 'completed')
              : matchesTotals(output.rows),
          });
          if (!demo && !matchesTotals(output.rows))
            setNotice(
              'The result differs from the sample totals. Inspect the sample table before continuing.',
            );
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The tutorial action failed.');
    } finally {
      running.current = false;
      setBusy(false);
      onRunningChange(false);
    }
  }
  return (
    <>
      {!available && (
        <Alert color="yellow">
          {resource.connectionError ||
            `This resource is ${resource.status}. Refresh its status or choose an active resource to continue.`}
          <Button
            mt="sm"
            variant="default"
            onClick={() =>
              void refresh().catch(() => setError('Could not refresh resource status. Try again.'))
            }
          >
            Refresh status
          </Button>
        </Alert>
      )}
      <div>
        <Heading level={3}>
          2. {demo ? 'Use the included demo data' : 'Load the sample data'}
        </Heading>
        <Text mt="sm">
          {demo
            ? 'Local demo · 3 preloaded agent events. This demo supports sample SELECT queries; use a live database to create your own tables.'
            : files
              ? '6 orders · CSV · id, region, amount. Saves a new sample file in the selected File System.'
              : '6 orders · id, region, amount. Creates a new sample table in the selected database.'}
        </Text>
        {!demo && (
          <Text size="sm" mt="xs" className="tutorial-artifact">
            <code>{files ? path : database.table}</code>
          </Text>
        )}
        {!demo && (
          <details className="tutorial-code">
            <summary>Preview sample CSV</summary>
            <CodeExample value={ordersCsv} label="CSV" copy={copy} />
            {!files && (
              <Text size="sm">
                Imports six rows into a new table: id BIGINT, region TEXT, amount BIGINT.
              </Text>
            )}
          </details>
        )}
        <Group mt="sm">
          {ready ? (
            <Badge color="green">{demo ? 'Demo data ready' : 'Sample data ready'}</Badge>
          ) : (
            <Button
              variant="filled"
              loading={busy}
              disabled={!available || sample.attempted}
              onClick={() => void run('prepare')}
            >
              {files ? 'Save sample CSV' : 'Load sample orders'}
            </Button>
          )}
          {sample.attempted && !sample.ready && (
            <Button disabled={busy || !available} onClick={() => void run('verify')}>
              Check saved sample
            </Button>
          )}
        </Group>
        {sample.attempted && !sample.ready && (
          <Text mt="sm" size="sm">
            The save outcome is unconfirmed. Check the sample before continuing; loading it again is
            disabled to avoid repeating a write.
          </Text>
        )}
        {sample.attempted && !sample.ready && error && (
          <Button
            mt="sm"
            variant="subtle"
            disabled={busy}
            onClick={() => {
              updateSample(freshSample());
              setResult(null);
              setError('');
            }}
          >
            Use a new sample name (keep the previous sample)
          </Button>
        )}
      </div>
      <div>
        <Heading level={3}>3. Run the query and check your result</Heading>
        <Text mt="sm">
          {demo
            ? 'Expected: 3 completed events from research-agent and coding-agent.'
            : 'Expected: AMER = 90, APAC = 240, EMEA = 180. Total sales = 510.'}
        </Text>
        <details className="tutorial-code">
          <summary>View query</summary>
          <CodeExample value={query} label="SQL" copy={copy} />
        </details>
        <Button
          mt="sm"
          variant="filled"
          loading={busy}
          disabled={!available || !ready}
          onClick={() => void run('query')}
        >
          Run tutorial query
        </Button>
      </div>
      {error && (
        <Alert color="red" role="alert">
          {error}
        </Alert>
      )}
      {notice && (
        <Alert color="yellow" role="status">
          {notice}
        </Alert>
      )}
      {sample.completed && !result && (
        <Alert color="green" title="Tutorial completed">
          Your sample is saved. Run the query again for a fresh result, or open the sample below.
        </Alert>
      )}
      {result && (
        <>
          <WorkspaceQueryResults
            result={result}
            busy={busy}
            error=""
            sourceResourceId={resource.id}
            onExportSaved={refresh}
            footnote={
              demo
                ? 'Local demo · Sample events'
                : 'Compare these rows with the expected totals above.'
            }
          />
          <Alert
            color={demo || matchesTotals(result.rows) ? 'green' : 'yellow'}
            title={
              demo || matchesTotals(result.rows)
                ? 'Your first result is ready'
                : 'Review the changed sample'
            }
          >
            <Text>
              Next:{' '}
              {files
                ? 'preview your CSV or try another SQL query or Just Bash in Analyze.'
                : 'browse the sample table and try your own queries in SQL Editor.'}{' '}
              Use Export above to download the result. Open Connect an agent when you are ready.
            </Text>
          </Alert>
        </>
      )}
      {(ready || sample.attempted) && (
        <Group>
          <Button
            variant="default"
            disabled={busy}
            onClick={() => {
              location.hash = files
                ? fileHash(resource.id, path, 'preview')
                : databaseEditorHash(resource.id, demo ? 'agent_events' : database.table);
            }}
          >
            {files ? 'Preview sample CSV' : 'Open sample in SQL Editor'}
          </Button>
          {files && ready && (
            <Button
              variant="default"
              disabled={busy}
              onClick={() => {
                location.hash = fileHash(resource.id, path, 'analyze');
              }}
            >
              Open file analysis
            </Button>
          )}
        </Group>
      )}
    </>
  );
}
