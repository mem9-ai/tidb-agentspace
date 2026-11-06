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
const sourcePath = '/us-sales.csv';
const savedReport = '/us-sales-report.md';
const markdown = (revision) =>
  `# US sales report\n\nSource: us-sales.csv\n\nCalifornia leads with $48,000.00. Total: $100,000.00 across 240 orders.\n\n## Top two states\n\nCalifornia ($48,000.00) + Texas ($20,000.00) = $68,000.00.\n$68,000.00 / $100,000.00 = 68.0% of total sales.\n${revision === 2 ? '\n## Top product in California\n\nMonitors leads with $18,000.00 (37.5% of state sales).\n' : ''}\n<!-- tidb-agent-workspace report=${id} revision=${revision} -->\n`;
const sample = {
  id,
  markdown: markdown(1),
  sharingRevoked: false,
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
  await page.clock.install();
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
        markdown: markdown(revision),
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
  await expect(page.getByRole('button', { name: 'Open report in Workspace' })).toBeVisible();
  if (process.env.VISUAL_SCREENSHOTS)
    await page.screenshot({ path: testInfo.outputPath('first-report.png'), fullPage: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await followUp.getByRole('button', { name: 'Copy follow-up' }).click();
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  expect(prompt).toContain('https://drive9.ai/studio/skills/tidb-agent-workspace/SKILL.md');
  expect(prompt).toContain('top product by sales in California');
  expect(prompt).not.toContain(grant);
  await expect(followUp.getByRole('status')).toContainText('Paste it into your project chat');
  revision = 2;
  await page.clock.fastForward(10001);
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
  await expect(page.getByRole('button', { name: 'Open report in Workspace' })).toBeVisible();
  expect(apiPaths).toEqual([
    '/studio/api/v1/agent-trial/report-view',
    '/studio/api/v1/agent-trial/report-view',
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.VISUAL_SCREENSHOTS)
    await page.screenshot({ path: testInfo.outputPath('report.png'), fullPage: true });
  await expect(page.getByRole('heading', { name: 'Continue with this report' })).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Continue with TiDB Cloud' })).toHaveCount(0);
});

test('viewer handles unavailable, invalid and expired links and clears an open report at expiry', async ({
  page,
}) => {
  let status = 503;
  const expiresAt = Math.floor(Date.now() / 1000) + 90;
  await page.clock.install();
  await page.route(endpoint, (route) => route.fulfill({ status, json: { ...sample, expiresAt } }));
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

async function openReportForUpload(page, workspace, loseReceipt = false, options = {}) {
  let writes = 0;
  await page.route('**/api/v1/agent-trial/us-sales-v1.csv', (route) =>
    route.fulfill({ body: source, contentType: 'text/csv' }),
  );
  await page.route('**/files', (route) => {
    const request = route.request();
    if (request.method() !== 'PUT') return route.fallback();
    expect(request.headers().authorization || '').not.toContain('TrialView');
    const body = request.postDataJSON();
    writes++;
    const existing = workspace.state.files.find(
      (file) => file.resourceId === body.resourceId && file.path === body.path,
    );
    if (request.headers()['if-match']) {
      expect(body.path).toBe(savedReport);
      expect(existing).toBeDefined();
      expect(request.headers()['if-match']).toBe(existing.version);
      Object.assign(existing, body, {
        size: Buffer.byteLength(body.content),
        version: '"updated-report"',
      });
      return route.fulfill({ status: 200, json: { data: existing } });
    }
    expect(request.headers()['if-none-match']).toBe('*');
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
        revision: options.revision ?? 2,
        markdown: markdown(options.revision ?? 2),
        expiresAt: Math.floor(Date.now() / 1000) + 172800,
        leadingStateProducts: { Monitors: 18000 },
      },
    }),
  );
  await page.goto(options.markets ? path.replace('/#', '/?view=markets#') : path);
  if (options.beforeOpen) await options.beforeOpen();
  await page
    .getByRole('button', {
      name: 'Open report in Workspace',
      exact: true,
    })
    .click();
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
  await expect(page.getByRole('heading', { name: 'US sales report' })).toBeVisible();
  const filesUrl = page.url();
  expect(filesUrl).toContain('/studio/#files?resourceId=');
  expect(guestPosts()).toHaveLength(1);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp('#v1\\.'));
  await page.getByRole('button', { name: 'Open report in Workspace' }).click();
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
  await page.getByRole('button', { name: 'Continue with TiDB Cloud' }).click();
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
  await expect(page.getByRole('heading', { name: 'US sales report' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'US sales report' })).toBeVisible();
  expect(writes()).toBe(2);
});

test('analysis continues through TiDB Cloud signup to saved files and a scoped agent task @visual', async ({
  page,
  context,
  workspace,
}, testInfo) => {
  workspace.requireSignIn({ guestEnabled: true });
  const writes = await openReportForUpload(page, workspace, false, {
    markets: true,
    beforeOpen: async () => {
      await expect(
        page.getByRole('heading', { level: 1, name: '68% of total sales' }),
      ).toBeVisible();
      await expect(
        page.getByText('California ($48,000) + Texas ($20,000) = $68,000.'),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Copy next question' })).toHaveCount(0);
      if (process.env.VISUAL_SCREENSHOTS)
        await page.screenshot({ path: testInfo.outputPath('analysis.png'), fullPage: true });
    },
  });
  await expect(page.getByRole('heading', { name: 'Top two states', exact: true })).toBeVisible();
  await expect(
    page.getByText('Temporary workspace · 48-hour trial', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your report and data are ready' })).toHaveCount(
    0,
  );
  expect(writes()).toBe(2);
  expect(
    workspace.requests.filter((r) => r.method === 'POST' && r.path === '/api/auth/guest'),
  ).toHaveLength(1);
  if (process.env.VISUAL_SCREENSHOTS)
    await page.screenshot({ path: testInfo.outputPath('temporary-files.png'), fullPage: true });
  // Carry current saved content, even after the initial tab-local import has expired.
  await page.clock.install();
  await page.clock.fastForward(11 * 60_000);
  const guestReport = workspace.state.files.find((f) => f.path === savedReport);
  guestReport.content += '\nSaved customer note';
  guestReport.version = '"edited-report"';
  guestReport.size = Buffer.byteLength(guestReport.content);
  const guestSource = workspace.state.files.find((f) => f.path === sourcePath);
  guestSource.content += '\n';
  guestSource.version = '"edited-source"';
  guestSource.size = Buffer.byteLength(guestSource.content);
  await page.getByRole('button', { name: 'Save to TiDB Cloud', exact: true }).click();
  await expect(page).toHaveURL(/tidbcloud\/login$/);
  expect(writes()).toBe(2);
  expect(page.url()).not.toContain(grant);
  const transfer = JSON.parse(
    await page.evaluate(() => sessionStorage.getItem('studio:report-files')),
  );
  expect(transfer.report).toBe(guestReport.content);
  expect(transfer.sample).toBe(guestSource.content);
  expect(JSON.stringify(transfer)).not.toContain(grant);
  workspace.signInAsAccount();
  workspace.state.workspace.id = 'ws_account_destination';
  workspace.addResources();
  await page.goto('/studio/');
  await expect(page.getByRole('heading', { name: 'Top two states', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your report and data are ready' })).toBeVisible();
  await expect(page.getByText('Saved customer note', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save to TiDB Cloud' })).toHaveCount(0);
  expect(writes()).toBe(4);
  const saved = workspace.state.files.find((f) => f.path === savedReport);
  expect(saved.content).toContain('68.0%');
  expect(workspace.state.files.find((f) => f.path === sourcePath).content).toBe(
    guestSource.content,
  );
  if (process.env.VISUAL_SCREENSHOTS)
    await page.screenshot({ path: testInfo.outputPath('account-files.png'), fullPage: true });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Connect my agent', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Connect my agent', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('textbox', { name: 'Key name' })).toHaveValue('sales-agent');
  await expect(
    dialog.getByRole('checkbox', { name: 'Read files files:read', exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole('checkbox', { name: 'Analyze files files:analyze', exact: true }),
  ).toBeChecked();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
  await dialog.getByRole('button', { name: 'Copy terminal command', exact: true }).click();
  const command = await page.evaluate(() => navigator.clipboard.readText());
  expect(command).toContain('Compare average order value by state');
  expect(command).toContain('/us-sales.csv');
  expect(command).toContain('US+sales+order+values.md');
  expect(command).toContain(saved.resourceId);
  expect(command).not.toContain(grant);
  await dialog.getByRole('button', { name: 'Copy key', exact: true }).click();
  await dialog.getByRole('button', { name: 'Wait for report', exact: true }).click();
  await expect(page.getByText('Your agent’s next report')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Your agent’s next report')).toBeVisible();
  workspace.state.files.push({
    ...saved,
    id: 'follow-up',
    path: '/US sales order values.md',
    content: '# Average order value\nCalifornia: $400',
    size: 44,
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.getByRole('link', { name: 'Open follow-up report', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Average order value', exact: true }),
  ).toBeVisible();
});

for (const existing of ['guest', 'account']) {
  test(`account continuation from an existing ${existing} uses the account and opens the saved CSV`, async ({
    page,
    workspace,
  }) => {
    workspace.requireSignIn({ guestEnabled: true });
    if (existing === 'guest') {
      await page.goto('/studio/');
      await page.evaluate(() => fetch('/api/auth/guest', { method: 'POST' }));
    } else workspace.signInAsAccount();
    workspace.addResources();
    const writes = await openReportForUpload(page, workspace, false, {
      markets: true,
      revision: existing === 'account' ? 1 : 2,
    });
    if (existing === 'guest') {
      await expect(
        page.getByText('Temporary workspace · 48-hour trial', { exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Save to TiDB Cloud', exact: true }).click();
      await expect(page).toHaveURL(/tidbcloud\/login$/);
      expect(writes()).toBe(2);
      workspace.signInAsAccount();
      workspace.state.workspace.id = 'ws_account_destination';
      workspace.addResources();
      await page.goto('/studio/');
    }
    await expect(
      page.getByRole('heading', { name: 'Your report and data are ready' }),
    ).toBeVisible();
    await page.route('**/files/tabular-preview?*', (route) =>
      route.fulfill({
        json: {
          resourceId: 'fs_fixture',
          path: sourcePath,
          format: 'csv',
          readOnly: true,
          fileVersion: 'sample',
          columns: ['state', 'sales_usd'],
          columnTypes: ['VARCHAR', 'BIGINT'],
          schema: [
            { column_name: 'state', column_type: 'VARCHAR' },
            { column_name: 'sales_usd', column_type: 'BIGINT' },
          ],
          rowCount: 1,
          truncated: false,
          rows: [{ state: 'California', sales_usd: 48000 }],
          totalRows: 240,
          typesInferred: true,
        },
      }),
    );
    await page.getByRole('button', { name: 'Explore sample data', exact: true }).click();
    await expect(page).toHaveURL(/path=%2Fus-sales.csv/);
    await expect(page.getByRole('heading', { name: 'us-sales.csv', exact: true })).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'File data preview', exact: true }),
    ).toContainText('California');
    expect(writes()).toBe(existing === 'guest' ? 4 : 2);
    if (existing === 'account') {
      const resumed = await openReportForUpload(page, workspace, false, {
        revision: 1,
        markets: true,
      });
      await expect(
        page.getByRole('heading', { name: 'Your report and data are ready' }),
      ).toBeVisible();
      expect(resumed()).toBe(0);
    }
  });
}

test('saving to Cloud preserves unsaved drafts and refuses incomplete source reads', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  await openReportForUpload(page, workspace);
  await expect(page.getByRole('heading', { name: 'US sales report' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit source', exact: true }).click();
  await page.getByRole('button', { name: 'Back to preview', exact: true }).click();
  await page.reload();
  await expect(
    page.getByText('Temporary workspace · 48-hour trial', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Edit source', exact: true }).click();
  await page.getByRole('textbox', { name: 'File content', exact: true }).fill('An unsaved report');
  const save = page.getByRole('button', { name: 'Save to TiDB Cloud', exact: true });
  await save.click();
  await expect(page.getByText('This file has unsaved changes.')).toBeVisible();
  await expect(page).toHaveURL(/#files\?resourceId=.+&from=report$/);
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'File content', exact: true })).toHaveValue(
    'An unsaved report',
  );
  let incomplete = true;
  await page.route('**/files/content?*', (route) => {
    if (!incomplete) return route.fallback();
    return route.fulfill({ json: { content: 'partial', size: 100 } });
  });
  await save.click();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Temporary workspace · 48-hour trial' }).getByRole('alert'),
  ).toContainText('complete report and source data could not be read');
  expect(workspace.requests.some((r) => r.path === '/api/auth/tidbcloud/login')).toBe(false);
  expect(await page.evaluate(() => sessionStorage.getItem('studio:report-files'))).toBeNull();
  incomplete = false;
  let changed = true;
  let metadataReads = 0;
  await page.route('**/files/metadata?*', (route) => {
    if (!changed) return route.fallback();
    const pathname = new URL(route.request().url()).searchParams.get('path');
    const file = workspace.state.files.find((f) => f.path === pathname);
    return route.fulfill({
      json: { data: { ...file, version: ++metadataReads <= 2 ? 'before' : 'changed' } },
    });
  });
  await save.click();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Temporary workspace · 48-hour trial' }).getByRole('alert'),
  ).toContainText('changed while preparing to save');
  expect(workspace.requests.some((r) => r.path === '/api/auth/tidbcloud/login')).toBe(false);
  expect(await page.evaluate(() => sessionStorage.getItem('studio:report-files'))).toBeNull();
  changed = false;
  await save.click();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page).toHaveURL(/tidbcloud\/login$/);
  const transfer = JSON.parse(
    await page.evaluate(() => sessionStorage.getItem('studio:report-files')),
  );
  expect(transfer.report).toContain('Monitors');
  expect(transfer.report).not.toContain('An unsaved report');
});

test('focus refresh retains confirmed content through an outage and clears revoked access', async ({
  page,
}) => {
  let status = 200;
  let reads = 0;
  await page.clock.install();
  await page.route(endpoint, (route) => {
    reads++;
    return route.fulfill({
      status,
      json:
        status === 200
          ? { ...sample, expiresAt: Math.floor(Date.now() / 1000) + 172800 }
          : { error: { code: status === 410 ? 'REPORT_SHARING_REVOKED' : 'UNAVAILABLE' } },
    });
  });
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'US sales report' })).toBeVisible();
  status = 503;
  const previous = reads;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => reads).toBeGreaterThan(previous);
  await expect(page.getByRole('heading', { name: 'US sales report' })).toBeVisible();
  await expect(page.getByText('The report could not be loaded')).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hiddenReads = reads;
  await page.clock.fastForward(61000);
  expect(reads).toBe(hiddenReads);
  status = 410;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(
    page.getByRole('heading', { name: 'This report is no longer shared' }),
  ).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  const closedReads = reads;
  await page.clock.fastForward(61000);
  expect(reads).toBe(closedReads);
});

test('existing sample is reused and a newer revision updates the same untouched Workspace report', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  workspace.signInAsAccount();
  workspace.addResources();
  workspace.state.files.push({
    id: 'browser-sample',
    resourceId: 'fs_fixture',
    path: sourcePath,
    type: 'file',
    content: source,
    size: Buffer.byteLength(source),
    version: '"browser-sample"',
    updatedAt: new Date().toISOString(),
  });
  const options = { revision: 1, markets: true };
  const writes = await openReportForUpload(page, workspace, false, options);
  await expect(page.getByRole('heading', { name: 'US sales report' })).toBeVisible();
  expect(writes()).toBe(1);
  const report = workspace.state.files.find((file) => file.path === savedReport);
  expect(report.content).toBe(markdown(1));
  options.revision = 2;
  await page.goBack();
  await page.getByRole('button', { name: 'Open report in Workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Top product in California' })).toBeVisible();
  expect(report.content).toBe(markdown(2));
  expect(writes()).toBe(2);
  expect(workspace.state.files.filter((file) => file.path === sourcePath)).toHaveLength(1);
  expect(workspace.state.files.filter((file) => file.path === savedReport)).toHaveLength(1);
  options.revision = 1;
  await page.goBack();
  await page.getByRole('button', { name: 'Open report in Workspace' }).click();
  await expect(page.getByRole('alert')).toContainText('already contains different content');
  expect(report.content).toBe(markdown(2));
  expect(writes()).toBe(2);
  options.revision = 2;
  report.content += '\nMy saved edits';
  report.version = '"edited"';
  report.size = Buffer.byteLength(report.content);
  await page.goBack();
  await page.getByRole('button', { name: 'Open report in Workspace' }).click();
  await expect(page.getByRole('alert')).toContainText('already contains different content');
  expect(report.content).toContain('My saved edits');
  expect(writes()).toBe(2);
});
