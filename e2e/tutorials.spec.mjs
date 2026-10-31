import { test, expect } from './workspace-fixture.mjs';
import { ordersCsv, expectedTotals } from '../src/features/portal/tutorial-data.ts';

async function tutorialApi(context, workspace, { uncertainSeed = false } = {}) {
  const calls = [];
  const tables = new Set();
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(`/api/v1/workspaces/${workspace.state.workspace.id}`, '');
    const method = request.method();
    const reply = (body, status = 200) => route.fulfill({ json: body, status });
    if (path === '/queries' && method === 'POST') {
      const body = request.postDataJSON();
      calls.push({ ...body, action: 'query' });
      if (body.sql.startsWith('CREATE TABLE')) {
        const table = /tutorial_orders_[a-f0-9]{32}/.exec(body.sql)?.[0];
        expect(table).toBeTruthy();
        expect(tables.has(table)).toBe(false);
        tables.add(table);
        if (uncertainSeed) {
          uncertainSeed = false;
          return reply(
            { error: { code: 'UNAVAILABLE', message: 'Save outcome is unknown.' } },
            503,
          );
        }
        return reply({
          columns: [],
          rows: [],
          rowCount: 0,
          affectedRows: 6,
          mode: 'live',
          durationMs: 1,
        });
      }
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
      expect(body.content).toBe(ordersCsv);
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
      });
    if (path === '/file-analyses/capabilities')
      return reply({
        engine: 'duckdb',
        available: true,
        engines: [{ engine: 'duckdb', available: true, reason: '' }],
      });
    if (path === '/file-analyses' && method === 'POST') {
      const body = request.postDataJSON();
      calls.push({ ...body, action: 'analyze' });
      expect(
        workspace.state.files.find(
          (file) => file.resourceId === body.resourceId && file.path === body.path,
        )?.content,
      ).toBe(ordersCsv);
      return reply({
        ...body,
        columns: ['region', 'total'],
        rows: expectedTotals,
        rowCount: 3,
        readOnly: true,
        inputBytes: ordersCsv.length,
        durationMs: 1,
      });
    }
    return route.fallback();
  });
  return calls;
}

test('tutorial samples run once and can be found and resumed after reopening a tab', async ({
  page,
  context,
  workspace,
}, testInfo) => {
  workspace.addResources();
  workspace.state.resources[0].provider = 'tidb-cloud-zero';
  const calls = await tutorialApi(context, workspace);
  await workspace.open('#tutorials');
  const database = page.locator('#tutorial-database');
  const files = page.locator('#tutorial-filesystem');
  await expect(
    database.getByRole('button', { name: 'Run tutorial query', exact: true }),
  ).toBeDisabled();
  await database.getByRole('button', { name: 'Load sample orders', exact: true }).click();
  await database.getByRole('button', { name: 'Run tutorial query', exact: true }).click();
  await expect(database.getByRole('region', { name: 'Query result data' })).toContainText('240');
  await files.getByRole('button', { name: 'Save sample CSV', exact: true }).click();
  await files.getByRole('button', { name: 'Run tutorial query', exact: true }).click();
  await expect(files.getByRole('region', { name: 'Query result data' })).toContainText('180');
  const originalTable = /tutorial_orders_[a-f0-9]{32}/.exec(
    calls.find((call) => call.sql?.startsWith('CREATE TABLE')).sql,
  )[0];
  const originalPath = calls.find((call) => call.action === 'file').path;
  const before = calls.length;
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto('/#overview');
  const resume = reopened.getByRole('region', { name: 'Your tutorials', exact: true });
  await expect(resume.getByText('Completed', { exact: true })).toHaveCount(2);
  if (process.env.TUTORIAL_SCREENSHOTS) {
    await resume.scrollIntoViewIfNeeded();
    await reopened.screenshot({
      path: `${process.env.TUTORIAL_SCREENSHOTS}/resume-${testInfo.project.name}.png`,
      fullPage: false,
    });
  }
  await resume
    .locator('.tutorial-resume-card')
    .filter({ hasText: 'mysql-fixture' })
    .getByRole('link', { name: 'Revisit tutorial', exact: true })
    .click();
  await expect(reopened).toHaveURL(/#tutorials\?resourceId=db_fixture$/);
  await expect(reopened.locator('#tutorial-database')).toContainText(originalTable);
  await expect(
    reopened.locator('#tutorial-database').getByText('Tutorial completed', { exact: true }),
  ).toBeVisible();
  expect(calls).toHaveLength(before);
  await reopened.goto('/#overview');
  await reopened
    .getByRole('region', { name: 'Your tutorials', exact: true })
    .locator('.tutorial-resume-card')
    .filter({ hasText: 'filesystem-fixture' })
    .getByRole('link', { name: 'Revisit tutorial', exact: true })
    .click();
  await expect(reopened).toHaveURL(/#tutorials\?resourceId=fs_fixture$/);
  await expect(reopened.locator('#tutorial-filesystem')).toContainText(originalPath);
  expect(calls.filter((call) => call.action === 'file')).toHaveLength(1);
  expect(calls.filter((call) => call.sql?.startsWith('CREATE TABLE'))).toHaveLength(1);
  await expect
    .poll(() => reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
});

test('tutorial creation selects the returned resource and continues with included data', async ({
  page,
  context,
  workspace,
}) => {
  const calls = await tutorialApi(context, workspace);
  await workspace.open('#tutorials');
  await page
    .locator('#tutorial-database')
    .getByRole('button', { name: 'Create database', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create database', exact: true })
    .click();
  await expect(page).toHaveURL(/#tutorials\?resourceId=fixture_mysql_0$/);
  await expect(page.getByRole('combobox', { name: 'Tutorial database', exact: true })).toHaveValue(
    'fixture_mysql_0',
  );
  await page
    .locator('#tutorial-database')
    .getByRole('button', { name: 'Run tutorial query', exact: true })
    .click();
  await expect(
    page.locator('#tutorial-database').getByText('Your first result is ready', { exact: true }),
  ).toBeVisible();
  await page
    .locator('#tutorial-filesystem')
    .getByRole('button', { name: 'Create File System', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create file system', exact: true })
    .click();
  await expect(page).toHaveURL(/#tutorials\?resourceId=fixture_filesystem_1$/);
  await expect(
    page.getByRole('combobox', { name: 'Tutorial File System', exact: true }),
  ).toHaveValue('fixture_filesystem_1');
  await page.getByRole('button', { name: 'Save sample CSV', exact: true }).click();
  await page
    .locator('#tutorial-filesystem')
    .getByRole('button', { name: 'Run tutorial query', exact: true })
    .click();
  await expect(
    page.locator('#tutorial-filesystem').getByText('Your first result is ready', { exact: true }),
  ).toBeVisible();
  expect(calls.filter((call) => call.action === 'analyze')[0].resourceId).toBe(
    'fixture_filesystem_1',
  );
});

test('uncertain tutorial writes are checked without replay and missing resource links stay explicit', async ({
  page,
  context,
  workspace,
}) => {
  workspace.addResources();
  workspace.state.resources[0].provider = 'tidb-cloud-zero';
  const calls = await tutorialApi(context, workspace, { uncertainSeed: true });
  await workspace.open('#tutorials?resourceId=db_fixture');
  const database = page.locator('#tutorial-database');
  await database.getByRole('button', { name: 'Load sample orders', exact: true }).click();
  await expect(database.getByRole('alert')).toContainText('Save outcome is unknown');
  await expect(
    database.getByRole('button', { name: 'Load sample orders', exact: true }),
  ).toBeDisabled();
  await database.getByRole('button', { name: 'Check saved sample', exact: true }).click();
  await expect(database.getByRole('region', { name: 'Query result data' })).toContainText('240');
  expect(calls.filter((call) => call.sql?.startsWith('CREATE TABLE'))).toHaveLength(1);
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
