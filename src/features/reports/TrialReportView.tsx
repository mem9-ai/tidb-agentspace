import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Stack, Text, Title } from '@tidbcloud/uikit';
import { TrialReportContent, type SalesReport } from './TrialReportContent';
import './trial-report.css';

type Status = 'loading' | 'invalid' | 'expired' | 'unavailable';
function amounts(value: unknown): SalesReport['states'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
  const rows = Object.entries(value);
  if (
    !rows.length ||
    !rows.every(([, n]) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0)
  )
    throw Error();
  return rows.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function parseReport(raw: unknown): SalesReport {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('sample' in raw) ||
    raw.sample !== 'us-sales-v1' ||
    !('revision' in raw) ||
    (raw.revision !== 1 && raw.revision !== 2) ||
    !('expiresAt' in raw) ||
    typeof raw.expiresAt !== 'number' ||
    !Number.isSafeInteger(raw.expiresAt) ||
    !('stateSales' in raw) ||
    !('leadingStateProducts' in raw)
  )
    throw Error();
  return {
    revision: raw.revision,
    expiresAt: raw.expiresAt,
    states: amounts(raw.stateSales),
    products: raw.revision === 2 ? amounts(raw.leadingStateProducts) : [],
  };
}

const messages = {
  loading: ['Opening your report…', ''],
  expired: [
    'This report link has expired',
    'The 48-hour trial has ended. Open the Markdown file your agent saved to keep reading.',
  ],
  invalid: [
    'This report link is unavailable',
    'Open the full link your agent returned after saving the report.',
  ],
  unavailable: ['The report could not be loaded', 'Try again to read the latest saved version.'],
} as const;
const grantPattern = /^v1\.[A-Za-z0-9_-]{43}\.[a-f0-9-]{36}\.[0-9]{1,12}\.[A-Za-z0-9_-]{86}$/;

function Viewer({ grant }: { grant: string }) {
  const [result, setResult] = useState<Status | SalesReport>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!grantPattern.test(grant)) {
      setResult('invalid');
      return;
    }
    const controller = new AbortController();
    let timer: number | undefined;
    const endpoint = window.location.pathname.replace(
      /\/report\/?$/,
      '/api/v1/agent-trial/report-view',
    );
    async function load() {
      try {
        const res = await fetch(endpoint, {
          headers: { Authorization: 'TrialView ' + grant },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          setResult(
            res.status === 410
              ? 'expired'
              : [400, 401, 403, 404].includes(res.status)
                ? 'invalid'
                : 'unavailable',
          );
          return;
        }
        const report = parseReport(await res.json());
        if (controller.signal.aborted) return;
        const remaining = report.expiresAt * 1000 - Date.now();
        if (remaining <= 0) {
          setResult('expired');
          return;
        }
        setResult(report);
        timer = window.setTimeout(() => setResult('expired'), remaining);
      } catch {
        if (!controller.signal.aborted) setResult('unavailable');
      }
    }
    setResult('loading');
    void load();
    const refresh = () => setAttempt((n) => n + 1);
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) refresh();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('pageshow', restored);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('pageshow', restored);
    };
  }, [grant, attempt]);
  return (
    <main className="trial-report">
      <header>
        <span className="brand-mark">TiDB</span>
        <Text size="sm" c="var(--text-secondary)">
          Agent Workspace
        </Text>
      </header>
      <article>
        {typeof result !== 'string' ? (
          <TrialReportContent report={result} />
        ) : (
          <Stack role="status">
            <Title order={1}>{messages[result][0]}</Title>
            {messages[result][1] && <Text>{messages[result][1]}</Text>}
            {result === 'unavailable' && (
              <Button onClick={() => setAttempt((n) => n + 1)} w="fit-content">
                Try again
              </Button>
            )}
          </Stack>
        )}
      </article>
    </main>
  );
}
const getGrant = () => window.location.hash.slice(1);
function subscribe(listener: () => void) {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}
export function TrialReportView() {
  const grant = useSyncExternalStore(subscribe, getGrant);
  useEffect(() => {
    document.title = 'US sales report · TiDB Agent Workspace';
  }, []);
  return <Viewer key={grant} grant={grant} />;
}
