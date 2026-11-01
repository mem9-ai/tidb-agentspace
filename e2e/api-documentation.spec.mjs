import { test, expect } from './workspace-fixture.mjs';
import { readFile } from 'node:fs/promises';

test('API docs explain both authorities, runnable examples and the complete generated reference', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.addResources();
  await workspace.open('#api');
  await expect(page.getByRole('heading', { name: 'API documentation', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Global OpenAPI', exact: true })).toHaveAttribute(
    'href',
    'http://127.0.0.1:4389/api/global/openapi.json',
  );
  await expect(page.getByRole('link', { name: 'Region OpenAPI', exact: true })).toHaveAttribute(
    'href',
    'http://127.0.0.1:4389/openapi.json',
  );
  await expect(
    page.getByText('Send data requests directly to Region.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'JavaScript', exact: true }).click();
  await expect(page.getByText('const issuance = await json(', { exact: false })).toBeVisible();
  await page.getByRole('tab', { name: 'Python', exact: true }).click();
  await expect(page.getByText('import os, json, urllib.request', { exact: false })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download WORKSPACE.md', exact: true }).click();
  const downloaded = await downloadPromise;
  const instructions = await readFile(await downloaded.path(), 'utf8');
  expect(instructions).toContain('http://127.0.0.1:4389/api/global');
  expect(instructions).toContain('Send it ONLY to POST Global');
  expect(instructions).toContain('renew directly at Region');
  await page.getByRole('textbox', { name: 'Find an operation' }).fill('file metadata');
  await page
    .getByRole('button', {
      name: 'GET Read file identity and an opaque conditional-write version',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Read file identity and an opaque conditional-write version',
    }),
  ).toBeVisible();
  await page.getByRole('combobox', { name: 'API authority' }).selectOption('Global');
  await page.getByRole('textbox', { name: 'Find an operation' }).fill('create global key');
  await page.getByRole('button', { name: 'POST Create Global Key', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Create Global Key', exact: true })).toBeVisible();
  await expect(page.getByText('Owner only. Unix-second expiry.', { exact: false })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
  if (process.env.API_SCREENSHOTS) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath('api-documentation.png'), fullPage: false });
  }
});

test('pending Key revocation stays explicit and retries policy delivery through Global', async ({
  page,
  workspace,
}) => {
  workspace.state.keys = [
    {
      id: '2ae5f2cb-0f41-4f69-b57b-c129ab5f739a',
      name: 'paused-agent',
      scopes: ['resources:read'],
      resourceIds: ['*'],
      createdAt: '2026-01-01T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      revokedAt: '2026-11-01T00:00:00Z',
      regionalStatus: 'pending',
    },
  ];
  await workspace.open('#keys');
  await expect(page.getByText('Revocation pending', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry delivery', exact: true }).click();
  await expect(page.getByText('Region policy applied.', { exact: true })).toBeVisible();
  await expect(page.getByText('Revocation pending', { exact: true })).toHaveCount(0);
  const delivery = workspace.requests.find(
    (r) => r.path.endsWith('/key-policy-deliveries') && r.method === 'POST',
  );
  expect(delivery.path).toContain('/api/global/api/');
  expect(delivery.body).toEqual({ keyId: '2ae5f2cb-0f41-4f69-b57b-c129ab5f739a', keyVersion: 1 });
});
