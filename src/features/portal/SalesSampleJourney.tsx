import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Anchor, Button, Group, Paper, Stack, Tabs, Text } from '@tidbcloud/uikit';
import { IconFolder } from '@tidbcloud/uikit/icons';
import {
  globalApiSettings,
  workspaceApi,
  type Data,
  type Resource,
  type SalesSampleAttempt,
} from '../../api/client';
import { workspaceSkillTask, workspaceSkillUrl } from '../../api/agent-instructions';
import { WorkspaceApiError } from '../../api/transport';
import { fileHash, fileSystemHash } from '../files/file-location';
import { Heading } from '../../ui/WorkspaceHeading';
import { SalesSelfService } from './SalesSelfService';
import { SalesFollowUp, followUpReportPath } from './SalesFollowUp';

const reportPath = '/us-sales-report.md';

export function SalesSampleJourney({
  data,
  refresh,
  copy,
  onAuthorize,
  sampleKey,
  isAuthorizing,
  preparingWorkspace,
  showCompleted,
}: {
  data: Data;
  refresh: () => Promise<void>;
  copy: (value: string) => Promise<boolean>;
  onAuthorize: (resource: Resource, prompt?: string) => void;
  sampleKey?: { resourceId: string; suitable: boolean; pending: boolean; launchPrepared?: boolean };
  isAuthorizing: boolean;
  preparingWorkspace: boolean;
  showCompleted: boolean;
}) {
  const [attempt, setAttempt] = useState<SalesSampleAttempt | null>(null);
  const [loading, setLoading] = useState(true);
  const [completed, setCompleted] = useState(false);
  const initialCheck = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [retryable, setRetryable] = useState(false);
  const [sampleResource, setSampleResource] = useState<Resource>();
  const [sampleFile, setSampleFile] = useState<
    'checking' | 'original' | 'changed' | 'missing' | 'unavailable'
  >('checking');
  const [report, setReport] = useState<'unknown' | 'missing' | 'found'>('unknown');
  const [checkedReport, setCheckedReport] = useState(false);
  const [checkingReport, setCheckingReport] = useState(false);
  const [reportCheckError, setReportCheckError] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [taskCopyFailed, setTaskCopyFailed] = useState(false);
  const [step, setStep] = useState<'access' | 'task' | 'report'>('access');
  const defaultFileSystem =
    data.resources.find((resource) => resource.kind === 'filesystem' && resource.isDefault) ??
    data.resources.find((resource) => resource.kind === 'filesystem');
  const sampleDestinationUnavailable = Boolean(
    defaultFileSystem &&
    (defaultFileSystem.status !== 'active' || defaultFileSystem.connectionError),
  );
  const [mode, setMode] = useState<'self' | 'agent'>(() => {
    try {
      return sessionStorage.getItem(`sales-journey:${data.workspace.id}`) === 'self'
        ? 'self'
        : 'agent';
    } catch {
      return 'agent';
    }
  });
  const taskButton = useRef<HTMLButtonElement>(null);
  const reportButton = useRef<HTMLButtonElement>(null);
  const idempotency = useRef(crypto.randomUUID());
  useEffect(() => {
    try {
      sessionStorage.setItem(`sales-journey:${data.workspace.id}`, mode);
    } catch {
      // The journey remains usable when browser storage is unavailable.
    }
  }, [data.workspace.id, mode]);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setRetryable(false);
    try {
      const result = await workspaceApi.listSalesSampleAttempts();
      const sample = result.data[0] ?? null;
      setAttempt(sample);
      if (
        initialCheck.current &&
        !showCompleted &&
        sample?.status === 'ready' &&
        sample.resourceId
      ) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          const checks = await Promise.allSettled(
            ['/my-us-sales-report.md', reportPath, followUpReportPath].map((path) =>
              workspaceApi.fileMetadata(sample.resourceId!, path, controller.signal),
            ),
          );
          const found = checks.map(
            (check) => check.status === 'fulfilled' && check.value.data.type === 'file',
          );
          setCompleted(found[0] || (found[1] && found[2]));
        } finally {
          clearTimeout(timeout);
        }
      }
      initialCheck.current = false;
      setUncertain(false);
    } catch {
      setError('Could not check your sample. Try again before creating one.');
    } finally {
      setLoading(false);
    }
  }, [showCompleted]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (sampleKey && sampleKey.resourceId === attempt?.resourceId && sampleKey.suitable) {
      setMode('agent');
      setStep(sampleKey.launchPrepared ? 'report' : 'task');
    }
  }, [attempt?.resourceId, sampleKey]);
  useEffect(() => {
    if (isAuthorizing || report === 'found') return;
    const button =
      step === 'task' ? taskButton.current : step === 'report' ? reportButton.current : null;
    if (button && !button.disabled) button.focus();
  }, [step, isAuthorizing, endpoint, sampleFile, report]);
  useEffect(() => {
    let active = true;
    setSampleResource(undefined);
    if (attempt?.status === 'ready' && attempt.resourceId) {
      const resource = data.resources.find((item) => item.id === attempt.resourceId);
      if (resource) setSampleResource(resource);
      else if (mode === 'agent')
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
  }, [attempt?.status, attempt?.resourceId, data.resources, mode]);
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
    if (mode !== 'agent')
      return () => {
        active = false;
      };
    setReport('unknown');
    setReportCheckError('');
    if (attempt?.status === 'ready' && attempt.resourceId) {
      void workspaceApi
        .fileMetadata(attempt.resourceId, reportPath)
        .then((value) => {
          if (active) setReport(value.data.type === 'file' ? 'found' : 'missing');
        })
        .catch((cause: unknown) => {
          if (!active) return;
          if (cause instanceof WorkspaceApiError && cause.status === 404) setReport('missing');
          else setReportCheckError('Could not check the report. We will try again.');
        });
    }
    return () => {
      active = false;
    };
  }, [attempt?.status, attempt?.resourceId, mode]);
  useEffect(() => {
    if (mode !== 'agent' || step !== 'report' || report === 'found' || !attempt?.resourceId) return;
    const resourceId = attempt.resourceId;
    const started = Date.now();
    let active = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (active) timer = setTimeout(poll, Date.now() - started < 120_000 ? 5_000 : 30_000);
    };
    const poll = async () => {
      if (!active || inFlight) return;
      if (document.hidden) {
        schedule();
        return;
      }
      inFlight = true;
      let found = false;
      try {
        const value = await workspaceApi.fileMetadata(resourceId, reportPath);
        found = value.data.type === 'file';
        if (active) {
          setReport((current) => (current === 'found' || found ? 'found' : 'missing'));
          setReportCheckError('');
        }
      } catch (cause) {
        if (active) {
          if (cause instanceof WorkspaceApiError && cause.status === 404) {
            setReport((current) => (current === 'found' ? current : 'missing'));
            setReportCheckError('');
          } else setReportCheckError('Could not check the report. We will try again.');
        }
      } finally {
        inFlight = false;
        if (active && !found) schedule();
      }
    };
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [attempt?.resourceId, step, report, mode]);
  useEffect(() => {
    let active = true;
    if (attempt?.status === 'ready' && mode === 'agent') {
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
  }, [attempt?.status, mode]);
  async function start() {
    if (busy) return;
    setBusy(true);
    setError('');
    setRetryable(false);
    try {
      const result = await workspaceApi.startSalesSample(
        idempotency.current,
        defaultFileSystem?.id,
      );
      setAttempt(result.data);
      setUncertain(false);
      try {
        await refresh();
      } catch {
        setError(
          'The sample was saved, but the workspace could not refresh. Check its status to continue.',
        );
      }
    } catch (cause) {
      if (cause instanceof WorkspaceApiError && cause.code === 'RESOURCE_INDEX_MIGRATING') {
        setRetryable(true);
        setUncertain(false);
        setError('Your workspace is still getting ready. Try again in a moment.');
      } else {
        setUncertain(true);
        setError(
          'We could not confirm whether the sample was created. Check its status before trying again.',
        );
      }
    } finally {
      setBusy(false);
    }
  }
  async function checkReport() {
    if (!attempt?.resourceId || checkingReport) return;
    setCheckingReport(true);
    setReportCheckError('');
    try {
      const value = await workspaceApi.fileMetadata(attempt.resourceId, reportPath);
      setReport((current) =>
        current === 'found' || value.data.type === 'file' ? 'found' : 'missing',
      );
      setCheckedReport(true);
    } catch (cause) {
      if (cause instanceof WorkspaceApiError && cause.status === 404) {
        setReport((current) => (current === 'found' ? current : 'missing'));
        setCheckedReport(true);
      } else setReportCheckError('Could not check the report. Try again.');
    } finally {
      setCheckingReport(false);
    }
  }
  const task =
    attempt?.resourceId && attempt.path
      ? `Use my Workspace File System ${attempt.resourceId}. Read ${attempt.path} and analyze US sales by state with read-only file analysis. sales_usd is already the line total; do not multiply it by quantity. Write a concise Markdown report to ${reportPath} citing the input, query and actual results. Include a Mermaid pie chart in a fenced mermaid code block showing sales by state, using the actual query results and valid Mermaid syntax. Create the report only if it does not already exist; do not overwrite or retry an uncertain write. Use WORKSPACE_API_KEY from your environment and follow the Workspace connection instructions.`
      : '';
  const followUp =
    attempt?.resourceId && attempt.path
      ? `Use my Workspace File System ${attempt.resourceId}. Read ${attempt.path} and ${reportPath}; determine which product contributes most to California sales, citing your analysis. Write the answer to ${followUpReportPath} only if that file does not already exist. Do not overwrite or retry an uncertain write. Use WORKSPACE_API_KEY from your environment and follow the Workspace connection instructions.`
      : '';
  const skillUrl = workspaceSkillUrl(window.location.origin, window.location.pathname);
  const taskInstructions = endpoint ? workspaceSkillTask(endpoint, skillUrl, task) : '';
  function downloadTask() {
    const url = URL.createObjectURL(new Blob([taskInstructions], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'workspace-task.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (completed && !showCompleted) return null;
  return (
    <Paper
      component="section"
      className="panel agent-first-start"
      withBorder
      p="xl"
      aria-label="Explore US sales"
    >
      <IconFolder size={28} aria-hidden />
      <Stack gap="md" className="sales-journey-content">
        <div>
          <Heading level={2}>Explore US sales</Heading>
          <Text>Find the states with the most sales, with an agent or on your own.</Text>
        </div>
        {loading ? (
          <Text role="status">Checking your sample…</Text>
        ) : attempt?.status === 'ready' && attempt.resourceId && attempt.path ? (
          <>
            <Text>
              {sampleFile === 'original' ? 'Sample ready' : 'Sample'} ·{' '}
              <Anchor href={fileHash(attempt.resourceId, attempt.path, 'preview')}>
                {attempt.path}
              </Anchor>
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
            <Tabs
              value={mode}
              onChange={(value) => {
                if (value === 'agent' || value === 'self') setMode(value);
              }}
              keepMounted
            >
              <Tabs.List aria-label="Ways to explore the sample" className="tutorial-tabs">
                <Tabs.Tab value="agent">With an agent</Tabs.Tab>
                <Tabs.Tab value="self">Explore yourself</Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="self" pt="lg">
                <SalesSelfService
                  resourceId={attempt.resourceId}
                  path={attempt.path}
                  fileVersion={attempt.fileVersion}
                  canAnalyze={sampleFile === 'original'}
                  onFileChanged={() => setSampleFile('changed')}
                  active={mode === 'self'}
                />
              </Tabs.Panel>
              <Tabs.Panel value="agent" pt="lg">
                <Stack gap="md">
                  {mode === 'agent' && report !== 'found' && step === 'access' && (
                    <>
                      <Text>
                        Give your agent access to analyze this sample and create a Markdown report
                        with a Mermaid chart.
                      </Text>
                      {sampleKey?.resourceId === attempt.resourceId && !sampleKey.suitable && (
                        <Alert color="yellow">
                          The key you created does not include all the access needed for this task.
                          Review the permissions and create another key, or use an existing key.
                        </Alert>
                      )}
                      <Group>
                        <Button
                          variant="filled"
                          disabled={!sampleResource || sampleFile !== 'original'}
                          onClick={() =>
                            sampleResource &&
                            onAuthorize(sampleResource, endpoint ? taskInstructions : undefined)
                          }
                        >
                          Connect your agent
                        </Button>
                        <Button
                          variant="subtle"
                          disabled={sampleFile !== 'original'}
                          onClick={() => setStep('task')}
                        >
                          I already have a key
                        </Button>
                      </Group>
                      <Text size="sm">
                        You will review access before creating a key. File write access also permits
                        editing and deleting files in this file system.
                      </Text>
                    </>
                  )}
                  {mode === 'agent' && report !== 'found' && step === 'task' && (
                    <>
                      <Text>
                        Make your key available to your agent as WORKSPACE_API_KEY. If you used the
                        terminal setup, start a new agent session from that terminal, then give it
                        the task. For Pi, run <code>pi</code> in that terminal and paste the copied
                        task into Pi.
                      </Text>
                      {sampleKey?.resourceId === attempt.resourceId && sampleKey.pending && (
                        <Alert color="yellow">
                          Your key was created, but its access is still being applied. If the agent
                          cannot connect, try again shortly.
                        </Alert>
                      )}
                      <Text size="sm">
                        The key needs access to this file system and permission to read, analyze,
                        and write files. Copying the task does not connect or start your agent.
                      </Text>
                      <Group>
                        <Button
                          ref={taskButton}
                          variant="filled"
                          disabled={!endpoint || sampleFile !== 'original'}
                          onClick={() => {
                            void copy(taskInstructions).then((copied) => {
                              setTaskCopyFailed(!copied);
                              if (copied) setStep('report');
                            });
                          }}
                        >
                          Copy task for your agent
                        </Button>
                        <Button variant="subtle" onClick={() => setStep('access')}>
                          Back
                        </Button>
                      </Group>
                      {taskCopyFailed && endpoint && sampleFile === 'original' && (
                        <Alert color="yellow">
                          Copy didn’t work. Download the task and give its contents to your agent.
                          <Group mt="sm">
                            <Button onClick={downloadTask}>Download task</Button>
                            <Button onClick={() => setStep('report')}>Continue to report</Button>
                          </Group>
                        </Alert>
                      )}
                    </>
                  )}
                  {mode === 'agent' && connectionError && step !== 'access' && (
                    <Alert color="yellow">
                      {connectionError}{' '}
                      <Anchor href="#connect">Open connection instructions</Anchor>
                    </Alert>
                  )}
                  {mode === 'agent' && reportCheckError && step !== 'report' && (
                    <Alert color="yellow">{reportCheckError}</Alert>
                  )}
                  {mode === 'agent' && report !== 'found' && step === 'report' && (
                    <>
                      <Text>
                        We’ll look for the report automatically. This does not confirm that your
                        agent connected or ran the task.
                      </Text>
                      <Text role="status">Waiting for a report…</Text>
                      {reportCheckError && <Alert color="yellow">{reportCheckError}</Alert>}
                      <Group>
                        <Button
                          ref={reportButton}
                          variant="default"
                          onClick={() => void checkReport()}
                          loading={checkingReport}
                        >
                          Check now
                        </Button>
                        <Button variant="subtle" onClick={() => setStep('task')}>
                          View task again
                        </Button>
                      </Group>
                      {checkedReport && report === 'missing' && (
                        <Text role="status">
                          No report yet. We’ll keep looking while this page is open.
                        </Text>
                      )}
                    </>
                  )}
                  {mode === 'agent' && report === 'found' && (
                    <>
                      <Text role="status">Report found. Open it to review its contents.</Text>
                      <Group>
                        <Button
                          component="a"
                          href={fileHash(attempt.resourceId, reportPath, 'preview')}
                          variant="filled"
                        >
                          Open report
                        </Button>
                      </Group>
                    </>
                  )}
                  {mode === 'agent' && report === 'found' && (
                    <SalesFollowUp
                      key={attempt.resourceId}
                      workspaceId={data.workspace.id}
                      resourceId={attempt.resourceId}
                      instructions={
                        endpoint ? workspaceSkillTask(endpoint, skillUrl, followUp) : ''
                      }
                      enabled={Boolean(endpoint) && sampleFile === 'original'}
                      copy={copy}
                    />
                  )}
                </Stack>
              </Tabs.Panel>
            </Tabs>
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
              <Button
                variant="filled"
                onClick={() => {
                  setMode('agent');
                  void start();
                }}
                loading={busy && mode === 'agent'}
                disabled={
                  (busy && mode !== 'agent') || preparingWorkspace || sampleDestinationUnavailable
                }
              >
                Try with an agent
              </Button>
            )}
            {!error && (
              <Button
                variant="default"
                onClick={() => {
                  setMode('self');
                  void start();
                }}
                loading={busy && mode === 'self'}
                disabled={
                  (busy && mode !== 'self') || preparingWorkspace || sampleDestinationUnavailable
                }
              >
                Explore sample yourself
              </Button>
            )}
            <Button
              component="a"
              href={defaultFileSystem ? fileSystemHash(defaultFileSystem.id) : '#files'}
              variant="subtle"
              disabled={preparingWorkspace || sampleDestinationUnavailable}
            >
              Use your own files
            </Button>
          </Group>
        )}
        {error && (
          <Alert color="red" role="alert">
            {error}
            <Group mt="sm">
              {retryable ? (
                <Button onClick={() => void start()} loading={busy}>
                  Try again
                </Button>
              ) : (
                <Button onClick={() => void load()}>Check status</Button>
              )}
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
