import { readFile } from 'node:fs/promises';
import { test, expect } from './workspace-fixture.mjs';

const id = 'fb95da62-aa92-4656-8974-49b6e0111885';
const grant = ['v1', 'a'.repeat(43), id, 2000000000, 'b'.repeat(86)].join('.');
const path = '/studio/report/#' + grant;
const endpoint = '**/api/v1/agent-trial/report-view';
const source = await readFile(
  new URL('../specs/gh-150/fixtures/us-sales.csv', import.meta.url),
  'utf8',
);
const sourcePath = '/US sales sample.csv';
const savedReport = '/US sales report - revision 2.md';
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
        leadingStateProducts:
          revision === 2
            ? { Keyboards: 10000, Webcams: 10000, Monitors: 18000, Headsets: 10000 }
            : null,
      },
    });
  });
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'US sales report' })).toBeVisible();
  await expect(page.getByRole('row', { name: 'California $48,000 48%' })).toBeVisible();
  await expect(page.getByText(/Top product in/)).toHaveCount(0);
  const followUp = page.getByRole('region', {
    name: /Which product brought in the most sales in California/,
  });
  await expect(followUp).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open report files' })).toHaveCount(0);
  if (process.env.VISUAL_SCREENSHOTS)
    await page.screenshot({ path: testInfo.outputPath('first-report.png'), fullPage: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await followUp.getByRole('button', { name: 'Copy follow-up' }).click();
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  expect(prompt).toContain('https://drive9.ai/studio/skills/drive9-workspace/SKILL.md');
  expect(prompt).toContain('top product by sales in California');
  expect(prompt).not.toContain(grant);
  await expect(followUp.getByRole('status')).toContainText('Paste it into your project chat');
  revision = 2;
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Monitors' })).toBeInViewport();
  await expect(page.getByText('Top product in California')).toBeVisible();
  await expect(page.locator('dl')).toContainText('$18,000');
  await expect(page.locator('dl')).toContainText('37.5%');
  const bars = page.getByRole('region', { name: 'Sales by product' }).getByRole('listitem');
  await expect(bars).toHaveText([
    'Monitors$18,000',
    'Headsets$10,000',
    'Keyboards$10,000',
    'Webcams$10,000',
  ]);
  const original = page.getByText('Original state rankings');
  const stateTable = page.getByRole('table', { name: 'Sales by state' });
  await expect(stateTable).toBeHidden();
  await original.click();
  await expect(stateTable.getByRole('row', { name: 'California $48,000 48%' })).toBeVisible();
  await original.click();
  await expect(stateTable).toBeHidden();
  await expect(page).toHaveURL(new RegExp('#v1\\.'));
  await expect(followUp).toHaveCount(0);
  await expect(page.getByText(/Revision 2 · Complete/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open report files' })).toBeVisible();
  expect(apiPaths).toEqual([
    '/studio/api/v1/agent-trial/report-view',
    '/studio/api/v1/agent-trial/report-view',
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.VISUAL_SCREENSHOTS)
    await page.screenshot({ path: testInfo.outputPath('report.png'), fullPage: true });
  const privatePrompt = page.getByRole('button', { name: 'Copy next question' });
  await privatePrompt.click();
  const own = await page.evaluate(() => navigator.clipboard.readText());
  expect(own).toContain('Use the existing sample and report');
  expect(own).toContain(
    'Use these figures from the report: California $48,000, Texas $20,000 out of $100,000',
  );
  await expect(page.getByRole('status')).toContainText('continue this report');
  expect(own).toContain(`In a new chat, use ${await page.evaluate(() => navigator.language)}`);
  expect(own).not.toContain(grant);
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
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: async () => {
        throw new DOMException('Denied', 'NotAllowedError');
      },
    }),
  );
  await page.getByRole('button', { name: 'Copy follow-up' }).click();
  await expect(
    page.getByRole('textbox', { name: 'Select and copy the follow-up for your agent' }),
  ).toHaveValue(/top product by sales in California/);
  await page.clock.fastForward(92000);
  await expect(page.getByRole('heading', { name: 'This report link has expired' })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy follow-up' })).toHaveCount(0);
  status = 410;
  await page.reload();
  await expect(page.getByText(/Markdown file your agent saved/)).toBeVisible();
  await page.goto('/studio/report/#incomplete');
  await expect(
    page.getByRole('heading', { name: 'This report link is unavailable' }),
  ).toBeVisible();
});

async function openReportForUpload(page, workspace, loseReceipt = false) {
  let writes = 0;
  await page.route('**/api/v1/agent-trial/us-sales-v1.csv', (route) =>
    route.fulfill({ body: source, contentType: 'text/csv' }),
  );
  await page.route('**/files', (route) => {
    const request = route.request();
    if (request.method() !== 'PUT') return route.fallback();
    expect(request.headers()['if-none-match']).toBe('*');
    expect(request.headers().authorization || '').not.toContain('TrialView');
    const body = request.postDataJSON();
    writes++;
    if (
      workspace.state.files.some(
        (file) => file.resourceId === body.resourceId && file.path === body.path,
      )
    )
      return route.fulfill({
        status: 412,
        json: { error: { code: 'PRECONDITION_FAILED', message: 'Exists' } },
      });
    workspace.state.files.push({
      ...body,
      id: body.resourceId + body.path,
      size: Buffer.byteLength(body.content),
      version: '"saved-report"',
      updatedAt: new Date().toISOString(),
    });
    if (loseReceipt && body.path === savedReport) {
      loseReceipt = false;
      return route.fulfill({
        status: 503,
        json: { error: { code: 'UNAVAILABLE', message: 'Connection interrupted' } },
      });
    }
    return route.fulfill({ status: 201, json: { data: workspace.state.files.at(-1) } });
  });
  await page.route(endpoint, (route) =>
    route.fulfill({
      json: {
        ...sample,
        revision: 2,
        expiresAt: Math.floor(Date.now() / 1000) + 172800,
        leadingStateProducts: { Monitors: 18000 },
      },
    }),
  );
  await page.goto(path);
  await page.getByRole('button', { name: 'Open report files' }).click();
  return () => writes;
}

test('report click saves both files for a new Guest and reuses them on return', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  const guestPosts = () =>
    workspace.requests.filter((r) => r.path === '/api/auth/guest' && r.method === 'POST');
  const writes = await openReportForUpload(page, workspace);
  const upload = page.getByRole('button', { name: 'Upload', exact: true });
  await expect(upload).toBeEnabled();
  const originals = workspace.state.files.filter((f) => [sourcePath, savedReport].includes(f.path));
  expect(originals).toHaveLength(2);
  expect(originals.find((f) => f.path === sourcePath).content).toBe(source);
  expect(originals.find((f) => f.path === savedReport).content).toContain('Monitors');
  await expect(page.getByRole('heading', { name: 'US sales summary' })).toBeVisible();
  const filesUrl = page.url();
  expect(filesUrl).toContain('/studio/#files?resourceId=');
  expect(guestPosts()).toHaveLength(1);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp('#v1\\.'));
  await page.getByRole('button', { name: 'Open report files' }).click();
  await expect(page).toHaveURL(filesUrl);
  await expect(upload).toBeEnabled();
  expect(guestPosts()).toHaveLength(1);
  expect(writes()).toBe(2);
  expect(
    workspace.state.files.filter((f) => [sourcePath, savedReport].includes(f.path)),
  ).toHaveLength(2);
});

test('report click uses the existing account and offers a choice among file systems', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  workspace.signInAsAccount();
  workspace.addResources();
  workspace.state.resources.push({
    ...workspace.state.resources[1],
    id: 'fs_other',
    name: 'Sales files',
  });
  await openReportForUpload(page, workspace);
  await page.getByRole('textbox', { name: 'File system', exact: true }).click();
  await page.getByRole('option', { name: 'Sales files', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeEnabled();
  await expect(page).toHaveURL(/#files\?resourceId=fs_other&path=/);
  expect(workspace.requests.some((r) => r.method === 'POST' && r.path === '/api/auth/guest')).toBe(
    false,
  );
});

test('account sign-in returns a report reader to Files when Guest access is disabled', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: false });
  await openReportForUpload(page, workspace);
  await expect(page.getByRole('heading', { name: 'Open report files' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open temporary workspace' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue with TiDB Account' }).click();
  await expect(page).toHaveURL(/tidbcloud\/login$/);
  workspace.signInAsAccount();
  workspace.addResources();
  await page.goto('/studio/');
  await expect(page).toHaveURL(/#files\?resourceId=fs_fixture&path=/);
  await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeEnabled();
  expect(workspace.requests.some((r) => r.method === 'POST' && r.path === '/api/auth/guest')).toBe(
    false,
  );
});

test('a pasted upload link waits for an explicit click before temporary access', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/studio/#files/upload');
  await expect(page.getByRole('button', { name: 'Open temporary workspace' })).toBeVisible();
  expect(workspace.requests.some((r) => r.path === '/api/auth/guest')).toBe(false);
});

test('a failed Guest entry can retry from Files without returning to the home page', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  await page.route(
    '**/api/auth/guest',
    (route) => route.fulfill({ status: 503, json: { error: { message: 'Unavailable' } } }),
    { times: 1 },
  );
  await openReportForUpload(page, workspace);
  await expect(page.getByRole('alert')).toContainText('Unable to start');
  await page.getByRole('button', { name: 'Open temporary workspace' }).click();
  await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeEnabled();
});

test('report import preserves an edited file and recovers a partially saved import', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  workspace.signInAsAccount();
  workspace.addResources();
  workspace.state.files.push({
    id: 'existing-source',
    resourceId: 'fs_fixture',
    path: sourcePath,
    type: 'file',
    content: 'My edits',
    size: 8,
    version: '"edited"',
    updatedAt: new Date().toISOString(),
  });
  await openReportForUpload(page, workspace);
  await expect(page.getByRole('alert')).toContainText('already contains different content');
  expect(workspace.state.files.find((f) => f.path === sourcePath).content).toBe('My edits');
  expect(workspace.state.files.some((f) => f.path === savedReport)).toBe(false);
  workspace.state.files.find((f) => f.path === sourcePath).content = source;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'US sales summary' })).toBeVisible();
  expect(
    workspace.state.files.filter((f) => [sourcePath, savedReport].includes(f.path)),
  ).toHaveLength(2);
});

test('a lost save receipt resumes without uploading either file again', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  const writes = await openReportForUpload(page, workspace, true);
  await expect(page.getByRole('alert')).toContainText('Connection interrupted');
  expect(writes()).toBe(2);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'US sales summary' })).toBeVisible();
  expect(writes()).toBe(2);
});
