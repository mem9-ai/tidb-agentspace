import { test, expect } from '@playwright/test';

test('privacy choice works while configuration is still loading', async ({ page }) => {
  const sessionActions = [];
  let releaseConfiguration;
  const configurationReady = new Promise((resolve) => {
    releaseConfiguration = resolve;
  });
  let configurationRequested;
  const requested = new Promise((resolve) => {
    configurationRequested = resolve;
  });
  await page.route('**/config.json', async (route) => {
    configurationRequested();
    await configurationReady;
    await route.fulfill({ json: { apiOrigin: 'http://127.0.0.1:4318' } });
  });
  await page.route('**/api/auth/config', (route) =>
    route.fulfill({
      json: {
        enabled: false,
        globalApi: { apiOrigin: 'http://127.0.0.1:4318', apiPathPrefix: '/api/global' },
      },
    }),
  );
  await page.route('**/api/global/analytics/config', (route) =>
    route.fulfill({ json: { enabled: true, campaigns: [] } }),
  );
  await page.route('**/api/global/analytics/session', (route) => {
    sessionActions.push(route.request().method());
    return route.fulfill({ status: 204 });
  });
  try {
    await page.goto('/discover/privacy/', { waitUntil: 'domcontentloaded' });
    await requested;
    await page.getByRole('button', { name: 'Turn optional analytics off' }).click();
    await expect(page.getByRole('status')).toHaveText('Optional browser analytics is off.');
    expect(await page.evaluate(() => localStorage.getItem('product-analytics-disabled'))).toBe(
      'true',
    );
  } finally {
    releaseConfiguration();
  }
  await expect.poll(() => sessionActions).toContain('DELETE');
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Optional browser analytics is off.');
});
