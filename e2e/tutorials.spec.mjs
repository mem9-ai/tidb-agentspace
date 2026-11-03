import { test, expect } from './workspace-fixture.mjs';
import { ordersCsv, orderRows, expectedTotals } from '../src/features/portal/tutorial-data.ts';

async function tutorialApi(
  context,
  workspace,
  { uncertainSeed = false, beforeSeed, beforeFileSave } = {},
) {
  const calls = [];
  const tables = new Set();
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(
      `/api/portal/v1/workspaces/${workspace.state.workspace.id}`,
      '',
    );
    const method = request.method();
    const reply = (body, status = 200) => route.fulfill({ json: body, status });
    if (path === '/database-import-preparations' && method === 'POST') {
      calls.push({ action: 'prepare', resourceId: url.searchParams.get('resourceId') });
      expect(request.postData()).toBe(ordersCsv);
      expect(url.searchParams.get('format')).toBe('csv');
      expect(url.searchParams.get('header')).toBe('true');
      return reply(
        {
          id: 'tutorial-preparation',
          status: 'ready',
          createdAt: '2026-10-31T00:00:00Z',
          expiresAt: '2099-01-01T00:00:00Z',
          fields: [
            { source: 'id', name: 'id', type: 'BIGINT' },
            { source: 'region', name: 'region', type: 'TEXT' },
            { source: 'amount', name: 'amount', type: 'BIGINT' },
          ],
          rows: orderRows,
          rowCount: 6,
          sourceVersion: 'tutorial-source',
          inputBytes: ordersCsv.length,
          format: 'csv',
        },
        201,
      );
    }
    if (path === '/database-imports' && method === 'POST') {
      const body = request.postDataJSON();
      calls.push({ ...body, action: 'seed' });
      expect(body.preparationId).toBe('tutorial-preparation');
      expect(body.confirmed).toBe(true);
      expect(body.table).toMatch(/^tutorial_orders_[a-f0-9]{32}$/);
      expect(tables.has(body.table)).toBe(false);
      tables.add(body.table);
      await beforeSeed?.();
      if (uncertainSeed) {
        uncertainSeed = false;
        return reply({ error: { code: 'UNAVAILABLE', message: 'Save outcome is unknown.' } }, 503);
      }
      return reply({
        kind: 'database',
        resourceId: body.resourceId,
        table: body.table,
        rowCount: 6,
        columns: body.fields.map(({ name, type }) => ({ name, type })),
      });
    }
    if (path === '/queries' && method === 'POST') {
      const body = request.postDataJSON();
      calls.push({ ...body, action: 'query' });
      expect(body.sql).not.toMatch(/^CREATE TABLE/i);
      if (body.sql.includes('agent_events'))
        return reply({
          columns: ['id', 'status'],
          rows: [1, 2, 3].map((id) => ({ id, status: 'completed' })),
          rowCount: 3,
          mode: 'demo',
          durationMs: 1,
        });
      const table = /tutorial_orders_[a-f0-9]{32}/.exec(body.sql)?.[0];
      if (!tables.has(table))
        return reply({ error: { code: 'QUERY_FAILED', message: 'Sample table is missing.' } }, 400);
      return reply({
        columns: ['region', 'total'],
        rows: expectedTotals,
        rowCount: 3,
        mode: 'live',
        durationMs: 1,
      });
    }
    if (path === '/files' && method === 'PUT') {
      const body = request.postDataJSON();
      calls.push({ ...body, action: 'file' });
      await beforeFileSave?.();
      if (body.path.includes('-notes.md') || body.path.includes('-activity.log')) {
        expect(request.headers()['if-none-match']).toBe('*');
        expect(workspace.state.files.some((file) => file.path === body.path)).toBe(false);
      } else expect(body.content).toBe(ordersCsv);
      const file = {
        ...body,
        id: body.path,
        size: body.content.length,
        updatedAt: '2026-01-01T00:00:00Z',
      };
      workspace.state.files.push(file);
      return reply({ data: file });
    }
    if (path === '/files' && method === 'GET')
      return reply({
        data: workspace.state.files.filter(
          (file) => file.resourceId === url.searchParams.get('resourceId'),
        ),
        nextCursor: null,
      });
    if (path === '/files/tabular-preview')
      return reply({
        resourceId: url.searchParams.get('resourceId'),
        path: url.searchParams.get('path'),
        format: 'csv',
        readOnly: true,
        inputBytes: ordersCsv.length,
        durationMs: 1,
        fileVersion: 'a'.repeat(64),
        columns: ['id', 'region', 'amount'],
        schema: [
          { column_name: 'id', column_type: 'BIGINT' },
          { column_name: 'region', column_type: 'VARCHAR' },
          { column_name: 'amount', column_type: 'BIGINT' },
        ],
        rows: orderRows,
        rowCount: orderRows.length,
        totalRows: null,
        typesInferred: true,
      });
    if (path === '/file-analyses/capabilities') {
      if (url.searchParams.get('path')?.endsWith('-activity.log'))
        return reply({
          engine: 'bash',
          available: true,
          engines: [
            {
              engine: 'bash',
              available: true,
              reason: '',
              input: { path: '/workspace/input.log', workingDirectory: '/workspace', aliases: [] },
            },
          ],
        });
      return reply({
        engine: 'duckdb',
        available: true,
        engines: [{ engine: 'duckdb', available: true, reason: '' }],
      });
    }
    if (path === '/file-analyses' && method === 'POST') {
      const body = request.postDataJSON();
      calls.push({ ...body, action: 'analyze' });
      if (body.engine === 'bash') {
        expect(body.command).toBe("grep -n 'ERROR' '/workspace/input.log' | head -20");
        const file = workspace.state.files.find(
          (entry) => entry.resourceId === body.resourceId && entry.path === body.path,
        );
        expect(file.content).toContain('ERROR APAC sync timed out');
        return reply({
          engine: 'bash',
          stdout: '2:2026-10-30T09:01:00Z ERROR APAC sync timed out\n',
          stderr: '',
          exitCode: 0,
          inputBytes: file.content.length,
          durationMs: 1,
        });
      }
      expect(
        workspace.state.files.find(
          (file) => file.resourceId === body.resourceId && file.path === body.path,
        )?.content,
      ).toBe(ordersCsv);
      expect(body.sql).toBe('SELECT * FROM file LIMIT 100;');
      return reply({
        ...body,
        columns: ['id', 'region', 'amount'],
        rows: orderRows,
        rowCount: orderRows.length,
        readOnly: true,
        inputBytes: ordersCsv.length,
        durationMs: 1,
      });
    }
    return route.fallback();
  };
  await context.route('**/api/**', handler);
  return { calls, connectContext: (other) => other.route('**/api/**', handler) };
}

test('@visual the sales tutorial leads to the shared example without creating files', async ({
  page,
  context,
  workspace,
}, testInfo) => {
  workspace.addResources();
  const { calls } = await tutorialApi(context, workspace);
  await workspace.open('#tutorials');
  const tutorial = page.locator('#tutorial-filesystem');
  await expect(tutorial.getByRole('heading', { name: 'Explore US sales' })).toBeVisible();
  await expect(tutorial).toContainText('Markdown report with a Mermaid chart');
  await expect(page.getByRole('tab', { name: 'Markdown', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Logs · Bash', exact: true })).toHaveCount(0);
  if (process.env.TUTORIAL_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.TUTORIAL_SCREENSHOTS}/sales-${testInfo.project.name}.png`,
    });
  await tutorial.getByRole('link', { name: 'Explore the sales example' }).click();
  await expect(page).toHaveURL(/#overview\?example=sales$/);
  await expect(page.getByRole('region', { name: 'Explore US sales' })).toBeVisible();
  expect(calls.filter((call) => call.action === 'file')).toHaveLength(0);
});

test('database tutorial creation selects the returned resource', async ({
  page,
  context,
  workspace,
}) => {
  await tutorialApi(context, workspace);
  await workspace.open('#tutorials');
  await page.getByRole('tab', { name: 'Database', exact: true }).click();
  await page
    .locator('#tutorial-database')
    .getByRole('button', { name: 'Create database', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create database', exact: true })
    .click();
  await expect(page).toHaveURL(/#tutorials\?resourceId=fixture_postgresql_0$/);
  await expect(page.getByRole('combobox', { name: 'Tutorial database', exact: true })).toHaveValue(
    'fixture_postgresql_0',
  );
  await page
    .locator('#tutorial-database')
    .getByRole('button', { name: 'Run tutorial query', exact: true })
    .click();
  await expect(
    page.locator('#tutorial-database').getByText('Your first result is ready', { exact: true }),
  ).toBeVisible();
});

test('the sales tutorial explains which workspace the example uses', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  workspace.state.resources[1].connectionError = 'Connection unavailable. Try again.';
  await workspace.open('#tutorials?resourceId=fs_fixture');
  const tutorial = page.locator('#tutorial-filesystem');
  await expect(tutorial).toContainText('a File System in your workspace');
  await expect(tutorial.getByRole('link', { name: 'Explore the sales example' })).toBeVisible();
});

test('only the saved CSV sample completes the tutorial, and a progress failure keeps the result', async ({
  page,
  context,
  workspace,
}) => {
  workspace.addResources();
  const id = 'a'.repeat(32);
  const samplePath = `/tutorial-orders-${id}.csv`;
  workspace.tutorials.set('fs_fixture', {
    resourceId: 'fs_fixture',
    sampleId: id,
    state: 'ready',
    version: '"tutorial-' + 'b'.repeat(32) + '"',
    updatedAt: '2026-10-31T00:00:00Z',
  });
  for (const path of ['/other.csv', samplePath])
    workspace.state.files.push({
      id: path,
      resourceId: 'fs_fixture',
      path,
      type: 'file',
      content: ordersCsv,
      size: ordersCsv.length,
      updatedAt: '2026-01-01T00:00:00Z',
    });
  await tutorialApi(context, workspace);
  await workspace.open('#files?resourceId=fs_fixture&path=%2Fother.csv&view=analyze');
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Query result data' })).toContainText('APAC');
  expect(workspace.tutorials.get('fs_fixture').state).toBe('ready');
  await context.route('**/api/**', async (route) => {
    if (
      route.request().method() === 'PUT' &&
      new URL(route.request().url()).pathname.endsWith('/tutorials/fs_fixture')
    )
      return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } });
    return route.fallback();
  });
  await page.goto(
    `/#files?resourceId=fs_fixture&path=${encodeURIComponent(samplePath)}&view=analyze`,
  );
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Query result data' })).toContainText('APAC');
  await expect(
    page.getByRole('alert').filter({ hasText: 'tutorial progress could not be saved' }),
  ).toBeVisible();
  expect(workspace.tutorials.get('fs_fixture').state).toBe('ready');
});

test('@visual saving a database sample shows activity without repeating the write', async ({
  page,
  context,
  workspace,
}) => {
  workspace.addResources();
  workspace.state.resources[0].provider = 'tidb-cloud-zero';
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { calls } = await tutorialApi(context, workspace, { beforeSeed: () => pending });
  try {
    await workspace.open('#tutorials?resourceId=db_fixture');
    const card = page.locator('#tutorial-database');
    await card.getByRole('button', { name: 'Load sample orders', exact: true }).click();
    await expect.poll(() => calls.some((call) => call.action === 'seed')).toBe(true);
    await expect(card.getByRole('status')).toContainText('Saving the sample');
    await expect(card.getByRole('button', { name: 'Saving sample data…' })).toBeDisabled();
    await expect(card.getByRole('button', { name: 'Run tutorial query' })).toBeDisabled();
    release();
    await expect(card.getByText('Sample data ready', { exact: true })).toBeVisible();
    expect(calls.filter((call) => call.action === 'seed')).toHaveLength(1);
  } finally {
    release();
  }
});

test('@visual empty resource workspaces lead directly to their focused tutorial and back to all tutorials', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.addResources();
  workspace.state.resources[0].name = 'sales-demo';
  workspace.state.resources[1].name = 'demo-files';
  workspace.state.profile.name = 'Developer';
  workspace.state.files = [];
  await workspace.open('#databases/db_fixture/sql');
  const start = page.getByRole('button', { name: 'Try sample data', exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page).toHaveURL(/#tutorials\?resourceId=db_fixture$/);
  await expect(page.locator('#tutorial-database')).toBeVisible();
  await expect(page.locator('#tutorial-filesystem')).toHaveCount(0);
  await page.getByRole('link', { name: 'All tutorials', exact: true }).click();
  await expect(page.locator('#tutorial-filesystem')).toBeVisible();
  await page.goto('/#files?resourceId=fs_fixture');
  await page.getByRole('button', { name: 'Try sample data', exact: true }).click();
  await expect(page).toHaveURL(/#tutorials\?resourceId=fs_fixture$/);
  await expect(page.locator('#tutorial-filesystem')).toBeVisible();
  await expect(page.locator('#tutorial-database')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Color theme', exact: true }).selectOption('auto');
  if (process.env.EXPERIENCE_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.EXPERIENCE_SCREENSHOTS}/focused-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
});

test('uncertain tutorial writes are checked without replay and missing resource links stay explicit', async ({
  page,
  context,
  workspace,
}) => {
  workspace.addResources();
  workspace.state.resources[0].provider = 'tidb-cloud-zero';
  const { calls } = await tutorialApi(context, workspace, { uncertainSeed: true });
  await workspace.open('#tutorials?resourceId=db_fixture');
  const database = page.locator('#tutorial-database');
  await database.getByRole('button', { name: 'Load sample orders', exact: true }).click();
  await expect(database.getByRole('alert')).toContainText('Save outcome is unknown');
  await expect(
    database.getByRole('button', { name: 'Load sample orders', exact: true }),
  ).toBeDisabled();
  await database.getByRole('button', { name: 'Check saved sample', exact: true }).click();
  await expect(database.getByRole('region', { name: 'Query result data' })).toContainText('240');
  expect(calls.filter((call) => call.action === 'seed')).toHaveLength(1);
  await page.goto('/#tutorials?resourceId=missing');
  await expect(page.getByText('Tutorial resource unavailable', { exact: true })).toBeVisible();
  await expect(page.locator('#tutorial-database')).toHaveCount(0);
});

test('resource workspaces return to their own tutorial and preserve unsaved file drafts', async ({
  page,
  context,
  workspace,
}) => {
  workspace.addResources();
  await tutorialApi(context, workspace);
  await workspace.open('#databases/db_fixture/sql');
  await page.getByRole('button', { name: 'Tutorial', exact: true }).click();
  await expect(page).toHaveURL(/#tutorials\?resourceId=db_fixture$/);
  await page.goto('/#files?resourceId=fs_fixture&path=%2FREADME.md&view=preview');
  await page.getByRole('button', { name: 'Edit source', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'File content', exact: true })
    .fill('Unsaved tutorial draft');
  await page.getByRole('button', { name: 'Tutorial', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Keep your changes?', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'File content', exact: true })).toHaveValue(
    'Unsaved tutorial draft',
  );
  await page.getByRole('button', { name: 'Tutorial', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page).toHaveURL(/#tutorials\?resourceId=fs_fixture$/);
});

test('unavailable progress blocks sample writes and unknown save acknowledgements are checked without replay', async ({
  page,
  context,
  workspace,
}) => {
  workspace.addResources();
  workspace.state.resources[0].provider = 'tidb-cloud-zero';
  const { calls } = await tutorialApi(context, workspace);
  let unavailable = true;
  let loseAcknowledgement = true;
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (unavailable && path.endsWith('/tutorials'))
      return route.fulfill({
        status: 503,
        json: { error: { code: 'UNAVAILABLE', message: 'Progress unavailable' } },
      });
    if (
      loseAcknowledgement &&
      request.method() === 'PUT' &&
      path.endsWith('/tutorials/db_fixture')
    ) {
      loseAcknowledgement = false;
      workspace.tutorials.set('db_fixture', {
        ...request.postDataJSON(),
        resourceId: 'db_fixture',
        version: '"tutorial-' + 'f'.repeat(32) + '"',
        updatedAt: '2026-10-31T00:00:00Z',
      });
      return route.fulfill({
        status: 503,
        json: { error: { code: 'UNAVAILABLE', message: 'Acknowledgement lost' } },
      });
    }
    return route.fallback();
  });
  await workspace.open('#tutorials');
  await expect(page.getByRole('link', { name: 'Explore the sales example' })).toBeVisible();
  await page.getByRole('tab', { name: 'Database', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not load or migrate');
  await expect(page.getByRole('button', { name: 'Load sample orders', exact: true })).toHaveCount(
    0,
  );
  expect(calls).toHaveLength(0);
  unavailable = false;
  await page.getByRole('button', { name: 'Retry tutorial progress', exact: true }).click();
  const database = page.locator('#tutorial-database');
  await database.getByRole('button', { name: 'Load sample orders', exact: true }).click();
  await expect(database.getByRole('alert')).toContainText('No sample action was retried');
  await expect(
    database.getByRole('button', { name: 'Load sample orders', exact: true }),
  ).toBeDisabled();
  expect(calls.filter((call) => call.action === 'seed')).toHaveLength(0);
  await database.getByRole('button', { name: 'Check saved sample', exact: true }).click();
  await expect(database.getByRole('alert')).toContainText('Sample table is missing');
  await database
    .getByRole('button', { name: 'Use a new sample name (keep the previous sample)', exact: true })
    .click();
  await database.getByRole('button', { name: 'Load sample orders', exact: true }).click();
  await database.getByRole('button', { name: 'Run tutorial query', exact: true }).click();
  await expect(database.getByRole('region', { name: 'Query result data' })).toContainText('240');
  expect(calls.filter((call) => call.action === 'seed')).toHaveLength(1);
});

test('legacy browser migration retains uncertain sample identity and Workspace state wins', async ({
  page,
  context,
  workspace,
}) => {
  workspace.addResources();
  const { calls } = await tutorialApi(context, workspace);
  workspace.tutorials.set('db_fixture', {
    resourceId: 'db_fixture',
    sampleId: 'c'.repeat(32),
    state: 'ready',
    version: '"tutorial-' + 'e'.repeat(32) + '"',
    updatedAt: '2026-10-31T00:00:00Z',
  });
  await context.addInitScript(() => {
    localStorage.setItem(
      'workspace-tutorial:v1:ws_personal_fixture:db_fixture',
      JSON.stringify({ id: 'a'.repeat(32), attempted: true, ready: true, completed: true }),
    );
    localStorage.setItem(
      'workspace-tutorial:v1:ws_personal_fixture:fs_fixture',
      JSON.stringify({ id: 'b'.repeat(32), attempted: true, ready: false, completed: false }),
    );
  });
  await workspace.open('#overview');
  const resume = page.getByRole('region', { name: 'Your tutorials', exact: true });
  await expect(resume.getByText('Sample ready', { exact: true })).toBeVisible();
  await expect(resume.getByText('Check sample', { exact: true })).toBeVisible();
  await resume
    .locator('.tutorial-resume-card')
    .filter({ hasText: 'filesystem-fixture' })
    .getByRole('link', { name: 'Check earlier sample', exact: true })
    .click();
  await expect(page).toHaveURL(/tutorial-orders-b{32}\.csv/);
  expect(workspace.tutorials.get('db_fixture').sampleId).toBe('c'.repeat(32));
  expect(workspace.tutorials.get('fs_fixture').state).toBe('attempted');
  expect(calls).toHaveLength(0);
});

test('existing tutorial files remain available after the tutorial changes', async ({
  page,
  context,
  workspace,
}) => {
  workspace.addResources();
  const id = 'a'.repeat(32);
  const samplePath = `/tutorial-orders-${id}.csv`;
  workspace.tutorials.set('fs_fixture', {
    resourceId: 'fs_fixture',
    sampleId: id,
    state: 'ready',
    version: '"tutorial-' + 'b'.repeat(32) + '"',
    updatedAt: '2026-10-31T00:00:00Z',
  });
  workspace.state.files.push({
    id: samplePath,
    resourceId: 'fs_fixture',
    path: samplePath,
    type: 'file',
    content: ordersCsv,
    size: ordersCsv.length,
    updatedAt: '2026-01-01T00:00:00Z',
  });
  await tutorialApi(context, workspace);
  await workspace.open('#overview');
  await page
    .getByRole('region', { name: 'Your tutorials' })
    .getByRole('link', { name: 'Open earlier sample' })
    .click();
  await expect(page).toHaveURL(/tutorial-orders-.*\.csv/);
  await expect(
    page.getByRole('complementary', { name: `tutorial-orders-${id}.csv` }),
  ).toBeVisible();
  expect(workspace.state.files.find((file) => file.path === samplePath).content).toBe(ordersCsv);
});

test('tutorial links to the sales journey without creating a legacy sample', async ({
  page,
  context,
  workspace,
}) => {
  workspace.addResources();
  const { calls } = await tutorialApi(context, workspace);
  await workspace.open('#tutorials?resourceId=fs_fixture');
  await page.getByRole('link', { name: 'Explore the sales example' }).click();
  await expect(page).toHaveURL(/#overview\?example=sales$/);
  expect(calls.filter((call) => call.action === 'file')).toHaveLength(0);
});

test('database sample progress resumes in a fresh browser without repeating its write', async ({
  page,
  context,
  workspace,
  browser,
}, testInfo) => {
  workspace.addResources();
  workspace.state.resources[0].provider = 'tidb-cloud-zero';
  const api = await tutorialApi(context, workspace);
  await workspace.open('#tutorials?resourceId=db_fixture');
  const tutorial = page.locator('#tutorial-database');
  await tutorial.getByRole('button', { name: 'Load sample orders' }).click();
  await tutorial.getByRole('button', { name: 'Run tutorial query' }).click();
  await expect(tutorial.getByRole('region', { name: 'Query result data' })).toContainText('240');
  const table = api.calls.find((call) => call.action === 'seed').table;
  const fresh = await browser.newContext({
    viewport: testInfo.project.use.viewport,
    colorScheme: testInfo.project.metadata.theme,
  });
  try {
    await workspace.connectContext(fresh);
    await api.connectContext(fresh);
    const reopened = await fresh.newPage();
    await reopened.goto('/#overview');
    await reopened
      .getByRole('region', { name: 'Your tutorials' })
      .getByRole('link', { name: 'Revisit tutorial' })
      .click();
    await expect(reopened.locator('#tutorial-database')).toContainText(table);
    await expect(reopened.getByText('Tutorial completed', { exact: true })).toBeVisible();
    expect(api.calls.filter((call) => call.action === 'seed')).toHaveLength(1);
  } finally {
    await fresh.close();
  }
});
