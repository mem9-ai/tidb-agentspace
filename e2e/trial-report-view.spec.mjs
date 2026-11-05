import { test, expect } from '@playwright/test';

const id = 'fb95da62-aa92-4656-8974-49b6e0111885';
const grant = ['v1', 'a'.repeat(43), id, 2000000000, 'b'.repeat(86)].join('.');
const path = '/studio/report/#' + grant;
const endpoint = '**/api/v1/agent-trial/report-view';
const sample = {
  id,
  sample: 'us-sales-v1',
  stateSales: {
    California: 48000,
    Texas: 20000,
    'New York': 12000,
    Washington: 8000,
    Florida: 7000,
    Massachusetts: 5000,
  },
  leadingStateProducts: null,
  revision: 1,
};

test('original Studio link opens the latest saved report without a session @visual', async ({
  page,
  context,
}, testInfo) => {
  let revision = 1;
  const apiPaths = [];
  await context.addCookies([
    { name: 'studio_session', value: 'synthetic', domain: '127.0.0.1', path: '/' },
  ]);
  page.on('request', (request) => {
    if (request.url().includes('/api/') || request.url().includes('config.json'))
      apiPaths.push(new URL(request.url()).pathname);
  });
  await page.route(endpoint, async (route) => {
    const req = route.request();
    const headers = await req.allHeaders();
    expect(req.method()).toBe('GET');
    expect(new URL(req.url()).search).toBe('');
    expect(headers.authorization).toBe('TrialView ' + grant);
    expect(headers.cookie).toBeUndefined();
    expect(headers.referer).toBeUndefined();
    await route.fulfill({
      json: {
        ...sample,
        revision,
        expiresAt: Math.floor(Date.now() / 1000) + 172800,
        leadingStateProducts: revision === 2 ? { Monitors: 18000 } : null,
      },
    });
  });
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'US sales report' })).toBeVisible();
  await expect(page.getByRole('row', { name: 'California $48,000 48%' })).toBeVisible();
  await expect(page.getByText(/Top product in/)).toHaveCount(0);
  revision = 2;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Top product in California' })).toBeVisible();
  await expect(page.getByText(/Monitors generated/)).toHaveText(/\$18,000.*37.5%/);
  await expect(page).toHaveURL(new RegExp('#v1\\.'));
  expect(apiPaths).toEqual([
    '/studio/api/v1/agent-trial/report-view',
    '/studio/api/v1/agent-trial/report-view',
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.VISUAL_SCREENSHOTS)
    await page.screenshot({ path: testInfo.outputPath('report.png'), fullPage: true });
});

test('viewer handles unavailable, invalid and expired links and clears an open report at expiry', async ({
  page,
}) => {
  let status = 503;
  await page.clock.install();
  await page.route(endpoint, (route) =>
    route.fulfill({ status, json: { ...sample, expiresAt: Math.floor(Date.now() / 1000) + 90 } }),
  );
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'The report could not be loaded' })).toBeVisible();
  status = 200;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'US sales report' })).toBeVisible();
  await page.clock.fastForward(92000);
  await expect(page.getByRole('heading', { name: 'This report link has expired' })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  status = 410;
  await page.reload();
  await expect(page.getByText(/Markdown file your agent saved/)).toBeVisible();
  await page.goto('/studio/report/#incomplete');
  await expect(
    page.getByRole('heading', { name: 'This report link is unavailable' }),
  ).toBeVisible();
});
