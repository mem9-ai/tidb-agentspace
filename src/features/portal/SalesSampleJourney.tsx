import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, Paper, Stack, Text } from '@tidbcloud/uikit';
import { IconFolder } from '@tidbcloud/uikit/icons';
import {
  globalApiSettings,
  workspaceApi,
  type Data,
  type Resource,
  type SalesSampleAttempt,
} from '../../api/client';
import { agentInstructions } from '../../api/agent-instructions';
import { WorkspaceApiError } from '../../api/transport';
import { fileHash } from '../files/file-location';
import { Heading } from '../../ui/WorkspaceHeading';

const reportPath = '/us-sales-report.md';

export function SalesSampleJourney({
  data,
  refresh,
  copy,
  onAuthorize,
}: {
  data: Data;
  refresh: () => Promise<void>;
  copy: (value: string) => void;
  onAuthorize: (resource: Resource) => void;
}) {
  const [attempt, setAttempt] = useState<SalesSampleAttempt | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [sampleResource, setSampleResource] = useState<Resource>();
  const [sampleFile, setSampleFile] = useState<
    'checking' | 'original' | 'changed' | 'missing' | 'unavailable'
  >('checking');
  const [report, setReport] = useState<'unknown' | 'missing' | 'found'>('unknown');
  const [checkingReport, setCheckingReport] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const idempotency = useRef(crypto.randomUUID());
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await workspaceApi.listSalesSampleAttempts();
      setAttempt(result.data[0] ?? null);
      setUncertain(false);
    } catch {
      setError('Could not check your sample. Try again before creating one.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    let active = true;
    setSampleResource(undefined);
    if (attempt?.status === 'ready' && attempt.resourceId) {
      const resource = data.resources.find((item) => item.id === attempt.resourceId);
      if (resource) setSampleResource(resource);
      else
        void workspaceApi
          .resource(attempt.resourceId)
          .then((result) => {
            if (active) setSampleResource(result.data);
          })
          .catch(() => {
            if (active) setError('Could not load the sample file system. Refresh and try again.');
          });
    }
    return () => {
      active = false;
    };
  }, [attempt?.status, attempt?.resourceId, data.resources]);
  useEffect(() => {
    let active = true;
    setSampleFile('checking');
    if (attempt?.status === 'ready' && attempt.resourceId && attempt.path) {
      void workspaceApi
        .fileMetadata(attempt.resourceId, attempt.path)
        .then((value) => {
          if (active)
            setSampleFile(
              value.data.type === 'file' && value.data.version === attempt.fileVersion
                ? 'original'
                : 'changed',
            );
        })
        .catch((cause: unknown) => {
          if (active)
            setSampleFile(
              cause instanceof WorkspaceApiError && cause.status === 404
                ? 'missing'
                : 'unavailable',
            );
        });
    }
    return () => {
      active = false;
    };
  }, [attempt?.status, attempt?.resourceId, attempt?.path, attempt?.fileVersion]);
  useEffect(() => {
    let active = true;
    setReport('unknown');
    if (attempt?.status === 'ready' && attempt.resourceId) {
      void workspaceApi
        .fileMetadata(attempt.resourceId, reportPath)
        .then((value) => {
          if (active) setReport(value.data.type === 'file' ? 'found' : 'missing');
        })
        .catch((cause: unknown) => {
          if (!active) return;
          if (cause instanceof WorkspaceApiError && cause.status === 404) setReport('missing');
          else setError('Could not check the report. Try again.');
        });
    }
    return () => {
      active = false;
    };
  }, [attempt?.status, attempt?.resourceId]);
  useEffect(() => {
    let active = true;
    if (attempt?.status === 'ready') {
      void globalApiSettings()
        .then((value) => {
          if (active) setEndpoint(value.endpoint);
        })
        .catch(() => {
          if (active)
            setConnectionError(
              'Connection details are unavailable. Open connection instructions to retry.',
            );
        });
    }
    return () => {
      active = false;
    };
  }, [attempt?.status]);
  async function start() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await workspaceApi.startSalesSample(idempotency.current);
      setAttempt(result.data);
      setUncertain(false);
      try {
        await refresh();
      } catch {
        setError(
          'The sample was saved, but the workspace could not refresh. Check its status to continue.',
        );
      }
    } catch {
      setUncertain(true);
      setError(
        'We could not confirm whether the sample was created. Check its status before trying again.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function checkReport() {
    if (!attempt?.resourceId || checkingReport) return;
    setCheckingReport(true);
    setError('');
    try {
      const value = await workspaceApi.fileMetadata(attempt.resourceId, reportPath);
      setReport(value.data.type === 'file' ? 'found' : 'missing');
    } catch (cause) {
      if (cause instanceof WorkspaceApiError && cause.status === 404) setReport('missing');
      else setError('Could not check the report. Try again.');
    } finally {
      setCheckingReport(false);
    }
  }
  if (!loading && !attempt && !error && data.resources.length > 0) return null;
  const task =
    attempt?.resourceId && attempt.path
      ? `Use my Workspace File System ${attempt.resourceId}. Read ${attempt.path} and analyze US sales by state with read-only file analysis. sales_usd is already the line total; do not multiply it by quantity. Write a concise report to ${reportPath} citing the input, query and actual results. Create the report only if it does not already exist; do not overwrite or retry an uncertain write. Use WORKSPACE_API_KEY from your environment and follow the Workspace connection instructions.`
      : '';
  const followUp =
    attempt?.resourceId && attempt.path
      ? `Use my Workspace File System ${attempt.resourceId}. Read ${attempt.path} and ${reportPath}; determine which product contributes most to California sales, citing your analysis. Write the answer to /us-sales-follow-up.md only if that file does not already exist. Do not overwrite or retry an uncertain write. Use WORKSPACE_API_KEY from your environment and follow the Workspace connection instructions.`
      : '';
  return (
    <Paper
      component="section"
      className="panel agent-first-start"
      withBorder
      p="xl"
      aria-label="US sales agent task"
    >
      <IconFolder size={28} aria-hidden />
      <Stack gap="md">
        <div>
          <Heading level={2}>Let your agent explore US sales</Heading>
          <Text>
            Start with a sample file, then ask your agent to analyze it and save a report here.
          </Text>
        </div>
        {loading ? (
          <Text role="status">Checking your sample…</Text>
        ) : attempt?.status === 'ready' && attempt.resourceId && attempt.path ? (
          <>
            <Text>
              {sampleFile === 'original' ? 'Sample ready' : 'Sample'} · {attempt.path}
            </Text>
            {sampleFile !== 'original' && (
              <Alert color="yellow" role="status">
                {sampleFile === 'checking' && 'Checking the saved sample…'}
                {sampleFile === 'changed' &&
                  'This sample has changed since it was created. Review your file before starting a task; your changes will not be replaced.'}
                {sampleFile === 'missing' &&
                  'The sample file is missing. Your workspace has not been changed; open the file system to inspect it.'}
                {sampleFile === 'unavailable' &&
                  'The sample could not be checked. Refresh before starting a task.'}
              </Alert>
            )}
            {sampleResource?.provider === 'local' && (
              <Text size="sm">
                Local demo file system · data is stored in this local workspace.
              </Text>
            )}
            <Group>
              <Button component="a" href={fileHash(attempt.resourceId, attempt.path, 'preview')}>
                Open sample
              </Button>
              <Button
                variant="filled"
                disabled={!sampleResource || sampleFile !== 'original'}
                onClick={() => sampleResource && onAuthorize(sampleResource)}
              >
                Create agent key
              </Button>
              <Button
                disabled={!endpoint || sampleFile !== 'original'}
                onClick={() => copy(`${agentInstructions(endpoint)}\n# Sales task\n\n${task}`)}
              >
                Copy agent task
              </Button>
            </Group>
            <Text size="sm">
              The key permits reading, analyzing, creating, editing, and deleting files in this file
              system. You choose and confirm access before the key is created.
            </Text>
            <Text size="sm">
              Give your agent the task and connection instructions. Copying them does not confirm
              that the agent connected or analyzed the data.
            </Text>
            {connectionError && <Alert color="yellow">{connectionError}</Alert>}
            <Group>
              <Button component="a" href="#connect" variant="subtle">
                Connection instructions
              </Button>
              <Button onClick={() => void checkReport()} loading={checkingReport}>
                Check for report
              </Button>
              {report === 'found' && (
                <Button
                  component="a"
                  href={fileHash(attempt.resourceId, reportPath, 'preview')}
                  variant="filled"
                >
                  Open report
                </Button>
              )}
            </Group>
            {report === 'missing' && (
              <Text role="status">No report found yet. Check again after your agent saves it.</Text>
            )}
            {report === 'found' && (
              <Text role="status">Report found. Open it to review its contents.</Text>
            )}
            {report === 'found' && (
              <Group>
                <Text>Continue with a fresh agent session:</Text>
                <Button
                  disabled={!endpoint || sampleFile !== 'original'}
                  onClick={() =>
                    copy(`${agentInstructions(endpoint)}\n# Follow-up task\n\n${followUp}`)
                  }
                >
                  Copy follow-up task
                </Button>
              </Group>
            )}
          </>
        ) : attempt ? (
          <>
            <Alert color="yellow" title="Sample is not ready">
              {attempt.status === 'preparing'
                ? 'Preparation has not been confirmed.'
                : `Preparation ${attempt.status === 'failed' ? 'failed' : 'has an unknown outcome'}.`}{' '}
              Check the saved attempt before creating anything else. No work is retried
              automatically.
            </Alert>
            <Group>
              <Button onClick={() => void load()}>Check status</Button>
              {attempt.resourceId && (
                <Button
                  component="a"
                  href={
                    '#files?' + new URLSearchParams({ resourceId: attempt.resourceId }).toString()
                  }
                >
                  Open file system
                </Button>
              )}
            </Group>
          </>
        ) : (
          <Group>
            {!error && (
              <Button variant="filled" onClick={() => void start()} loading={busy}>
                Prepare sample
              </Button>
            )}
            <Button component="a" href="#files" variant="subtle">
              Use your own files
            </Button>
          </Group>
        )}
        {error && (
          <Alert color="red" role="alert">
            {error}
            <Group mt="sm">
              <Button onClick={() => void load()}>Check status</Button>
              {uncertain && (
                <Text size="sm">The original request will not be repeated automatically.</Text>
              )}
            </Group>
          </Alert>
        )}
      </Stack>
    </Paper>
  );
}
