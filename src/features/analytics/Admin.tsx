import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Anchor,
  Button,
  Group,
  Loader,
  NativeSelect,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@tidbcloud/uikit';
import { globalApiSettings } from '../../api/client';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid analytics response.');
  return Object.fromEntries(Object.entries(value));
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('Invalid analytics count.');
  return value;
}
function counts(value: unknown): [string, number][] {
  return Object.entries(object(value)).map(([k, v]) => [k, number(v)]);
}
type Cohort = {
  actor: string;
  ready: number;
  eligible: number;
  activated: number;
  d1Eligible: number;
  d1Returned: number;
  d7Eligible: number;
  d7Returned: number;
};
type Insights = {
  sessions: number;
  trials: number;
  active: number;
  api: number;
  pageViews: number;
  ready: number;
  successes: number;
  failures: number;
  helpful: number;
  votes: number;
  journeys: [string, number][];
  unconfirmed: number;
  ttv: [string, number][];
  operations: [string, number][];
  firstUseSources: [string, number][];
  firstUseCampaigns: [string, number][];
  sources: [string, number][];
  campaigns: [string, number][];
  cohorts: Cohort[];
  missing: string[];
  generated: number;
};
function decode(value: unknown): Insights {
  const data = object(value);
  if (!Array.isArray(data.authorities) || !Array.isArray(data.missingRegions))
    throw new Error('Invalid analytics response.');
  const total: Insights = {
    sessions: 0,
    trials: 0,
    active: 0,
    api: 0,
    pageViews: 0,
    ready: 0,
    successes: 0,
    failures: 0,
    helpful: 0,
    votes: 0,
    journeys: [],
    unconfirmed: 0,
    ttv: [],
    operations: [],
    firstUseSources: [],
    firstUseCampaigns: [],
    sources: [],
    campaigns: [],
    cohorts: [],
    missing: data.missingRegions.filter((v): v is string => typeof v === 'string'),
    generated: Infinity,
  };
  const merge = (target: [string, number][], extra: [string, number][]) => {
    for (const [label, count] of extra) {
      const existing = target.find(([key]) => key === label);
      if (existing) existing[1] += count;
      else target.push([label, count]);
    }
    target.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  for (const item of data.authorities) {
    const authority = object(item);
    const c = object(authority.counts);
    total.sessions += number(authority.sessions);
    total.trials += number(authority.trials);
    total.active += number(authority.activeWorkspaces);
    total.api += number(authority.apiWorkspaces);
    total.pageViews += number(c.pageViews);
    total.ready += number(c.ready);
    total.successes += number(c.successes);
    total.failures += number(c.failures);
    total.helpful += number(c.helpful);
    total.votes += number(c.votes);
    merge(total.journeys, counts(c.journeys));
    total.unconfirmed += number(authority.unconfirmedEvents);
    total.generated = Math.min(total.generated, number(authority.generatedAt));
    merge(total.ttv, counts(authority.timeToValueSeconds));
    merge(total.operations, counts(c.events));
    merge(total.firstUseSources, counts(authority.firstUseSources));
    merge(total.firstUseCampaigns, counts(authority.firstUseCampaigns));
    merge(total.sources, counts(c.sources));
    merge(total.campaigns, counts(c.campaigns));
    if (!Array.isArray(authority.cohorts)) throw new Error('Invalid analytics cohorts.');
    for (const item of authority.cohorts) {
      const c = object(item);
      if (typeof c.actor !== 'string') throw new Error('Invalid cohort.');
      total.cohorts.push({
        actor: c.actor,
        ready: number(c.ready),
        eligible: number(c.eligible),
        activated: number(c.activated),
        d1Eligible: number(c.d1Eligible),
        d1Returned: number(c.d1Returned),
        d7Eligible: number(c.d7Eligible),
        d7Returned: number(c.d7Returned),
      });
    }
  }
  return total;
}
const timeToValue = (buckets: [string, number][], fraction: number) => {
  const ordered = [...buckets].sort((a, b) => Number(a[0]) - Number(b[0]));
  const total = ordered.reduce((sum, [, count]) => sum + count, 0);
  if (!total) return 'Not enough data';
  let cumulative = 0;
  for (const [seconds, count] of ordered) {
    cumulative += count;
    if (cumulative >= Math.ceil(total * fraction))
      return `up to ${Number(seconds).toLocaleString()} seconds`;
  }
  return 'Not enough data';
};
const ratio = (n: number, d: number) =>
  d ? `${((100 * n) / d).toFixed(1)}% (${n}/${d})` : 'Not enough data';
function displayLabel(value: string) {
  const labels: Record<string, string> = {
    ai_referral: 'AI search',
    direct_or_unknown: 'Direct or unknown',
    self_service: 'Explore yourself',
    agent: 'Try with an agent',
    unattributed: 'Unattributed',
  };
  const label =
    labels[value] ||
    value
      .replaceAll('_', ' ')
      .replace(':success', ' · completed')
      .replace(':failure', ' · unsuccessful');
  return label.charAt(0).toUpperCase() + label.slice(1);
}
function Breakdown({
  title,
  rows,
  column = 'Action',
  metric = 'Count',
}: {
  title: string;
  rows: [string, number][];
  column?: string;
  metric?: string;
}) {
  return (
    <Paper component="section" role="region" aria-label={title} withBorder p="lg">
      <Title order={2} size="h3" mb="md">
        {title}
      </Title>
      {rows.length ? (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{column}</Table.Th>
              <Table.Th>{metric}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map(([label, count]) => (
              <Table.Tr key={label}>
                <Table.Td>{displayLabel(label)}</Table.Td>
                <Table.Td>{count.toLocaleString()}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      ) : (
        <Text c="dimmed">No activity recorded in this period.</Text>
      )}
    </Paper>
  );
}
export function Admin() {
  const [range, setRange] = useState(() => {
    try {
      const value = sessionStorage.getItem('admin-range');
      return value && ['today', '7', '30'].includes(value) ? value : '7';
    } catch {
      return '7';
    }
  });
  const [base, setBase] = useState('');
  const [state, setState] = useState<'loading' | 'signed-out' | 'denied' | 'ready' | 'error'>(
    'loading',
  );
  const [error, setError] = useState('');
  const [data, setData] = useState<Insights>();
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setState('loading');
      setError('');
      try {
        const settings = await globalApiSettings();
        setBase(settings.baseUrl);
        const now = new Date();
        const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const from = new Date(today);
        from.setUTCDate(
          from.getUTCDate() - (range === 'today' ? 0 : range === '30' ? 29 : Number(range)),
        );
        const to = new Date(today);
        if (range === 'today' || range === '30') to.setUTCDate(to.getUTCDate() + 1);
        const response = await fetch(
          `${settings.baseUrl}/operator/analytics/summary?from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}`,
          { credentials: 'include', cache: 'no-store', signal },
        );
        if (signal?.aborted) return;
        if (response.status === 401) {
          setState('signed-out');
          return;
        }
        if (response.status === 403) {
          setState('denied');
          return;
        }
        if (!response.ok) throw new Error('Usage data is unavailable. Try again shortly.');
        const result: unknown = await response.json();
        setData(decode(result));
        setState('ready');
      } catch (e) {
        if (!signal?.aborted) {
          setError(e instanceof Error ? e.message : 'Usage data is unavailable.');
          setState('error');
        }
      }
    },
    [range],
  );
  useEffect(() => {
    document.title = 'Admin · Product insights';
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  return (
    <Stack maw={1120} mx="auto" p={{ base: 'md', sm: 'xl' }} gap="lg">
      <Group justify="space-between">
        <div>
          <Text size="sm" c="dimmed">
            Admin
          </Text>
          <Title order={1}>Product insights</Title>
        </div>
        <Anchor href={import.meta.env.BASE_URL}>Open workspace</Anchor>
      </Group>
      <Text c="dimmed">
        Understand how people discover the product, reach a useful result, and return. All dates use
        UTC.
      </Text>
      {state === 'loading' && (
        <Group role="status">
          <Loader size="sm" />
          <Text>Loading product insights…</Text>
        </Group>
      )}
      {state === 'signed-out' && (
        <Paper withBorder p="xl">
          <Title order={2} size="h3">
            Sign in to Admin
          </Title>
          <Text my="md">Use your TiDB Cloud account with a verified PingCAP email address.</Text>
          <Button component="a" href={base + '/operator/auth/login'}>
            Sign in with TiDB Cloud
          </Button>
        </Paper>
      )}
      {state === 'denied' && (
        <Alert color="red" title="Admin access required">
          This account does not have access. Sign in with a TiDB Cloud account whose verified email
          ends in @pingcap.com.
        </Alert>
      )}
      {state === 'error' && (
        <Alert color="red" title="Insights unavailable">
          {error}
          <Button display="block" mt="md" onClick={() => void load()}>
            Retry
          </Button>
        </Alert>
      )}
      {state === 'ready' && data && (
        <>
          <Group justify="space-between">
            <NativeSelect
              label="Period (UTC)"
              value={range}
              onChange={(e) => {
                setRange(e.currentTarget.value);
                try {
                  sessionStorage.setItem('admin-range', e.currentTarget.value);
                } catch {
                  /* Optional view preference. */
                }
              }}
              data={[
                { value: 'today', label: 'Today · partial' },
                { value: '7', label: 'Last 7 complete days' },
                { value: '30', label: 'Last 30 days · includes today' },
              ]}
            />
            <Group>
              <Button variant="default" onClick={() => void load()}>
                Refresh
              </Button>
              <Button
                variant="subtle"
                onClick={async () => {
                  const response = await fetch(base + '/operator/auth/logout', {
                    method: 'POST',
                    credentials: 'include',
                  });
                  if (response.ok) {
                    setData(undefined);
                    setState('signed-out');
                  } else {
                    setError('Sign out failed. Try again.');
                    setState('error');
                  }
                }}
              >
                Sign out
              </Button>
            </Group>
          </Group>
          {data.missing.length > 0 && (
            <Alert color="yellow" title="Partial coverage">
              Usage from {data.missing.join(', ')} is unavailable. Totals include reporting
              authorities only.
            </Alert>
          )}
          {data.unconfirmed > 0 && (
            <Alert color="yellow" title="Some events were not confirmed">
              {data.unconfirmed} events were dropped or their writes could not be confirmed since
              this process started.
            </Alert>
          )}
          <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }}>
            {[
              ['Visit sessions', data.sessions],
              ['Active workspaces', data.active],
              ['API workspaces', data.api],
              ['Successful actions', data.successes],
            ].map(([label, value]) => (
              <Paper key={label} withBorder p="lg">
                <Text c="dimmed">{label}</Text>
                <Text fz={32} fw={600}>
                  {value}
                </Text>
              </Paper>
            ))}
          </SimpleGrid>
          {data.pageViews === 0 && data.active === 0 && (
            <Alert title="No usage recorded yet">
              Share a product guide or try the product to begin collecting data. Optional analytics
              can be turned off; visits are approximate.
            </Alert>
          )}
          <Paper withBorder p="lg">
            <Title order={2} size="h3">
              From discovery to a useful result
            </Title>
            <Text mt="sm">
              {data.sessions} visit sessions → {data.trials} attributed trials
            </Text>
            <Text size="sm" c="dimmed">
              Trial conversion: {ratio(data.trials, data.sessions)}. API-only workspaces are
              measured separately.
            </Text>
            <Text mt="md">
              {data.ready} workspaces created · {data.successes} successful actions ·{' '}
              {data.failures} unsuccessful actions
            </Text>
          </Paper>
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            <Breakdown
              title="Visits by source"
              rows={data.sources}
              column="Source"
              metric="Sessions"
            />
            <Breakdown
              title="Visits by campaign"
              rows={data.campaigns}
              column="Campaign"
              metric="Sessions"
            />
            <Breakdown
              title="Useful results by source"
              column="Source"
              metric="Workspaces"
              rows={data.firstUseSources}
            />
            <Breakdown
              title="Useful results by campaign"
              column="Campaign"
              metric="Workspaces"
              rows={data.firstUseCampaigns}
            />
          </SimpleGrid>
          <Paper withBorder p="lg">
            <Title order={2} size="h3" mb="md">
              Activation and return usage
            </Title>
            <Text mb="md">
              Time to first useful result among activated workspaces: median{' '}
              {timeToValue(data.ttv, 0.5)} · p90 {timeToValue(data.ttv, 0.9)}. Values are histogram
              upper bounds.
            </Text>
            {data.cohorts.length ? (
              data.cohorts.map((c, index) => (
                <Stack key={`${c.actor}-${index}`} gap="xs" mb="md">
                  <Text fw={600}>
                    {c.actor === 'guest' ? 'Temporary workspaces' : 'Account workspaces'}
                  </Text>
                  <Text>
                    Activated within 24 hours: {ratio(c.activated, c.eligible)} ·{' '}
                    {c.ready - c.eligible} pending
                  </Text>
                  <Text>
                    Next-day return: {ratio(c.d1Returned, c.d1Eligible)} · Day-7 return:{' '}
                    {ratio(c.d7Returned, c.d7Eligible)}
                  </Text>
                </Stack>
              ))
            ) : (
              <Text c="dimmed">Cohorts appear after a workspace reaches a useful result.</Text>
            )}
          </Paper>
          <Paper withBorder p="lg">
            <Title order={2} size="h3">
              Was the result useful?
            </Title>
            <Text mt="md">{ratio(data.helpful, data.votes)} answered yes.</Text>
            <Text size="sm" c="dimmed">
              Optional feedback reflects people who answered, not everyone who used the product.
            </Text>
          </Paper>
          <Breakdown title="Chosen trial paths" rows={data.journeys} metric="Selections" />
          <Breakdown title="Product actions and outcomes" rows={data.operations} />
          <Text size="sm" c="dimmed">
            Updated {new Date(data.generated * 1000).toISOString().replace('T', ' ').slice(0, 19)}{' '}
            UTC. Best-effort collection; crash-related loss is unknown. Visits are sessions, not
            people. Cohorts cover the retained 30-day window. HTTP monitoring is separate.
          </Text>
        </>
      )}
    </Stack>
  );
}
