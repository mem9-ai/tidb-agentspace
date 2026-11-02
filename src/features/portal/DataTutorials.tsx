import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  NativeSelect,
  Paper,
  Stack,
  Tabs,
  Text,
} from '@tidbcloud/uikit';
import { IconDatabase01, IconFolder } from '@tidbcloud/uikit/icons';
import { workspaceApi, type Data, type QueryResult, type Resource } from '../../api/client';
import { Heading } from '../../ui/WorkspaceHeading';
import { CodeExample } from '../../ui/CodeExample';
import { WorkspaceQueryResults } from '../../ui/WorkspaceQueryResults';
import { databaseEditorHash, tutorialHash } from '../navigation/workspace-route';
import { fileHash } from '../files/file-location';
import {
  databaseTutorial,
  fileExamples,
  type FileExampleKind,
  liveDatabase,
  matchesTotals,
  ordersCsv,
  totalsQuery,
  tutorialSample,
} from './tutorial-data';
import './tutorials.css';
import { loadDatabaseSample } from './tutorial-import';
import { openFileExample } from './tutorial-file-examples';
import type { TutorialProgress, TutorialStore } from './tutorial-progress';
import { TutorialProgressStatus, useTutorialStore } from './TutorialProgressProvider';

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
  const { store, loading, error: progressError } = useTutorialStore();
  const [databaseId, setDatabaseId] = useState(() => store.readSelection('database'));
  const [filesystemId, setFilesystemId] = useState(() => store.readSelection('filesystem'));
  const [databaseBusy, setDatabaseBusy] = useState(false);
  const [filesystemBusy, setFilesystemBusy] = useState(false);
  const [activeKind, setActiveKind] = useState<'filesystem' | 'database'>('filesystem');
  const [fileJourney, setFileJourney] = useState<'csv' | FileExampleKind>('csv');
  const target = data.resources.find((resource) => resource.id === resourceId);
  const targetId = target?.id;
  const targetKind = target?.kind;
  const focusedKind = target
    ? target.kind === 'filesystem'
      ? 'filesystem'
      : 'database'
    : requestedKind;
  const kinds: ('database' | 'filesystem')[] = focusedKind
    ? [focusedKind]
    : ['filesystem', 'database'];
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
  }, [targetId, targetKind, requestedKind, store, loading]);
  if (loading || progressError) return <TutorialProgressStatus />;
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
    <section
      className="data-tutorials"
      data-focused={focusedKind || undefined}
      aria-label="Hands-on tutorials"
    >
      <Tabs
        value={focusedKind ?? activeKind}
        onChange={(value) => {
          if (value === 'filesystem' || value === 'database') setActiveKind(value);
        }}
        keepMounted
      >
        {!focusedKind && (
          <Tabs.List aria-label="Tutorial categories" className="tutorial-tabs">
            <Tabs.Tab value="filesystem">File System</Tabs.Tab>
            <Tabs.Tab value="database">Database</Tabs.Tab>
          </Tabs.List>
        )}
        {kinds.map((kind) => {
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
          const canCreate =
            !selected ||
            selected.status !== 'active' ||
            !!selected.connectionError ||
            (kind === 'database' && !liveDatabase(selected));
          return (
            <Tabs.Panel value={kind} key={kind}>
              <Paper
                withBorder
                p="xl"
                className="data-tutorial"
                id={`tutorial-${kind}`}
                tabIndex={-1}
              >
                <Group justify="space-between" gap="sm">
                  <Group gap="sm">
                    {kind === 'filesystem' ? (
                      <IconFolder size={24} />
                    ) : (
                      <IconDatabase01 size={24} />
                    )}
                    <Badge color="peacock">Hands-on tutorial</Badge>
                  </Group>
                  {focusedKind && (
                    <Button
                      component="a"
                      href="#tutorials"
                      variant="subtle"
                      onClick={() => setActiveKind('filesystem')}
                    >
                      All tutorials
                    </Button>
                  )}
                </Group>
                <Heading level={2}>
                  {kind === 'filesystem' ? 'Explore your File System' : 'Query sample data'}
                </Heading>
                <Text component="p">
                  {kind === 'filesystem'
                    ? 'Choose an example to preview files, analyze data with SQL, or find errors with Bash.'
                    : 'Load a small dataset, run your first query, and check the result here.'}
                </Text>
                <Tabs
                  value={kind === 'filesystem' ? fileJourney : 'csv'}
                  onChange={(value) => {
                    if (value === 'csv' || value === 'notes' || value === 'log')
                      setFileJourney(value);
                  }}
                  keepMounted
                >
                  {kind === 'filesystem' && (
                    <Tabs.List aria-label="File examples" className="tutorial-tabs" mt="lg">
                      <Tabs.Tab value="csv" disabled={busy}>
                        CSV
                      </Tabs.Tab>
                      <Tabs.Tab value="notes" disabled={busy}>
                        Markdown
                      </Tabs.Tab>
                      <Tabs.Tab value="log" disabled={busy}>
                        Logs · Bash
                      </Tabs.Tab>
                    </Tabs.List>
                  )}
                  <Stack gap="lg" mt="lg">
                    <div>
                      <Heading level={3}>
                        {kind === 'filesystem'
                          ? selected
                            ? 'Choose a File System'
                            : 'Create a File System'
                          : canCreate
                            ? '1. Choose or create a database'
                            : '1. Choose a database'}
                      </Heading>
                      {resources.length > 0 && (
                        <NativeSelect
                          mt="sm"
                          label={
                            kind === 'filesystem' ? 'Tutorial File System' : 'Tutorial database'
                          }
                          value={selected?.id ?? ''}
                          title={selected?.name}
                          disabled={busy}
                          onChange={(event) => {
                            const id = event.currentTarget.value;
                            (kind === 'filesystem' ? setFilesystemId : setDatabaseId)(id);
                            store.saveSelection(kind, id);
                            location.hash = tutorialHash(id);
                          }}
                          data={resources.map((resource) => ({
                            value: resource.id,
                            label: resource.name,
                          }))}
                        />
                      )}
                      {canCreate && (
                        <Button
                          mt="sm"
                          variant={selected ? 'default' : 'filled'}
                          disabled={busy}
                          onClick={() => onCreate(kind === 'filesystem' ? 'filesystem' : 'mysql')}
                        >
                          Create {kind === 'filesystem' ? 'File System' : 'database'}
                        </Button>
                      )}
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
                        onRunningChange={
                          kind === 'filesystem' ? setFilesystemBusy : setDatabaseBusy
                        }
                      />
                    ) : (
                      <Text c="carbon.7">
                        {kind === 'filesystem'
                          ? 'Next: choose an example and explore a sample file. No upload or API key needed.'
                          : 'Next: load the included sample and run a query. No upload or API key needed.'}
                      </Text>
                    )}
                  </Stack>
                </Tabs>
              </Paper>
            </Tabs.Panel>
          );
        })}
      </Tabs>
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
  const [initialSample] = useState(freshSample);
  const sample = store.readSample(resource.id) ?? initialSample;
  const [action, setAction] = useState<
    'prepare' | 'query' | 'verify' | 'reset' | FileExampleKind | null
  >(null);
  const busy = action !== null;
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
  async function run(action: 'prepare' | 'query' | 'verify' | 'reset' | FileExampleKind) {
    if (running.current || !available) return;
    running.current = true;
    setAction(action);
    onRunningChange(true);
    setError('');
    setNotice('');
    if (action !== 'prepare' && action !== 'notes' && action !== 'log') setResult(null);
    let progress = sample;
    async function updateSample(next: TutorialProgress) {
      progress = await store.saveSample(resource.id, { ...next, version: progress.version });
    }
    try {
      if (action === 'notes' || action === 'log') {
        if (!progress.version) await updateSample(progress);
        const examplePath = await openFileExample(
          workspaceApi,
          resource.id,
          resource.provider,
          sample.id,
          action,
        );
        location.hash = fileHash(
          resource.id,
          examplePath,
          action === 'log' ? 'analyze' : 'preview',
        );
      } else if (action === 'reset') {
        await updateSample(freshSample());
      } else if (action === 'prepare') {
        if (sample.attempted || demo) return;
        if (files) {
          await updateSample({ ...progress, attempted: true });
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
        await updateSample({ ...progress, attempted: true, ready: true });
        await refresh().catch(() =>
          setNotice('Sample saved. The workspace summary could not refresh; continue with step 3.'),
        );
      } else if (action === 'verify' && files) {
        const content = (await workspaceApi.previewFile({ resourceId: resource.id, path })).content;
        if (content !== ordersCsv)
          throw new Error(
            'The saved file does not match this tutorial sample. Open the File System to inspect it.',
          );
        await updateSample({ ...progress, attempted: true, ready: true });
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
          await updateSample({ ...progress, completed: matchesTotals(output.rows) });
          if (!matchesTotals(output.rows))
            setNotice(
              'The result differs from the sample totals. The saved data may have changed; inspect the file.',
            );
        } else {
          const output = await workspaceApi.query({ resourceId: resource.id, sql: query });
          setResult(output);
          await updateSample({
            ...progress,
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
      setResult(null);
      setError(cause instanceof Error ? cause.message : 'The tutorial action failed.');
    } finally {
      running.current = false;
      setAction(null);
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
      <Tabs.Panel value="csv">
        <Stack gap="lg">
          <div>
            <Heading level={3}>
              {files
                ? 'Save the sample CSV'
                : `2. ${demo ? 'Use the included demo data' : 'Load the sample data'}`}
            </Heading>
            <Text mt="sm">
              {demo
                ? 'Local demo · 3 preloaded agent events. This demo supports sample SELECT queries; use a live database to create your own tables.'
                : files
                  ? '6 orders · CSV · id, region, amount. Saves a new sample file in the selected File System.'
                  : '6 orders · id, region, amount. Creates a new sample table in the selected database.'}
            </Text>
            {!demo && (
              <details className="tutorial-code tutorial-artifact">
                <summary>Sample location</summary>
                <CodeExample
                  value={files ? path : database.table}
                  label={files ? 'File path' : 'Table name'}
                  copy={copy}
                />
              </details>
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
                  loading={action === 'prepare'}
                  disabled={busy || !available || sample.attempted}
                  onClick={() => void run('prepare')}
                >
                  {action === 'prepare'
                    ? 'Saving sample data…'
                    : files
                      ? 'Save sample CSV'
                      : 'Load sample orders'}
                </Button>
              )}
              {sample.attempted && !sample.ready && action !== 'prepare' && (
                <Button
                  loading={action === 'verify'}
                  disabled={busy || !available}
                  onClick={() => void run('verify')}
                >
                  {action === 'verify' ? 'Checking saved sample…' : 'Check saved sample'}
                </Button>
              )}
            </Group>
            {action === 'prepare' && (
              <Text mt="sm" size="sm" role="status">
                Saving the sample in this resource. You can run the query when it is ready.
              </Text>
            )}
            {sample.attempted && !sample.ready && !busy && (
              <Text mt="sm" size="sm">
                The save outcome is unconfirmed. Check the sample before continuing; loading it
                again is disabled to avoid repeating a write.
              </Text>
            )}
            {sample.attempted && !sample.ready && error && (
              <Button mt="sm" variant="subtle" disabled={busy} onClick={() => void run('reset')}>
                Use a new sample name (keep the previous sample)
              </Button>
            )}
          </div>
          <div>
            <Heading level={3}>
              {files
                ? 'Run the query and check your result'
                : '3. Run the query and check your result'}
            </Heading>
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
              loading={action === 'query'}
              disabled={busy || !available || !ready}
              onClick={() => void run('query')}
            >
              {action === 'query' ? 'Running query…' : 'Run tutorial query'}
            </Button>
          </div>
          {sample.completed && !result && (
            <Alert color="green" title="Tutorial completed">
              Your sample is saved. Run the query again for a fresh result, or open the sample
              below.
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
                  Use Export above to download the result.
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
        </Stack>
      </Tabs.Panel>
      {files &&
        (['notes', 'log'] as const).map((kind) => (
          <Tabs.Panel value={kind} pt="lg" key={kind}>
            <Heading level={3}>{fileExamples[kind].title}</Heading>
            <Text mt="sm">{fileExamples[kind].description}</Text>
            <Text mt="sm" size="sm">
              The sample is saved in this File System when you open it. Your edits are kept when you
              return.
            </Text>
            <Button
              mt="md"
              loading={action === kind}
              disabled={busy || !available}
              onClick={() => void run(kind)}
            >
              {action === kind
                ? 'Opening sample…'
                : kind === 'notes'
                  ? 'Open sample notes'
                  : 'Open sample log'}
            </Button>
          </Tabs.Panel>
        ))}
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
    </>
  );
}
