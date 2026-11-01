import { test, expect } from './workspace-fixture.mjs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

test('API docs use one configured endpoint with runnable examples and complete reference', async ({
  page,
  workspace,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (value) => {
          globalThis.__copiedText = value;
        },
      },
    });
  });
  workspace.addResources();
  await workspace.open('#api');
  await expect(page.getByRole('heading', { name: 'API documentation', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'API endpoint' })).toBeVisible();
  await expect(page.getByText('http://127.0.0.1:4389/api', { exact: true })).toBeVisible();
  await expect(page.getByText('http://127.0.0.1:4389', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Region OpenAPI' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy agent instructions' })).toBeVisible();
  await page.getByRole('button', { name: 'Copy endpoint' }).click();
  expect(await page.evaluate(() => globalThis.__copiedText)).toBe('http://127.0.0.1:4389/api');
  await page.getByRole('button', { name: 'Copy agent instructions' }).click();
  expect(await page.evaluate(() => globalThis.__copiedText)).toContain('http://127.0.0.1:4389/api');
  await expect(page.getByText('workspace.listResources()', { exact: false })).toBeVisible();
  await expect(page.getByText('REGION_API', { exact: false })).toHaveCount(0);
  const clientDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download JavaScript client' }).click();
  const clientFile = testInfo.outputPath('workspace-agent.mjs');
  await (await clientDownload).saveAs(clientFile);
  expect(typeof (await import(pathToFileURL(clientFile).href)).connectWorkspace).toBe('function');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download agent instructions', exact: true }).click();
  const downloaded = await downloadPromise;
  const instructions = await readFile(await downloaded.path(), 'utf8');
  expect(instructions).toContain('http://127.0.0.1:4389/api');
  expect(instructions).toContain('Never forward the key');
  expect(instructions).toContain('GET /resources');
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
  await page.getByRole('textbox', { name: 'Find an operation' }).fill('create global key');
  await expect(
    page.getByRole('button', { name: 'POST Create Global Key', exact: true }),
  ).toHaveCount(0);
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
