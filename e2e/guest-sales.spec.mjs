import { test, expect } from './workspace-fixture.mjs';
import { readFile } from 'node:fs/promises';

test('a missing file service location is explained without creating a sample', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  workspace.state.capabilities.filesystem.regions = [];
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Your files are not ready' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try with an agent' })).toBeDisabled();
  expect(
    workspace.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/resources')),
  ).toHaveLength(0);
});

test('a temporary workspace explains setup failure and retries the same default safely', async ({
  page,
  context,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  const keys = [];
  let fail = true;
  await context.route('**/resources', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST' || !request.postDataJSON()?.onlyIfNew) return route.fallback();
    keys.push(request.headers()['idempotency-key']);
    if (!fail) return route.fallback();
    fail = false;
    return route.fulfill({
      status: 503,
      json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Unavailable' } },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Your files are not ready' });
  await expect(alert).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try with an agent' })).toBeDisabled();
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: 'Try with an agent' })).toBeEnabled();
  expect(keys).toEqual(['workspace-default-files-v1', 'workspace-default-files-v1']);
  expect(workspace.state.resources).toHaveLength(1);
});

test('a new signed-in user also sees the first-use guide after default preparation', async ({
  page,
  workspace,
}) => {
  workspace.signInAsAccount();
  await page.goto('/');
  const sample = page.getByRole('region', { name: 'Explore US sales' });
  await expect(sample.getByRole('button', { name: 'Try with an agent' })).toBeEnabled();
  expect(workspace.state.resources).toHaveLength(1);
  expect(workspace.state.resources[0]).toMatchObject({ name: 'my-files', isDefault: true });
});

test('@visual Guest explores the sample and gets a sales result without an agent or key', async ({
  page,
  context,
  workspace,
}, testInfo) => {
  workspace.requireSignIn({ guestEnabled: true });
  const analyses = [];
  const reportWrites = [];
  await context.route('**/files', async (route) => {
    const request = route.request();
    if (request.method() !== 'PUT' || request.postDataJSON()?.path !== '/my-us-sales-report.md')
      return route.fallback();
    const body = request.postDataJSON();
    reportWrites.push({ body, precondition: request.headers()['if-none-match'] });
    workspace.state.files.push({
      ...body,
      id: 'manual-report',
      version: '"manual-report-version"',
      size: body.content.length,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    return route.fulfill({ json: { data: workspace.state.files.at(-1) } });
  });
  await context.route('**/file-analyses', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON();
    analyses.push(body);
    const productQuery = body.sql.includes('GROUP BY product');
    await route.fulfill({
      json: {
        engine: 'duckdb',
        resourceId: body.resourceId,
        path: body.path,
        readOnly: true,
        inputBytes: 35,
        durationMs: 10,
        columns: [productQuery ? 'product' : 'state', 'sales'],
        columnTypes: ['VARCHAR', 'BIGINT'],
        schema: [],
        rows: productQuery
          ? [{ product: 'Monitors', sales: 18000 }]
          : [{ state: 'California', sales: 48000 }],
        rowCount: 1,
        stdout: '',
        stderr: '',
        exitCode: 0,
        fileVersion: 'a'.repeat(64),
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  const sample = page.getByRole('region', { name: 'Explore US sales' });
  await expect(sample.getByRole('button', { name: 'Explore sample yourself' })).toBeVisible();
  await expect(sample.getByRole('button', { name: 'Try with an agent' })).toBeVisible();
  await expect(sample.getByRole('button', { name: 'Explore sample yourself' })).toBeEnabled();
  expect(workspace.state.resources).toHaveLength(1);
  expect(workspace.state.resources[0]).toMatchObject({ id: 'fs_sales', isDefault: true });
  await sample.getByRole('button', { name: 'Explore sample yourself' }).click();
  await expect(sample.getByText('Sample ready · /us-sales.csv')).toBeVisible();
  await expect(sample.getByRole('tab', { name: 'Explore yourself' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await sample.getByRole('button', { name: 'Analyze sales by state' }).click();
  const nextStep = sample.getByRole('button', { name: 'Find California’s top product' });
  await expect(nextStep).toBeFocused();
  await expect(nextStep).toBeInViewport({ ratio: 1 });
  const nextBox = await nextStep.boundingBox();
  const stateResultsBox = await sample
    .getByRole('region', { name: 'Sales by state' })
    .boundingBox();
  expect(nextBox.y + nextBox.height).toBeLessThanOrEqual(stateResultsBox.y);
  await expect(sample.getByRole('region', { name: 'Query result data' })).toContainText(
    'California',
  );
  await expect(sample.getByRole('region', { name: 'Query result data' })).toContainText('48000');
  await expect(sample.getByText(/Read-only analysis · Original file unchanged/)).toBeVisible();
  expect(analyses).toEqual([
    expect.objectContaining({
      resourceId: 'fs_sales',
      path: '/us-sales.csv',
      engine: 'duckdb',
      sql: expect.stringMatching(/SUM\(sales_usd\).*GROUP BY state/),
    }),
  ]);
  expect(
    workspace.requests.filter(
      (r) => r.method === 'POST' && r.path.endsWith('/sales-sample-attempts'),
    )[0].body,
  ).toEqual({ fixture: 'us-sales-v1', resourceId: 'fs_sales' });
  expect(
    workspace.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/keys')),
  ).toHaveLength(0);
  expect(
    workspace.requests.filter(
      (r) => r.path.endsWith('/files/metadata') && r.query.path === '/us-sales-report.md',
    ),
  ).toHaveLength(0);
  if (process.env.SELF_SERVICE_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.SELF_SERVICE_SCREENSHOTS}/${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  await sample.getByRole('tab', { name: 'With an agent' }).click();
  await expect(sample.getByRole('button', { name: 'Connect your agent' })).toBeVisible();
  await sample.getByRole('tab', { name: 'Explore yourself' }).click();
  await expect(sample.getByRole('region', { name: 'Query result data' })).toContainText('48000');
  await expect(sample.getByRole('button', { name: 'Run analysis again' })).toBeVisible();
  await sample.getByRole('button', { name: 'Find California’s top product' }).click();
  await expect(sample.getByRole('region', { name: 'Top products' })).toContainText('Monitors');
  await expect(sample.getByText(/Monitors leads California with/)).toContainText('$18,000.00');
  const saveReport = sample.getByRole('button', { name: 'Save report' });
  await expect(saveReport).toBeFocused();
  await expect(saveReport).toBeInViewport({ ratio: 1 });
  const saveBox = await saveReport.boundingBox();
  const productResultsBox = await sample
    .getByRole('region', { name: 'Top products' })
    .boundingBox();
  expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(productResultsBox.y);
  await saveReport.click();
  await expect(sample.getByText('Report saved.')).toBeVisible();
  await expect(sample.getByRole('link', { name: 'Open report' })).toBeFocused();
  expect(reportWrites).toHaveLength(1);
  expect(reportWrites[0].precondition).toBe('*');
  expect(reportWrites[0].body.content).toContain('California with $48,000.00');
  expect(reportWrites[0].body.content).toContain('Monitors with $18,000.00');
  expect(reportWrites[0].body.content).toContain('Source: /us-sales.csv');
  expect(analyses[1].sql).toContain("WHERE state = 'California'");
  await expect(sample.getByRole('link', { name: 'Open report' })).toHaveAttribute(
    'href',
    /my-us-sales-report\.md/,
  );
  if (process.env.SELF_SERVICE_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.SELF_SERVICE_SCREENSHOTS}/finished-${testInfo.project.name}.png`,
      animations: 'disabled',
      fullPage: true,
    });
  await sample.getByRole('link', { name: 'Open sample file' }).click();
  await expect(page).toHaveURL(/#files\?.*us-sales.csv/);
  await expect(page.getByRole('complementary', { name: 'us-sales.csv' })).toBeVisible();
  await page.goBack();
  await expect(sample).toHaveCount(0);
  await page.goto('/#tutorials');
  await page.getByRole('link', { name: 'Explore the sales example' }).click();
  await expect(page).toHaveURL(/#overview\?example=sales$/);
  await expect(sample.getByRole('link', { name: 'Open report' })).toBeVisible();
  await page.goto('/#overview');
  await expect(sample).toHaveCount(0);
  expect(reportWrites).toHaveLength(1);
  expect(
    workspace.requests.filter(
      (r) => r.method === 'POST' && r.path.endsWith('/sales-sample-attempts'),
    ),
  ).toHaveLength(1);
});

test('analysis does not steal focus if the user moves elsewhere while it runs', async ({
  page,
  context,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  await context.route('**/file-analyses', async (route) => {
    const body = route.request().postDataJSON();
    await waiting;
    return route.fulfill({
      json: {
        engine: 'duckdb',
        resourceId: body.resourceId,
        path: body.path,
        readOnly: true,
        inputBytes: 35,
        durationMs: 1,
        columns: ['state', 'sales'],
        columnTypes: [],
        schema: [],
        rows: [{ state: 'California', sales: 48000 }],
        rowCount: 1,
        stdout: '',
        stderr: '',
        exitCode: 0,
        fileVersion: 'a'.repeat(64),
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  const sample = page.getByRole('region', { name: 'Explore US sales' });
  await sample.getByRole('button', { name: 'Explore sample yourself' }).click();
  const request = page.waitForRequest('**/file-analyses');
  await sample.getByRole('button', { name: 'Analyze sales by state' }).click();
  await request;
  const openSample = sample.getByRole('link', { name: 'Open sample file' });
  await openSample.focus();
  release();
  await expect(sample.getByRole('button', { name: 'Find California’s top product' })).toBeVisible();
  await expect(openSample).toBeFocused();
});

test('@visual the next analysis stays visible when a report already exists', async ({
  page,
  context,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  await context.route('**/file-analyses', (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({
      json: {
        engine: 'duckdb',
        resourceId: body.resourceId,
        path: body.path,
        readOnly: true,
        inputBytes: 35,
        durationMs: 1,
        columns: ['state', 'sales'],
        columnTypes: [],
        schema: [],
        rows: [{ state: 'California', sales: 48000 }],
        rowCount: 1,
        stdout: '',
        stderr: '',
        exitCode: 0,
        fileVersion: 'a'.repeat(64),
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  const sample = page.getByRole('region', { name: 'Explore US sales' });
  await expect(sample.getByRole('button', { name: 'Explore sample yourself' })).toBeEnabled();
  workspace.state.files.push({
    id: 'existing-manual-report',
    resourceId: 'fs_sales',
    path: '/my-us-sales-report.md',
    type: 'file',
    content: '# Existing report',
    size: 17,
    version: '"existing-report"',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await sample.getByRole('button', { name: 'Explore sample yourself' }).click();
  await expect(sample.getByText('A report already exists. Open it to review.')).toBeVisible();
  await sample.getByRole('button', { name: 'Analyze sales by state' }).click();
  const nextStep = sample.getByRole('button', { name: 'Find California’s top product' });
  await expect(nextStep).toBeFocused();
  await expect(nextStep).toBeInViewport({ ratio: 1 });
  const nextBox = await nextStep.boundingBox();
  const tableBox = await sample.getByRole('region', { name: 'Sales by state' }).boundingBox();
  expect(nextBox.y + nextBox.height).toBeLessThanOrEqual(tableBox.y);
  await expect(sample.getByRole('link', { name: 'Open report' })).toBeVisible();
});

for (const failure of ['lost response', 'provider not ready']) {
  test(`an uncertain report save (${failure}) is checked without overwriting or repeating it`, async ({
    page,
    context,
    workspace,
  }) => {
    workspace.requireSignIn({ guestEnabled: true });
    let writes = 0;
    await context.route('**/file-analyses', (route) => {
      const body = route.request().postDataJSON();
      const product = body.sql.includes('GROUP BY product');
      return route.fulfill({
        json: {
          engine: 'duckdb',
          resourceId: body.resourceId,
          path: body.path,
          readOnly: true,
          inputBytes: 35,
          durationMs: 1,
          columns: [product ? 'product' : 'state', 'sales'],
          columnTypes: [],
          schema: [],
          rows: [
            product ? { product: 'Monitors', sales: 18000 } : { state: 'California', sales: 48000 },
          ],
          rowCount: 1,
          stdout: '',
          stderr: '',
          exitCode: 0,
          fileVersion: 'a'.repeat(64),
        },
      });
    });
    await context.route('**/files', (route) => {
      const request = route.request();
      if (request.method() !== 'PUT' || request.postDataJSON()?.path !== '/my-us-sales-report.md')
        return route.fallback();
      writes++;
      expect(request.headers()['if-none-match']).toBe('*');
      if (failure === 'provider not ready')
        return route.fulfill({
          status: 409,
          json: { error: { code: 'PROVIDER_NOT_READY', message: 'Unavailable' } },
        });
      const body = request.postDataJSON();
      workspace.state.files.push({
        ...body,
        id: 'saved-before-disconnect',
        version: '"manual-report-version"',
        size: body.content.length,
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      return route.abort('failed');
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Try without an account' }).click();
    const sample = page.getByRole('region', { name: 'Explore US sales' });
    await sample.getByRole('button', { name: 'Explore sample yourself' }).click();
    await sample.getByRole('button', { name: 'Analyze sales by state' }).click();
    await sample.getByRole('button', { name: 'Find California’s top product' }).click();
    await sample.getByRole('button', { name: 'Save report' }).click();
    await expect(sample.getByText(/could not confirm whether the report was saved/)).toBeVisible();
    await expect(sample.getByRole('button', { name: 'Save report' })).toHaveCount(0);
    await sample.getByRole('button', { name: 'Check report' }).click();
    if (failure === 'lost response')
      await expect(sample.getByRole('link', { name: 'Open report' })).toBeVisible();
    else await expect(sample.getByRole('button', { name: 'Save report' })).toBeVisible();
    expect(writes).toBe(1);
  });
}

test('self-service analysis does not present results from a changed sample as the original', async ({
  page,
  context,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  await context.route('**/file-analyses', (route) => {
    workspace.state.files.find((file) => file.path === '/us-sales.csv').version = '"changed"';
    return route.fulfill({
      json: {
        engine: 'duckdb',
        resourceId: 'fs_sales',
        path: '/us-sales.csv',
        readOnly: true,
        inputBytes: 35,
        durationMs: 1,
        columns: ['state', 'sales'],
        columnTypes: [],
        schema: [],
        rows: [{ state: 'Other', sales: 1 }],
        rowCount: 1,
        stdout: '',
        stderr: '',
        exitCode: 0,
        fileVersion: 'a'.repeat(64),
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  const sample = page.getByRole('region', { name: 'Explore US sales' });
  await sample.getByRole('button', { name: 'Explore sample yourself' }).click();
  await sample.getByRole('button', { name: 'Analyze sales by state' }).click();
  await expect(
    sample.getByText('The file changed during analysis. Open it to review the saved data.'),
  ).toBeVisible();
  await expect(sample.getByRole('region', { name: 'Query result data' })).toHaveCount(0);
  await expect(sample.getByRole('button', { name: 'Analyze sales by state' })).toBeDisabled();
});

test('@visual Guest starts a sales task, grants only its file system and returns to the saved sample', async ({
  page,
  workspace,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (value) => (globalThis.__copiedText = value) },
    });
  });
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  const task = page.getByRole('region', { name: 'Explore US sales' });
  await expect(task.getByRole('heading', { name: 'Explore US sales' })).toBeVisible();
  await expect(page.getByText('Temporary workspace · Access expires after 24 hours')).toBeVisible();
  if (await page.getByRole('button', { name: 'Open navigation' }).isVisible()) {
    await expect(page.locator('.workspace-mobile-crumb')).toHaveText('Workspace');
  }
  await expect(task.getByRole('button', { name: 'Try with an agent' })).toBeVisible();
  expect(
    workspace.requests.filter(
      (entry) => entry.method === 'POST' && entry.path.endsWith('/sales-sample-attempts'),
    ),
  ).toHaveLength(0);
  if (process.env.GUEST_SALES_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.GUEST_SALES_SCREENSHOTS}-start-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  await task.getByRole('button', { name: 'Try with an agent' }).click();
  await expect(task.getByText('Sample ready · /us-sales.csv')).toBeVisible();
  await expect(task.getByRole('tab', { name: 'With an agent' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(task.getByRole('tab', { name: 'Explore yourself' })).toBeVisible();
  await expect(
    task.getByRole('tablist', { name: 'Ways to explore the sample' }).getByRole('tab'),
  ).toHaveText(['With an agent', 'Explore yourself']);
  await task.getByRole('tab', { name: 'With an agent' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(task.getByRole('tab', { name: 'Explore yourself' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ArrowLeft');
  await expect(task.getByRole('tab', { name: 'With an agent' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(task.getByRole('link', { name: '/us-sales.csv' })).toHaveAttribute(
    'href',
    /resourceId=fs_sales.*us-sales.csv/,
  );
  expect(workspace.state.resources.map((resource) => resource.kind)).toEqual(['filesystem']);
  await task.getByRole('link', { name: '/us-sales.csv' }).click();
  await expect(page).toHaveURL(/#files\?/);
  await page.goBack();
  await expect(task.getByRole('button', { name: 'Connect your agent' })).toBeVisible();
  expect(
    workspace.requests.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/keys')),
  ).toHaveLength(0);
  await expect(task.getByRole('button', { name: 'Copy task for your agent' })).toHaveCount(0);
  await expect(task.getByRole('button', { name: 'Check now' })).toHaveCount(0);
  if (process.env.GUEST_SALES_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.GUEST_SALES_SCREENSHOTS}-ready-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  await task.getByRole('button', { name: 'Connect your agent' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create API key' });
  await expect(dialog.getByRole('checkbox', { name: 'my-files' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'my-files' })).toHaveAccessibleDescription(
    'File System',
  );
  if (process.env.GUEST_SALES_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.GUEST_SALES_SCREENSHOTS}-permissions-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  await dialog.getByText('Advanced resource access').click();
  await expect(
    dialog.getByRole('checkbox', { name: 'All current and future resources' }),
  ).not.toBeChecked();
  await dialog.getByText('Advanced resource access').click();
  for (const scope of ['files:read', 'files:analyze', 'files:write'])
    await expect(dialog.getByRole('checkbox', { name: new RegExp(scope) })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /queries:execute/ })).toHaveCount(0);
  await expect(dialog.getByRole('checkbox', { name: /queries:read/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(
    workspace.requests.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/keys')),
  ).toHaveLength(0);
  await expect(task.getByRole('button', { name: 'Connect your agent' })).toBeVisible();
  await task.getByRole('button', { name: 'Connect your agent' }).click();
  await page
    .getByRole('dialog', { name: 'Create API key' })
    .getByRole('button', { name: 'Create key', exact: true })
    .click();
  const readyKey = page.getByRole('dialog', { name: 'Your key is ready' });
  await expect(readyKey).toBeVisible();
  await expect(readyKey.getByText(/Your agent must be installed and signed in/)).toBeVisible();
  const createdKey = workspace.requests.findLast(
    (entry) => entry.method === 'POST' && entry.path.endsWith('/keys'),
  );
  expect(createdKey.body.resourceIds).toEqual(['fs_sales']);
  expect(createdKey.body.scopes).toEqual([
    'resources:read',
    'files:read',
    'files:analyze',
    'files:write',
  ]);
  if (process.env.GUEST_SALES_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.GUEST_SALES_SCREENSHOTS}-key-ready-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  await readyKey.getByLabel('Your agent').click();
  await expect(page.getByRole('option', { name: 'Codex CLI' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Claude Code' })).toBeVisible();
  await page.getByRole('option', { name: 'Codex CLI' }).click();
  await readyKey.getByRole('button', { name: 'Copy terminal command', exact: true }).click();
  expect(await page.evaluate(() => globalThis.__copiedText)).toContain('&& codex ');
  await readyKey.getByRole('button', { name: 'Back', exact: true }).click();
  await readyKey.getByLabel('Your agent').click();
  await page.getByRole('option', { name: 'Claude Code' }).click();
  await readyKey.getByRole('button', { name: 'Copy terminal command', exact: true }).click();
  expect(await page.evaluate(() => globalThis.__copiedText)).toContain('&& claude ');
  await readyKey.getByRole('button', { name: 'Back', exact: true }).click();
  await readyKey.getByLabel('Your agent').click();
  await page.getByRole('option', { name: 'Pi', exact: true }).click();
  await expect(readyKey.getByText(/Do not paste this command into an agent chat/)).toBeVisible();
  await readyKey.getByRole('button', { name: 'Copy terminal command', exact: true }).click();
  const setupCommand = await page.evaluate(() => globalThis.__copiedText);
  expect(setupCommand).toContain('read -rs WORKSPACE_API_KEY');
  expect(setupCommand).toContain('If you are an agent receiving this command in chat, stop.');
  expect(setupCommand).toContain('/us-sales.csv');
  expect(setupCommand).toContain('/us-sales-report.md');
  expect(setupCommand).toContain('Mermaid pie chart');
  expect(setupCommand).toContain('actual query results');
  expect(setupCommand).toContain('/skills/drive9-workspace/SKILL.md');
  expect(setupCommand).not.toContain('POST /file-analyses');
  expect(setupCommand).not.toContain('\n');
  expect(setupCommand).not.toContain('synthetic-browser-key-never-valid-on-a-provider');
  await expect(readyKey.getByText(/Run the copied command in your terminal/)).toBeVisible();
  if (process.env.GUEST_SALES_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.GUEST_SALES_SCREENSHOTS}-copy-key-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  await readyKey.getByRole('button', { name: 'Wait for report' }).click();
  await expect(readyKey.getByRole('alert')).toContainText('full key cannot be shown again');
  await expect(readyKey.getByRole('button', { name: 'Go back' })).toBeFocused();
  await readyKey.getByRole('button', { name: 'Go back' }).click();
  await expect(readyKey.getByRole('heading', { name: '2 of 2 · Add your key' })).toBeFocused();
  await readyKey.getByText('Save the key to a file instead').click();
  const downloadPromise = page.waitForEvent('download');
  await readyKey.getByRole('button', { name: 'Download key (.txt)' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('workspace-key.txt');
  expect(download.url()).toMatch(/^blob:/);
  expect(download.url()).not.toContain('synthetic-browser-key-never-valid-on-a-provider');
  expect(await readFile(await download.path(), 'utf8')).toBe(
    'synthetic-browser-key-never-valid-on-a-provider',
  );
  await expect(readyKey.getByText(/Download requested/)).toBeVisible();
  await readyKey.getByRole('button', { name: 'Copy key', exact: true }).click();
  expect(await page.evaluate(() => globalThis.__copiedText)).toBe(
    'synthetic-browser-key-never-valid-on-a-provider',
  );
  await readyKey.getByRole('button', { name: 'Wait for report' }).click();
  await expect(task.getByRole('button', { name: 'Check now' })).toBeFocused();
  await expect(task.getByText('Waiting for a report…')).toBeVisible();
  await expect(task.getByText(/does not confirm that your agent/)).toBeVisible();
  await task.getByRole('tab', { name: 'Explore yourself' }).click();
  await expect(task.getByRole('button', { name: 'Analyze sales by state' })).toBeVisible();
  await task.getByRole('tab', { name: 'With an agent' }).click();
  await expect(task.getByText('Waiting for a report…')).toBeVisible();
  await task.getByRole('button', { name: 'View task again' }).click();
  const copyTask = task.getByRole('button', { name: 'Copy task for your agent' });
  await expect(copyTask).toBeFocused();
  await expect(task.getByText(/For Pi, run pi/)).toBeVisible();
  const copyBox = await copyTask.boundingBox();
  expect(copyBox.y).toBeGreaterThanOrEqual(0);
  expect(copyBox.y + copyBox.height).toBeLessThanOrEqual(page.viewportSize().height);
  if (process.env.GUEST_SALES_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.GUEST_SALES_SCREENSHOTS}-task-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  await copyTask.click();
  await expect(task.getByRole('button', { name: 'Check now' })).toBeFocused();
  const copied = await page.evaluate(() => globalThis.__copiedText);
  expect(copied).toContain('WORKSPACE_API_KEY');
  expect(copied).toContain('/us-sales.csv');
  expect(copied).toContain('/skills/drive9-workspace/SKILL.md');
  expect(copied).not.toContain('awk_');
  expect(copied).not.toContain('synthetic-browser-key-never-valid-on-a-provider');
  expect(page.url()).not.toContain('synthetic-browser-key-never-valid-on-a-provider');
  expect(JSON.stringify(workspace.requests)).not.toContain(
    'synthetic-browser-key-never-valid-on-a-provider',
  );
  expect(
    await page.evaluate(() =>
      [localStorage, sessionStorage].some((storage) =>
        Object.values(storage).some((value) =>
          value.includes('synthetic-browser-key-never-valid-on-a-provider'),
        ),
      ),
    ),
  ).toBe(false);
  if (process.env.GUEST_SALES_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.GUEST_SALES_SCREENSHOTS}-check-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  await expect(
    task.getByText('No report yet. We’ll keep looking while this page is open.'),
  ).toHaveCount(0);
  await task.getByRole('button', { name: 'Check now' }).click();
  await expect(
    task.getByText('No report yet. We’ll keep looking while this page is open.'),
  ).toBeVisible();
  workspace.state.files.push({
    id: 'report',
    resourceId: 'fs_sales',
    path: '/us-sales-report.md',
    type: 'file',
    content: '# Report',
    size: 8,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await expect(task.getByRole('link', { name: 'Open report' })).toBeVisible({ timeout: 10000 });
  await expect(task.getByRole('button', { name: 'Copy follow-up task' })).toBeVisible();
  if (process.env.GUEST_SALES_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.GUEST_SALES_SCREENSHOTS}-report-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  await page.reload();
  await expect(task.getByText('Sample ready · /us-sales.csv')).toBeVisible();
  expect(
    workspace.requests.filter(
      (entry) => entry.method === 'POST' && entry.path.endsWith('/sales-sample-attempts'),
    ),
  ).toHaveLength(1);
  workspace.state.files.find((file) => file.path === '/us-sales.csv').version = '"edited"';
  await page.reload();
  await expect(task.getByText(/This sample has changed since it was created/)).toBeVisible();
  await expect(task.getByRole('button', { name: 'Connect your agent' })).toHaveCount(0);
  await expect(task.getByRole('button', { name: 'Copy follow-up task' })).toBeDisabled();
  expect(
    workspace.requests.filter(
      (entry) => entry.method === 'POST' && entry.path.endsWith('/sales-sample-attempts'),
    ),
  ).toHaveLength(1);
  const menu = page.getByRole('button', { name: 'Open navigation' });
  if (await menu.isVisible()) await menu.click();
  const navigation = page
    .getByRole('navigation', { name: 'Main navigation' })
    .filter({ visible: true });
  await expect(navigation.getByRole('link', { name: 'Files', exact: true })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Access', exact: true })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Databases', exact: true })).toBeHidden();
  await navigation.getByText('More', { exact: true }).click();
  await expect(navigation.getByRole('link', { name: 'Databases', exact: true })).toBeVisible();
  await navigation.getByRole('link', { name: 'Databases', exact: true }).click();
  await expect(page).toHaveURL(/#databases$/);
});

test('@visual a copied follow-up resumes waiting and discovers its own report', async ({
  page,
  workspace,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (value) => (globalThis.__copiedText = value) },
    });
  });
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  const task = page.getByRole('region', { name: 'Explore US sales' });
  await task.getByRole('button', { name: 'Try with an agent' }).click();
  await expect(task.getByText('Sample ready · /us-sales.csv')).toBeVisible();
  workspace.state.files.push({
    id: 'report',
    resourceId: 'fs_sales',
    path: '/us-sales-report.md',
    type: 'file',
    content: '# Report',
    size: 8,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await page.reload();
  const followUp = task.getByRole('region', { name: 'Follow-up task' });
  await expect(
    followUp.getByRole('button', { name: 'Copy follow-up task', exact: true }),
  ).toBeEnabled();
  await followUp.getByRole('button', { name: 'Copy follow-up task', exact: true }).click();
  await expect(followUp.getByText(/Task copied\. Start a fresh agent session/)).toBeVisible();
  await expect(
    followUp.getByText(/Copying the task does not start or verify your agent/),
  ).toBeVisible();
  const copied = await page.evaluate(() => globalThis.__copiedText);
  expect(copied).toContain('/us-sales.csv');
  expect(copied).toContain('/us-sales-report.md');
  expect(copied).toContain('/us-sales-follow-up.md');
  expect(copied).toContain('/skills/drive9-workspace/SKILL.md');
  expect(copied).not.toContain('awk_');
  if (process.env.GUEST_SALES_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.GUEST_SALES_SCREENSHOTS}-follow-up-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  await page.reload();
  await expect(followUp.getByText(/Give the task to your agent/)).toBeVisible();
  await followUp.getByRole('button', { name: 'Check follow-up report' }).click();
  await expect(
    followUp.getByText('No follow-up report yet. We’ll keep looking while this page is open.'),
  ).toBeVisible();
  workspace.state.files.push({
    id: 'follow-up',
    resourceId: 'fs_sales',
    path: '/us-sales-follow-up.md',
    type: 'file',
    content: '# Follow-up',
    size: 11,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await expect(followUp.getByRole('link', { name: 'Open follow-up report' })).toHaveAttribute(
    'href',
    /resourceId=fs_sales.*us-sales-follow-up\.md/,
    { timeout: 12000 },
  );
  await expect(
    followUp.getByText('Follow-up file found. Open it to review its contents.'),
  ).toBeVisible();
  await page.reload();
  await expect(task).toHaveCount(0);
  await page.goto('/#tutorials');
  await page.getByRole('link', { name: 'Explore the sales example' }).click();
  await expect(followUp.getByRole('link', { name: 'Open follow-up report' })).toBeVisible();
  await expect(followUp.getByRole('button', { name: 'Copy follow-up task' })).toHaveCount(0);
  expect(
    workspace.requests.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/keys')),
  ).toHaveLength(0);
});

test('follow-up task offers a usable download when clipboard access fails', async ({
  page,
  workspace,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('Clipboard unavailable');
        },
      },
    });
  });
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  const task = page.getByRole('region', { name: 'Explore US sales' });
  await task.getByRole('button', { name: 'Try with an agent' }).click();
  await expect(task.getByText('Sample ready · /us-sales.csv')).toBeVisible();
  workspace.state.files.push({
    id: 'report',
    resourceId: 'fs_sales',
    path: '/us-sales-report.md',
    type: 'file',
    content: '# Report',
    size: 8,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await page.reload();
  const followUp = task.getByRole('region', { name: 'Follow-up task' });
  await followUp.getByRole('button', { name: 'Copy follow-up task', exact: true }).click();
  await expect(followUp.getByText(/Copy didn’t work/)).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await followUp.getByRole('button', { name: 'Download follow-up task' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('workspace-follow-up-task.txt');
  const text = await readFile(await download.path(), 'utf8');
  expect(text).toContain('/us-sales-follow-up.md');
  expect(text).toContain('/skills/drive9-workspace/SKILL.md');
  expect(text).not.toContain('awk_');
  await followUp.getByRole('button', { name: 'Continue to waiting' }).click();
  await expect(followUp.getByText(/Give the task to your agent/)).toBeVisible();
  await expect(followUp.getByRole('button', { name: 'Check follow-up report' })).toBeVisible();
});

test('an existing key and an unavailable clipboard have a recoverable path', async ({
  page,
  workspace,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('Clipboard unavailable');
        },
      },
    });
  });
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  const task = page.getByRole('region', { name: 'Explore US sales' });
  await task.getByRole('button', { name: 'Try with an agent' }).click();
  await expect(task.getByText('Sample ready · /us-sales.csv')).toBeVisible();
  await page.reload();
  await expect(task.getByRole('button', { name: 'Connect your agent' })).toBeVisible();
  await task.getByRole('button', { name: 'I already have a key' }).click();
  await task.getByRole('button', { name: 'Copy task for your agent' }).click();
  await expect(task.getByRole('button', { name: 'Check now' })).toHaveCount(0);
  await expect(task.getByText('Show task and connection instructions')).toHaveCount(0);
  const taskDownload = page.waitForEvent('download');
  await task.getByRole('button', { name: 'Download task' }).click();
  const downloaded = await taskDownload;
  const downloadedTask = await readFile(await downloaded.path(), 'utf8');
  expect(downloaded.suggestedFilename()).toBe('workspace-task.txt');
  expect(downloadedTask).toContain('/skills/drive9-workspace/SKILL.md');
  expect(downloadedTask).toContain('/us-sales.csv');
  expect(downloadedTask).not.toContain('synthetic-browser-key-never-valid-on-a-provider');
  await task.getByRole('button', { name: 'Continue to report' }).click();
  await expect(task.getByRole('button', { name: 'Check now' })).toBeVisible();
  expect(
    workspace.requests.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/keys')),
  ).toHaveLength(0);
  workspace.state.files.find((file) => file.path === '/us-sales.csv').version = '"edited"';
  await page.reload();
  await expect(task.getByText(/This sample has changed since it was created/)).toBeVisible();
  await expect(task.getByRole('button', { name: 'Connect your agent' })).toBeDisabled();
  await expect(task.getByRole('button', { name: 'I already have a key' })).toBeDisabled();
  await expect(task.getByRole('button', { name: 'Download task' })).toHaveCount(0);
});

test('a launch command can be selected when clipboard access is unavailable', async ({
  page,
  workspace,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('Clipboard unavailable');
        },
      },
    });
  });
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  const task = page.getByRole('region', { name: 'Explore US sales' });
  await task.getByRole('button', { name: 'Try with an agent' }).click();
  await task.getByRole('button', { name: 'Connect your agent' }).click();
  await page
    .getByRole('dialog', { name: 'Create API key' })
    .getByRole('button', { name: 'Create key', exact: true })
    .click();
  const ready = page.getByRole('dialog', { name: 'Your key is ready' });
  await ready.getByRole('button', { name: 'Copy terminal command', exact: true }).click();
  await expect(ready.getByRole('heading', { name: '1 of 2 · Open a terminal' })).toBeVisible();
  await ready.getByText('Review command').click();
  await expect(ready.getByText(/read -rs WORKSPACE_API_KEY/)).toBeVisible();
  await ready.getByRole('button', { name: 'I copied the command' }).click();
  await expect(ready.getByRole('heading', { name: '2 of 2 · Add your key' })).toBeVisible();
});

test('report checking explains a temporary error and permits a manual retry', async ({
  page,
  workspace,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} } });
  });
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  const task = page.getByRole('region', { name: 'Explore US sales' });
  await task.getByRole('button', { name: 'Try with an agent' }).click();
  await task.getByRole('button', { name: 'I already have a key' }).click();
  let failReportCheck = true;
  await page.route('**/files/metadata?*', async (route) => {
    const url = new URL(route.request().url());
    if (failReportCheck && url.searchParams.get('path') === '/us-sales-report.md') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Unavailable' } }),
      });
    } else await route.fallback();
  });
  await task.getByRole('button', { name: 'Copy task for your agent' }).click();
  await expect(task.getByText('Could not check the report. We will try again.')).toBeVisible();
  failReportCheck = false;
  await task.getByRole('button', { name: 'Check now' }).click();
  await expect(task.getByText('Could not check the report. We will try again.')).toHaveCount(0);
  await expect(
    task.getByText('No report yet. We’ll keep looking while this page is open.'),
  ).toBeVisible();
});

test('a key missing required access does not advance the sales task', async ({
  page,
  workspace,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('Clipboard unavailable');
        },
      },
    });
  });
  workspace.requireSignIn({ guestEnabled: true });
  workspace.state.keyCreateRegionalStatus = 'pending';
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  const task = page.getByRole('region', { name: 'Explore US sales' });
  await task.getByRole('button', { name: 'Try with an agent' }).click();
  await task.getByRole('button', { name: 'Connect your agent' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create API key' });
  await dialog.getByRole('checkbox', { name: /files:write/ }).uncheck();
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
  const readyKey = page.getByRole('dialog', { name: 'Your key is ready' });
  await expect(
    readyKey.getByRole('alert').filter({ hasText: 'missing permissions' }),
  ).toBeVisible();
  await expect(
    readyKey.getByRole('alert').filter({ hasText: 'access is still being applied' }),
  ).toBeVisible();
  await readyKey.getByRole('button', { name: 'Continue to key' }).click();
  await readyKey.getByRole('button', { name: 'Copy key', exact: true }).click();
  await readyKey.getByRole('button', { name: 'I’ve added the key' }).click();
  await expect(readyKey.getByRole('alert')).toContainText('full key cannot be shown again');
  await readyKey.getByRole('button', { name: 'Continue without copying' }).click();
  await expect(task.getByText(/does not include all the access needed/)).toBeVisible();
  await expect(task.getByRole('button', { name: 'Connect your agent' })).toBeVisible();
  await expect(task.getByRole('button', { name: 'Copy task for your agent' })).toHaveCount(0);
});

test('a missing connection endpoint does not offer placeholder task instructions', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  workspace.state.globalApiUnavailable = true;
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  const task = page.getByRole('region', { name: 'Explore US sales' });
  await task.getByRole('button', { name: 'Try with an agent' }).click();
  await task.getByRole('button', { name: 'I already have a key' }).click();
  await expect(task.getByRole('button', { name: 'Copy task for your agent' })).toBeDisabled();
  await expect(task.getByRole('button', { name: 'Download task' })).toHaveCount(0);
  await expect(task.getByRole('link', { name: 'Open connection instructions' })).toHaveAttribute(
    'href',
    '#connect',
  );
});

test('Guest can retry while the workspace is still preparing', async ({ page, workspace }) => {
  workspace.requireSignIn({ guestEnabled: true });
  const keys = [];
  await page.route('**/sales-sample-attempts', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    keys.push(route.request().headers()['idempotency-key']);
    if (keys.length > 1) return route.fallback();
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'RESOURCE_INDEX_MIGRATING', message: 'Preparing' } }),
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  const task = page.getByRole('region', { name: 'Explore US sales' });
  await task.getByRole('button', { name: 'Try with an agent' }).click();
  await expect(
    task.getByText('Your workspace is still getting ready. Try again in a moment.'),
  ).toBeVisible();
  await task.getByRole('button', { name: 'Try again' }).click();
  await expect(task.getByText('Sample ready · /us-sales.csv')).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
});

test('the published Workspace skill is available at root and mounted Console paths', async ({
  page,
}) => {
  for (const prefix of ['', '/studio']) {
    const response = await page.request.get(`${prefix}/skills/drive9-workspace/SKILL.md`);
    expect(response.ok()).toBe(true);
    const body = await response.text();
    expect(body).toContain('name: drive9-workspace');
    expect(body).toContain('If-None-Match: *');
  }
});

test('returning to an agent example hides it only when both reports can be found', async ({
  page,
  context,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  const sample = page.getByRole('region', { name: 'Explore US sales' });
  await sample.getByRole('button', { name: 'Try with an agent' }).click();
  await expect(sample.getByRole('button', { name: 'Connect your agent' })).toBeVisible();
  const report = (path) => ({
    id: path,
    resourceId: 'fs_sales',
    path,
    type: 'file',
    content: '# Report\n',
    size: 9,
    version: '"report-version"',
    updatedAt: '2026-01-01T00:00:00Z',
  });
  workspace.state.files.push(report('/us-sales-report.md'));
  await page.reload();
  await expect(sample.getByRole('link', { name: 'Open report', exact: true })).toBeVisible();
  let unavailable = true;
  await context.route('**/files/metadata?**', async (route) => {
    if (
      unavailable &&
      new URL(route.request().url()).searchParams.get('path') === '/us-sales-follow-up.md'
    )
      return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } });
    return route.fallback();
  });
  workspace.state.files.push(report('/us-sales-follow-up.md'));
  await page.reload();
  await expect(sample.getByRole('link', { name: 'Open report', exact: true })).toBeVisible();
  unavailable = false;
  await page.reload();
  await expect(sample).toHaveCount(0);
  await page.goto('/#tutorials');
  await page.getByRole('link', { name: 'Explore the sales example' }).click();
  await expect(sample.getByRole('link', { name: 'Open follow-up report' })).toBeVisible();
  expect(
    workspace.state.files.filter(
      (file) => file.path.includes('sales-report') || file.path.includes('sales-follow-up'),
    ),
  ).toHaveLength(2);
});
