import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Stack, Text, Title } from '@tidbcloud/uikit';
import { TrialReportContent, type SalesReport } from './TrialReportContent';
import './trial-report.css';

type Status = 'loading' | 'invalid' | 'expired' | 'revoked' | 'unavailable';
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
    !('id' in raw) ||
    typeof raw.id !== 'string' ||
    !('markdown' in raw) ||
    typeof raw.markdown !== 'string' ||
    !raw.markdown ||
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
    id: raw.id,
    markdown: raw.markdown,
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
  revoked: [
    'This report is no longer shared',
    'The owner closed this link. Their local report is retained.',
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
    let expiryTimer: number | undefined;
    let refreshTimer: number | undefined;
    let inFlight = false;
    let stopped = false;
    let loaded = false;
    let failures = 0;
    const endpoint = window.location.pathname.replace(
      /\/report\/?$/,
      '/api/v1/agent-trial/report-view',
    );
    async function load() {
      if (inFlight || stopped || controller.signal.aborted) return;
      inFlight = true;
      window.clearTimeout(refreshTimer);
      try {
        const res = await fetch(endpoint, {
          headers: { Authorization: 'TrialView ' + grant },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          if ([400, 401, 403, 404, 410].includes(res.status)) {
            const error: unknown = await res.json().catch(() => null);
            const revoked =
              error &&
              typeof error === 'object' &&
              'error' in error &&
              error.error &&
              typeof error.error === 'object' &&
              'code' in error.error &&
              error.error.code === 'REPORT_SHARING_REVOKED';
            stopped = true;
            window.clearTimeout(expiryTimer);
            setResult(res.status === 410 ? (revoked ? 'revoked' : 'expired') : 'invalid');
          } else {
            failures++;
            if (!loaded) setResult('unavailable');
          }
          return;
        }
        const report = parseReport(await res.json());
        if (controller.signal.aborted) return;
        const remaining = report.expiresAt * 1000 - Date.now();
        if (remaining <= 0) {
          stopped = true;
          setResult('expired');
          return;
        }
        setResult((current) => {
          if (
            typeof current !== 'string' &&
            current.id === report.id &&
            current.revision > report.revision
          )
            return current;
          if (
            typeof current !== 'string' &&
            current.id === report.id &&
            current.revision === report.revision
          )
            return current;
          return report;
        });
        loaded = true;
        failures = 0;
        window.clearTimeout(expiryTimer);
        expiryTimer = window.setTimeout(() => {
          stopped = true;
          window.clearTimeout(refreshTimer);
          setResult('expired');
        }, remaining);
      } catch {
        if (!controller.signal.aborted) {
          failures++;
          if (!loaded) setResult('unavailable');
        }
      } finally {
        inFlight = false;
        if (!stopped && !controller.signal.aborted && document.visibilityState === 'visible')
          refreshTimer = window.setTimeout(
            () => void load(),
            Math.min(60000, 10000 * 2 ** Math.min(failures, 3)),
          );
      }
    }
    setResult('loading');
    void load();
    const visible = () => {
      if (document.visibilityState === 'visible') void load();
      else window.clearTimeout(refreshTimer);
    };
    const focused = () => void load();
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', focused);
    window.addEventListener('pageshow', focused);
    return () => {
      controller.abort();
      window.clearTimeout(expiryTimer);
      window.clearTimeout(refreshTimer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('focus', focused);
      window.removeEventListener('pageshow', focused);
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
    document.title = 'US sales report · TiDB AgentSpace';
  }, []);
  return <Viewer key={grant} grant={grant} />;
}
