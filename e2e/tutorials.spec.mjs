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
  };
  await context.route('**/api/**', handler);
  return { calls, connectContext: (other) => other.route('**/api/**', handler) };
}

test('Workspace tutorials resume in an isolated browser with no browser progress or duplicate sample writes', async ({
  page,
  context,
  workspace,
  browser,
}, testInfo) => {
  workspace.addResources();
  workspace.state.resources[0].provider = 'tidb-cloud-zero';
  const tutorial = await tutorialApi(context, workspace);
  const { calls } = tutorial;
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
  const originalTable = calls.find((call) => call.action === 'seed').table;
  const originalPath = calls.find((call) => call.action === 'file').path;
  const before = calls.length;
  await page.close();
  const freshContext = await browser.newContext({
    viewport: testInfo.project.use.viewport,
    colorScheme: testInfo.project.metadata.theme,
  });
  try {
    await workspace.connectContext(freshContext);
    await tutorial.connectContext(freshContext);
    const reopened = await freshContext.newPage();
    await reopened.goto('/#overview');
    const resume = reopened.getByRole('region', { name: 'Your tutorials', exact: true });
    await expect(resume.getByText('Completed', { exact: true })).toHaveCount(2);
    expect(
      await reopened.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.startsWith('workspace-tutorial:')),
      ),
    ).toEqual([]);
    await expect(resume).toContainText('saved in this Workspace');
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
    await reopened
      .locator('#tutorial-database')
      .getByRole('button', { name: 'Run tutorial query', exact: true })
      .click();
    await expect(
      reopened.locator('#tutorial-database').getByRole('region', { name: 'Query result data' }),
    ).toContainText('240');
    await reopened.goto('/#overview');
    await reopened
      .getByRole('region', { name: 'Your tutorials', exact: true })
      .locator('.tutorial-resume-card')
      .filter({ hasText: 'filesystem-fixture' })
      .getByRole('link', { name: 'Revisit tutorial', exact: true })
      .click();
    await expect(reopened).toHaveURL(/#tutorials\?resourceId=fs_fixture$/);
    await expect(reopened.locator('#tutorial-filesystem')).toContainText(originalPath);
    await reopened
      .locator('#tutorial-filesystem')
      .getByRole('button', { name: 'Run tutorial query', exact: true })
      .click();
    await expect(
      reopened.locator('#tutorial-filesystem').getByRole('region', { name: 'Query result data' }),
    ).toContainText('180');
    expect(calls.filter((call) => call.action === 'file')).toHaveLength(1);
    expect(calls.filter((call) => call.action === 'seed')).toHaveLength(1);
    await expect
      .poll(() => reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
  } finally {
    await freshContext.close();
  }
});

test('tutorial creation selects the returned resource and continues with included data', async ({
  page,
  context,
  workspace,
}) => {
  const { calls } = await tutorialApi(context, workspace);
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
  await expect(page.locator('#tutorial-filesystem')).toHaveCount(0);
  await page.getByRole('link', { name: 'All tutorials', exact: true }).click();
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

test('saving a tutorial sample shows activity without reporting an uncertain outcome or running another step', async ({
  page,
  context,
  workspace,
}, testInfo) => {
  workspace.addResources();
  workspace.state.resources[0].name = 'sales-demo';
  workspace.state.resources[1].name = 'demo-files';
  workspace.state.profile.name = 'Developer';
  workspace.state.resources[0].provider = 'tidb-cloud-zero';
  let releaseDatabase, releaseFile;
  const databasePending = new Promise((resolve) => {
    releaseDatabase = resolve;
  });
  const filePending = new Promise((resolve) => {
    releaseFile = resolve;
  });
  const { calls } = await tutorialApi(context, workspace, {
    beforeSeed: () => databasePending,
    beforeFileSave: () => filePending,
  });
  try {
    await workspace.open('#tutorials');
    for (const [kind, button] of [
      ['database', 'Load sample orders'],
      ['filesystem', 'Save sample CSV'],
    ]) {
      const card = page.locator(`#tutorial-${kind}`);
      await card.getByRole('button', { name: button, exact: true }).click();
      await expect
        .poll(() => calls.some((call) => call.action === (kind === 'database' ? 'seed' : 'file')))
        .toBe(true);
      await expect(card.getByRole('status')).toContainText('Saving the sample');
      await expect(
        card.getByRole('button', { name: 'Saving sample data…', exact: true }),
      ).toBeDisabled();
      await expect(
        card.getByRole('button', { name: 'Check saved sample', exact: true }),
      ).toHaveCount(0);
      await expect(card.getByText(/The save outcome is unconfirmed/)).toHaveCount(0);
      const run = card.getByRole('button', { name: 'Run tutorial query', exact: true });
      await expect(run).toBeDisabled();
      await expect(run).not.toHaveAttribute('data-loading', 'true');
    }
    releaseDatabase();
    releaseFile();
    await expect(page.getByText('Sample data ready', { exact: true })).toHaveCount(2);
    const database = page.locator('#tutorial-database');
    await expect(database.locator('.tutorial-artifact .code-example')).not.toBeVisible();
    await database.getByText('Sample location', { exact: true }).click();
    await expect(database.locator('.tutorial-artifact .code-example')).toContainText(
      calls.find((call) => call.action === 'seed').table,
    );
    if (process.env.EXPERIENCE_SCREENSHOTS)
      await page.screenshot({
        path: `${process.env.EXPERIENCE_SCREENSHOTS}/tutorials-${testInfo.project.name}.png`,
        animations: 'disabled',
      });
  } finally {
    releaseDatabase();
    releaseFile();
  }
});

test('empty resource workspaces lead directly to their focused tutorial and back to all tutorials', async ({
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
    .getByRole('link', { name: 'Continue tutorial', exact: true })
    .click();
  await expect(page.locator('#tutorial-filesystem')).toContainText(
    '/tutorial-orders-' + 'b'.repeat(32) + '.csv',
  );
  await expect(page.getByRole('button', { name: 'Save sample CSV', exact: true })).toBeDisabled();
  expect(workspace.tutorials.get('db_fixture').sampleId).toBe('c'.repeat(32));
  expect(workspace.tutorials.get('fs_fixture').state).toBe('attempted');
  expect(calls).toHaveLength(0);
});

test('file tutorial opens reusable notes and log samples without replacing edits', async ({
  page,
  context,
  workspace,
}, testInfo) => {
  workspace.addResources();
  workspace.state.resources.find((resource) => resource.id === 'fs_fixture').name = 'Project files';
  workspace.state.profile.name = 'Developer';
  const { calls } = await tutorialApi(context, workspace);
  await workspace.open('#tutorials?resourceId=fs_fixture');
  const tutorial = page.locator('#tutorial-filesystem');
  await tutorial.getByRole('button', { name: 'Save sample CSV' }).click();
  await expect(tutorial.getByText('Sample data ready')).toBeVisible();
  if (process.env.EXPERIENCE_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.EXPERIENCE_SCREENSHOTS}/file-tutorial-${testInfo.project.name}.png`,
      fullPage: true,
    });
  await tutorial.getByRole('button', { name: 'Open sample notes' }).click();
  await expect(page.getByRole('heading', { name: 'Project handoff' })).toBeVisible();
  const notes = workspace.state.files.find((file) => file.path.endsWith('-notes.md'));
  expect(notes).toBeTruthy();
  notes.content = '# My own handoff\n';
  await page.goto('/#tutorials?resourceId=fs_fixture');
  await tutorial.getByRole('button', { name: 'Open sample notes' }).click();
  await expect(page.getByRole('heading', { name: 'My own handoff' })).toBeVisible();
  expect(calls.filter((call) => call.action === 'file' && call.path === notes.path)).toHaveLength(
    1,
  );
  await page.goto('/#tutorials?resourceId=fs_fixture');
  await tutorial.getByRole('button', { name: 'Open sample log' }).click();
  await expect(page).toHaveURL(/activity.log.*view=analyze/);
  await page.getByRole('button', { name: 'Editor tools' }).click();
  await page.getByRole('menuitem', { name: 'Find errors' }).click();
  await page.getByRole('button', { name: 'Run command' }).click();
  await expect(page.getByText('2:2026-10-30T09:01:00Z ERROR APAC sync timed out')).toBeVisible();
  expect(
    workspace.state.files.some(
      (file) => file.path.endsWith('-activity.log') && file.content.includes('ERROR'),
    ),
  ).toBe(true);
});
