import { test, expect } from '@playwright/test';

test('privacy choice works while configuration is still loading', async ({ page }) => {
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
    await route.fulfill({ status: 503 });
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
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Optional browser analytics is off.');
});
