import { useCallback, useEffect, useState } from 'react';
import { Alert, Anchor, Button, Group, Stack, Text } from '@tidbcloud/uikit';
import { workspaceApi } from '../../api/client';
import { WorkspaceApiError } from '../../api/transport';
import { fileHash } from '../files/file-location';

export const followUpReportPath = '/us-sales-follow-up.md';
export function followUpStorageKey(
  workspaceId: string,
  resourceId: string,
  path = followUpReportPath,
) {
  return `sales-follow-up:${workspaceId}:${resourceId}${path === followUpReportPath ? '' : ':' + path}`;
}
type ReportState = 'checking' | 'missing' | 'found' | 'unavailable';

/** File existence is observable; it does not identify the writer or prove the task ran. */
export function SalesFollowUp({
  workspaceId,
  resourceId,
  instructions,
  enabled,
  copy,
  started = false,
  description = 'Find which product contributes most to California sales.',
  path = followUpReportPath,
}: {
  workspaceId: string;
  resourceId: string;
  instructions: string;
  enabled: boolean;
  copy: (value: string) => Promise<boolean>;
  started?: boolean;
  description?: string;
  path?: string;
}) {
  const storageKey = followUpStorageKey(workspaceId, resourceId, path);
  useEffect(() => {
    if (started) {
      try {
        sessionStorage.setItem(storageKey, 'waiting');
      } catch {
        /* Keep observing in this page. */
      }
    }
  }, [started, storageKey]);
  const [report, setReport] = useState<ReportState>('checking');
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [waiting, setWaiting] = useState(() => {
    if (started) return true;
    try {
      return sessionStorage.getItem(storageKey) === 'waiting';
    } catch {
      return false;
    }
  });
  function rememberWaiting(value: boolean) {
    setWaiting(value);
    try {
      if (value) sessionStorage.setItem(storageKey, 'waiting');
      else sessionStorage.removeItem(storageKey);
    } catch {
      // The current page can still show progress if browser storage is unavailable.
    }
  }
  const observe = useCallback(async () => {
    try {
      const value = await workspaceApi.fileMetadata(resourceId, path);
      return value.data.type === 'file' ? 'found' : 'unavailable';
    } catch (cause) {
      return cause instanceof WorkspaceApiError && cause.status === 404 ? 'missing' : 'unavailable';
    }
  }, [resourceId, path]);
  useEffect(() => {
    let active = true;
    void observe().then((result) => {
      if (active) setReport((current) => (current === 'found' ? current : result));
    });
    return () => {
      active = false;
    };
  }, [observe]);
  useEffect(() => {
    if (!waiting || report === 'found') return;
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
      const result = await observe();
      inFlight = false;
      if (!active) return;
      setReport((current) => (current === 'found' ? current : result));
      if (result !== 'found') schedule();
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
  }, [waiting, report, observe]);
  useEffect(() => {
    if (report !== 'found') return;
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      // Discovery is still visible on this page without browser storage.
    }
  }, [report, storageKey]);

  async function copyTask() {
    const copied = await copy(instructions);
    setCopyFailed(!copied);
    setCopied(copied);
    if (copied) rememberWaiting(true);
  }
  function downloadTask() {
    const url = URL.createObjectURL(new Blob([instructions], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'workspace-follow-up-task.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function checkNow() {
    if (checking) return;
    setChecking(true);
    const result = await observe();
    setReport((current) => (current === 'found' ? current : result));
    setChecked(true);
    setChecking(false);
  }

  return (
    <section aria-label="Follow-up task">
      <Stack gap="sm">
        <Text fw={600}>
          {started ? 'Your agent’s next report' : 'Continue with a fresh agent session'}
        </Text>
        {report === 'checking' && <Text role="status">Checking for a follow-up report…</Text>}
        {report === 'found' ? (
          <>
            <Text role="status">Follow-up file found. Open it to review its contents.</Text>
            <Group>
              <Button component="a" href={fileHash(resourceId, path, 'preview')}>
                Open follow-up report
              </Button>
            </Group>
          </>
        ) : (
          <>
            <Text>{description}</Text>
            {waiting && (
              <>
                <Text role="status">
                  {started
                    ? 'Run the terminal command and provide your key. Your agent will save its result here.'
                    : `${copied ? 'Task copied.' : 'Give the task to your agent.'} Start a fresh agent session with access to this workspace, then paste the task. If you used the one-line setup, run it again and enter your key.`}
                </Text>
                <Text size="sm">
                  We’ll look for the follow-up report while this page is open. Copying the task does
                  not start or verify your agent.{' '}
                  <Anchor href="#connect">Connection instructions</Anchor>
                </Text>
              </>
            )}
            {report === 'unavailable' && (
              <Alert color="yellow">Could not check for the follow-up report. Try again.</Alert>
            )}
            {!instructions && !started && (
              <Text size="sm">
                Connection details are unavailable.{' '}
                <Anchor href="#connect">Open connection instructions</Anchor>
              </Text>
            )}
            {copyFailed && enabled && (
              <Alert color="yellow">
                Copy didn’t work. Download the task and give its contents to your agent.
                <Group mt="sm">
                  <Button onClick={downloadTask}>Download follow-up task</Button>
                  <Button
                    onClick={() => {
                      setCopyFailed(false);
                      rememberWaiting(true);
                    }}
                  >
                    Continue to waiting
                  </Button>
                </Group>
              </Alert>
            )}
            <Group>
              {(!started || instructions) && (
                <Button
                  disabled={!enabled || report === 'checking'}
                  onClick={() => void copyTask()}
                >
                  {waiting ? 'Copy follow-up task again' : 'Copy follow-up task'}
                </Button>
              )}
              {(waiting || report === 'unavailable') && (
                <Button variant="default" loading={checking} onClick={() => void checkNow()}>
                  Check follow-up report
                </Button>
              )}
            </Group>
            {waiting && checked && report === 'missing' && (
              <Text role="status">
                No follow-up report yet. We’ll keep looking while this page is open.
              </Text>
            )}
          </>
        )}
      </Stack>
    </section>
  );
}
