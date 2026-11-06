import { test, expect } from './workspace-fixture.mjs';
import { mkdir } from 'node:fs/promises';

test.beforeEach(async ({ workspace }) => {
  void workspace;
});

const counts = {
  pageViews: 21,
  tryClicks: 6,
  signInClicks: 2,
  ready: 10,
  successes: 8,
  failures: 2,
  helpful: 3,
  votes: 4,
  events: { 'report_saved:success': 4, 'analysis:success': 4, 'analysis:failure': 2 },
  sources: { social: 8, search: 4 },
  campaigns: { launch: 8 },
  journeys: { agent: 3, self_service: 3 },
};
const summary = () => ({
  authorities: [
    {
      firstUseSources: { social: 4 },
      firstUseCampaigns: { launch: 4 },
      authority: 'global',
      from: '2026-10-28',
      to: '2026-11-04',
      timezone: 'UTC',
      counts,
      sessions: 12,
      trials: 6,
      activeWorkspaces: 4,
      apiWorkspaces: 2,
      cohorts: [
        {
          actor: 'account',
          ready: 10,
          eligible: 10,
          activated: 4,
          d1Eligible: 4,
          d1Returned: 2,
          d7Eligible: 0,
          d7Returned: 0,
        },
      ],
      timeToValueSeconds: { 16: 4 },
      generatedAt: 1793750400,
      unconfirmedEvents: 0,
      coverage: 'best_effort',
    },
  ],
  missingRegions: [],
  definitionsVersion: 1,
  timezone: 'UTC',
  partial: false,
  monitoring: 'not_included',
});

test('@visual Admin shows actual denominators, acquisition, cohorts and freshness', async ({
  page,
  context,
}, testInfo) => {
  const queries = [];
  let status = 200;
  await context.route('**/api/global/operator/analytics/summary?*', (route) => {
    queries.push(new URL(route.request().url()).searchParams);
    return route.fulfill({
      status,
      json: status === 200 ? summary() : { error: { code: 'OPERATOR_SESSION_REQUIRED' } },
    });
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Product insights' })).toBeVisible();
  await expect(page.getByText('Visit sessions', { exact: true })).toBeVisible();
  await expect(page.getByText('12 visit sessions → 6 attributed trials')).toBeVisible();
  await expect(page.getByText('Trial conversion: 50.0% (6/12).', { exact: false })).toBeVisible();
  await expect(
    page.getByText('Activated within 24 hours: 40.0% (4/10)', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('Next-day return: 50.0% (2/4)', { exact: false })).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Visits by source' })
      .getByRole('cell', { name: 'Social', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Period (UTC)').selectOption('today');
  await expect.poll(() => queries.length).toBe(2);
  const today = new Date().toISOString().slice(0, 10);
  expect(queries[1].get('from')).toBe(today);
  await expect(page.getByText('12 visit sessions → 6 attributed trials')).toBeVisible();
  expect(await page.locator('body').evaluate((body) => body.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.ANALYTICS_SCREENSHOTS) {
    await mkdir(process.env.ANALYTICS_SCREENSHOTS, { recursive: true });
    await page.screenshot({
      path: `${process.env.ANALYTICS_SCREENSHOTS}/admin-${testInfo.project.name}.png`,
      fullPage: true,
    });
  }
  status = 401;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Sign in with TiDB Cloud' })).toHaveAttribute(
    'href',
    /\/operator\/auth\/login$/,
  );
  await expect(page.getByText('12 visit sessions → 6 attributed trials')).not.toBeVisible();
});

test('Admin Open workspace uses normal account SSO even with an existing Guest session', async ({
  page,
  context,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  await expect(
    page.getByText('Your temporary workspace expires 48 hours after it was created.'),
  ).toBeVisible();
  const navigation = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await navigation.isVisible()) await navigation.click();
  await expect(page.getByRole('link', { name: /Temporary session$/ })).toBeVisible();
  await context.route('**/api/global/operator/analytics/summary?*', (route) =>
    route.fulfill({ json: summary() }),
  );
  await page.goto('/admin');
  const open = page.getByRole('link', { name: 'Open workspace', exact: true });
  await expect(open).toHaveAttribute('href', 'http://127.0.0.1:4389/api/auth/tidbcloud/login');
  const before = workspace.requests.length;
  await open.click();
  await expect(page).toHaveURL('http://127.0.0.1:4389/api/auth/tidbcloud/login');
  const requests = workspace.requests.slice(before);
  expect(requests).toContainEqual(
    expect.objectContaining({ path: '/api/auth/tidbcloud/login', method: 'GET', query: {} }),
  );
  expect(requests.some((r) => r.path === '/api/auth/guest')).toBe(false);
  expect(requests.some((r) => r.path === '/api/portal/v1/workspaces')).toBe(false);
  expect(requests.some((r) => r.path.includes('/operator/auth/login'))).toBe(false);
});

test('Admin Open workspace retains the local Console entry when SSO is disabled', async ({
  page,
  context,
}) => {
  await context.route('**/api/global/operator/analytics/summary?*', (route) =>
    route.fulfill({ json: summary() }),
  );
  await page.goto('/admin');
  await expect(page.getByRole('link', { name: 'Open workspace', exact: true })).toHaveAttribute(
    'href',
    '/',
  );
});

test('Admin Workspace entry uses the configured login URL and returns to the Console', async ({
  page,
  context,
  workspace,
}) => {
  await context.route('**/api/auth/config', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        loginPath: '/api/auth/tidbcloud/login',
        loginUrl:
          'http://127.0.0.1:4389/api/auth/tidbcloud/login?returnTo=http%3A%2F%2F127.0.0.1%3A4389%2Fadmin&provider=tidbcloud',
        globalApi: { apiOrigin: 'http://127.0.0.1:4389', apiPathPrefix: '/api/global' },
      },
    }),
  );
  await context.route('**/api/global/operator/analytics/summary?*', (route) =>
    route.fulfill({ json: summary() }),
  );
  await page.goto('/admin');
  const open = page.getByRole('link', { name: 'Open workspace', exact: true });
  await expect(open).toHaveAttribute('href', /returnTo=http%3A%2F%2F127.0.0.1%3A4389%2F&/);
  await open.click();
  await expect(page).toHaveURL(/\/api\/auth\/tidbcloud\/login\?/);
  expect(workspace.requests.at(-1)).toMatchObject({
    path: '/api/auth/tidbcloud/login',
    query: { returnTo: 'http://127.0.0.1:4389/', provider: 'tidbcloud' },
  });
});

for (const [status, title] of [
  [401, 'Sign in to Admin'],
  [403, 'Admin access required'],
  [503, 'Insights unavailable'],
]) {
  test(`Admin ${status} distinguishes sign-in, denied access and unavailable data`, async ({
    page,
    context,
  }) => {
    await context.route('**/api/global/operator/analytics/summary?*', (route) =>
      route.fulfill({ status, json: { error: { code: 'UNAVAILABLE' } } }),
    );
    await page.goto('/admin');
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await expect(page.getByText('Visit sessions', { exact: true })).not.toBeVisible();
  });
}

test('@visual public discovery is readable, measures approved sources and respects opt-out', async ({
  page,
  context,
}, testInfo) => {
  const events = [];
  await context.route('**/api/global/analytics/config', (route) =>
    route.fulfill({
      json: { enabled: true, campaigns: ['launch'], policy: 'session_only', version: 1 },
    }),
  );
  await context.route('**/api/global/analytics/events', (route) => {
    events.push(...route.request().postDataJSON().events);
    return route.fulfill({ status: 202, json: { accepted: true, durability: 'queued' } });
  });
  await context.route('**/api/global/analytics/session', (route) => route.fulfill({ status: 204 }));
  await page.goto('/discover/?utm_campaign=launch&secret=must-not-be-captured');
  await expect(
    page.getByRole('heading', { name: 'From a question to a useful result.' }),
  ).toBeVisible();
  const contrasts = await page.locator('main').evaluate((main) => {
    const luminance = (color) => {
      const rgb = color
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number);
      return rgb
        .map((value) => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        })
        .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
    };
    const background = luminance(getComputedStyle(document.body).backgroundColor);
    return ['h1', 'p', '[data-analytics="try"]'].map((selector) => {
      const style = getComputedStyle(main.querySelector(selector));
      const text = luminance(style.color);
      const surface = selector.includes('data-analytics')
        ? luminance(style.backgroundColor)
        : background;
      return (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05);
    });
  });
  for (const contrast of contrasts) expect(contrast).toBeGreaterThanOrEqual(4.5);
  await expect.poll(() => events.length).toBe(1);
  expect(events[0].event).toMatchObject({ name: 'public_page_view', campaign: 'launch' });
  expect(JSON.stringify(events)).not.toContain('must-not-be-captured');
  if (process.env.ANALYTICS_SCREENSHOTS) {
    await mkdir(process.env.ANALYTICS_SCREENSHOTS, { recursive: true });
    await page.screenshot({
      path: `${process.env.ANALYTICS_SCREENSHOTS}/discover-${testInfo.project.name}.png`,
      fullPage: true,
    });
  }
  await page.getByRole('link', { name: 'Privacy and analytics choices' }).click();
  await page.getByRole('button', { name: 'Turn optional analytics off' }).click();
  await expect(page.getByRole('status')).toHaveText('Optional browser analytics is off.');
  await page.getByRole('link', { name: 'TiDB Agent Workspace' }).click();
  await expect(
    page.getByRole('heading', { name: 'From a question to a useful result.' }),
  ).toBeVisible();
  expect(events).toHaveLength(1);
  const missing = await page.request.get('/discover/does-not-exist/');
  expect(missing.status()).toBe(404);
});
