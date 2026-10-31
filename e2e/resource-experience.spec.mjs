import { test, expect, sampleResources } from './workspace-fixture.mjs';

const collections = [
  {
    hash: '#databases',
    title: 'Databases',
    table: 'Databases',
    create: 'Create database',
    dialog: 'Create a database',
    empty: 'Databases empty state',
    id: 'db_fixture',
  },
  {
    hash: '#files',
    title: 'File Systems',
    table: 'File systems',
    create: 'Create file system',
    dialog: 'Create a File System',
    empty: 'File Systems empty state',
    id: 'fs_fixture',
  },
];

test('resource pages distinguish unloaded collections and resolve deep links', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.state.resources = [structuredClone(sampleResources[0])];
  workspace.state.resourceNextCursor = 'page-two';
  workspace.setResourcePage('page-two', [structuredClone(sampleResources[1])]);
  await workspace.open('#files');
  await expect(
    page.getByText('No File Systems in the loaded resources. Load more to continue.'),
  ).toBeVisible();
  if (process.env.QUICKSTART_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.QUICKSTART_SCREENSHOTS}/pagination-${testInfo.project.name}.png`,
      fullPage: true,
    });
  await expect(page.getByRole('region', { name: 'File Systems empty state' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more resources' }).click();
  await expect(
    page.getByRole('table', { name: 'File systems' }).getByText('filesystem-fixture'),
  ).toBeVisible();
  expect(workspace.requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: `/api/v1/workspaces/${workspace.state.workspace.id}/resources`,
        query: expect.objectContaining({ cursor: 'page-two', limit: '100' }),
      }),
    ]),
  );
  const beforeSelection = workspace.requests.length;
  await workspace.open('#files?resourceId=fs_fixture');
  await expect
    .poll(() =>
      workspace.requests
        .slice(beforeSelection)
        .some((request) => request.path.endsWith('/resources/fs_fixture')),
    )
    .toBe(true);
  const beforeReload = workspace.requests.length;
  await page.reload();
  await expect(page.getByText('File System unavailable')).toHaveCount(0);
  await expect
    .poll(() =>
      workspace.requests
        .slice(beforeReload)
        .some((request) => request.path.endsWith('/resources/fs_fixture')),
    )
    .toBe(true);
});

test('a directly linked database outside the first page keeps query results after refresh', async ({
  page,
  workspace,
}) => {
  workspace.state.resources = [structuredClone(sampleResources[1])];
  workspace.state.resourceNextCursor = 'page-two';
  workspace.setResourcePage('page-two', [structuredClone(sampleResources[0])]);
  await workspace.open('#databases/db_fixture/sql');
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(page.getByText('agent_started', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#databases\/db_fixture\/sql$/);
});

test('a directly linked local File System loads its own files outside the first page', async ({
  page,
  workspace,
}) => {
  workspace.state.resources = [structuredClone(sampleResources[0])];
  workspace.state.resourceNextCursor = 'page-two';
  workspace.setResourcePage('page-two', [structuredClone(sampleResources[1])]);
  workspace.state.files = [
    {
      id: 'file-off-page',
      resourceId: 'fs_fixture',
      path: '/outside.txt',
      type: 'file',
      content: 'preserved',
      size: 9,
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ];
  await workspace.open('#files?resourceId=fs_fixture');
  await expect(
    page.getByRole('navigation', { name: 'File entries' }).getByText('outside.txt'),
  ).toBeVisible();
  await expect
    .poll(() =>
      workspace.requests.some(
        (request) => request.path.endsWith('/files') && request.query.resourceId === 'fs_fixture',
      ),
    )
    .toBe(true);
});

test('resource windows stay bounded and disclose selections from earlier pages', async ({
  page,
  workspace,
}, testInfo) => {
  test.setTimeout(60000);
  const resources = Array.from({ length: 600 }, (_, index) => ({
    ...structuredClone(sampleResources[0]),
    id: `db_window_${String(index).padStart(4, '0')}`,
    name: `window-database-${String(index).padStart(4, '0')}`,
  }));
  workspace.state.resources = resources.slice(0, 100);
  workspace.state.resourceNextCursor = 'window-1';
  for (let pageNumber = 1; pageNumber <= 5; pageNumber++) {
    workspace.setResourcePage(
      `window-${pageNumber}`,
      resources.slice(pageNumber * 100, (pageNumber + 1) * 100),
      pageNumber < 5 ? `window-${pageNumber + 1}` : null,
    );
  }
  await workspace.open('#keys');
  await page.getByRole('button', { name: 'Create API key', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create API key', exact: true });
  for (let pageNumber = 0; pageNumber < 5; pageNumber++)
    await dialog.getByRole('button', { name: 'Load more resources' }).click();
  await expect(dialog.getByRole('checkbox', { name: 'window-database-0000' })).toHaveCount(0);
  await expect(dialog.getByRole('checkbox', { name: 'window-database-0599' })).toBeVisible();
  await expect(
    dialog.getByText('100 selected resources are outside the loaded window.'),
  ).toBeVisible();
  if (process.env.SCALE_SCREENSHOTS) {
    await dialog
      .getByText('100 selected resources are outside the loaded window.')
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${process.env.SCALE_SCREENSHOTS}/resource-window-${testInfo.project.name}.png`,
    });
  }
  await dialog.getByRole('button', { name: 'Back to first resources' }).click();
  await expect(dialog.getByRole('checkbox', { name: 'window-database-0000' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('Key inventory pages keep a bounded window with a route back to the first page', async ({
  page,
  workspace,
}) => {
  test.setTimeout(60000);
  const keys = Array.from({ length: 600 }, (_, index) => ({
    id: `key_window_${String(index).padStart(4, '0')}`,
    name: `window-key-${String(index).padStart(4, '0')}`,
    prefix: 'fixture',
    scopes: ['resources:read'],
    resourceIds: ['*'],
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    lastUsedAt: null,
    revokedAt: null,
  }));
  workspace.state.keys = keys.slice(0, 100);
  workspace.state.keysNextCursor = 'keys-1';
  for (let pageNumber = 1; pageNumber <= 5; pageNumber++)
    workspace.setKeyPage(
      `keys-${pageNumber}`,
      keys.slice(pageNumber * 100, (pageNumber + 1) * 100),
      pageNumber < 5 ? `keys-${pageNumber + 1}` : null,
    );
  await workspace.open('#keys');
  for (let pageNumber = 0; pageNumber < 5; pageNumber++)
    await page.getByRole('button', { name: 'Load more keys' }).click();
  await expect(page.getByText('window-key-0000', { exact: true })).toHaveCount(0);
  await expect(page.getByText('window-key-0599', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to first keys' }).click();
  await expect(page.getByText('window-key-0000', { exact: true })).toBeVisible();
});

test('empty collections share one in-context create action and readable TiUI presentation', async ({
  page,
  workspace,
}, testInfo) => {
  const presentations = [];
  for (const collection of collections) {
    await workspace.open(collection.hash);
    await expect(
      page.getByRole('heading', { level: 1, name: collection.title, exact: true }),
    ).toBeVisible();
    const empty = page.getByRole('region', { name: collection.empty, exact: true });
    const create = empty.getByRole('button', { name: collection.create, exact: true });
    if (process.env.QUICKSTART_SCREENSHOTS)
      await page.screenshot({
        path: `${process.env.QUICKSTART_SCREENSHOTS}/${collection.hash.slice(1)}-${testInfo.project.name}.png`,
        fullPage: true,
      });
    await page.getByRole('heading', { level: 1, name: collection.title, exact: true }).hover();
    if (presentations.length)
      await expect(create).toHaveCSS('background-color', presentations[0].background);
    await expect(page.getByRole('button', { name: collection.create, exact: true })).toHaveCount(1);
    await expect(create).toHaveCSS('height', '48px');
    await expect(create).toHaveCSS('font-size', '16px');
    presentations.push(
      await empty.evaluate((element) => {
        const state = getComputedStyle(element);
        const action = getComputedStyle(element.querySelector('button'));
        return {
          padding: state.padding,
          gap: state.gap,
          align: state.alignItems,
          background: action.backgroundColor,
          radius: action.borderRadius,
          font: action.fontSize,
        };
      }),
    );
    await create.click();
    await expect(page.getByRole('dialog')).toHaveAccessibleName(collection.dialog);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).press('Escape');
    await expect(create).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
  }
  expect(presentations[0]).toEqual(presentations[1]);
  await workspace.open('#overview');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Start with your data', exact: true }),
  ).toBeVisible();
  const startingChoices = page.getByRole('region', { name: 'Get started', exact: true });
  if (process.env.QUICKSTART_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.QUICKSTART_SCREENSHOTS}/overview-${testInfo.project.name}.png`,
      fullPage: true,
    });
  await expect(startingChoices.getByRole('button')).toHaveCount(2);
  for (const collection of collections) {
    const create = startingChoices.getByRole('button', { name: collection.create, exact: true });
    await create.click();
    const dialog = page.getByRole('dialog', { name: collection.dialog, exact: true });
    await expect(dialog).toBeVisible();
    const kind = dialog.getByRole('combobox', { name: 'Resource type', exact: true });
    if (collection.hash === '#databases') {
      expect(
        await kind
          .locator('option')
          .evaluateAll((options) => options.map((option) => option.value)),
      ).toEqual(['mysql', 'postgresql', 'duckdb']);
    } else {
      await expect(kind).toHaveCount(0);
    }
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(create).toBeFocused();
  }
  await expect(page.getByRole('heading', { name: 'Workspace activity', exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator('.resource-card .live-dot')).toHaveCount(0);
  await expect(page.locator('.resource-card a.resource-name')).toHaveCount(0);
});

test('each Quick Start appears only while its resource type is missing', async ({
  page,
  workspace,
}) => {
  for (const [existingKind, remaining, absent] of [
    ['mysql', 'Create file system', 'Create database'],
    ['filesystem', 'Create database', 'Create file system'],
  ]) {
    workspace.state.resources = structuredClone(
      sampleResources.filter((resource) => resource.kind === existingKind),
    );
    await workspace.open('#overview');
    await page.reload();
    const guide = page.getByRole('region', { name: 'Get started' });
    await expect(guide.getByRole('button', { name: remaining, exact: true })).toBeVisible();
    await expect(guide.getByRole('button', { name: absent, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: remaining, exact: true })).toHaveCount(1);
  }
});

test('Quick Start creates a database and reaches a first query result', async ({
  page,
  workspace,
}) => {
  await workspace.open('#overview');
  const guide = page.getByRole('region', { name: 'Get started' });
  await expect(guide.getByText('Run your first query')).toBeVisible();
  await guide.getByRole('button', { name: 'Create database', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a database' });
  await dialog.getByRole('button', { name: 'Create database', exact: true }).click();
  await expect(page).toHaveURL(/#databases\/fixture_mysql_0\/sql$/);
  const run = page.getByRole('button', { name: 'Run query', exact: true });
  await expect(run).toBeEnabled();
  expect(workspace.requests.filter((request) => request.path.endsWith('/queries'))).toHaveLength(0);
  await run.click();
  await expect(page.getByText('agent_started', { exact: true })).toBeVisible();
  expect(workspace.requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: `/api/v1/workspaces/${workspace.state.workspace.id}/queries`,
        method: 'POST',
        body: expect.objectContaining({ resourceId: 'fixture_mysql_0' }),
      }),
    ]),
  );
});

test('Guest sees expiry and File System Quick Start before creating a resource', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const guide = page.getByRole('region', { name: 'Get started' });
  await expect(guide.getByText(/Your Guest Workspace expires 24 hours/)).toBeVisible();
  await expect(guide.getByText('Add a file', { exact: true })).toBeVisible();
  await page.goto('/#files');
  const empty = page.getByRole('region', { name: 'File Systems empty state' });
  await expect(empty.getByText(/Your Guest Workspace expires 24 hours/)).toBeVisible();
  await expect(empty.getByText('Preview and explore', { exact: true })).toBeVisible();
  await empty.getByRole('button', { name: 'Create file system' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a File System' });
  await dialog.getByRole('button', { name: 'Create file system', exact: true }).click();
  await expect(page).toHaveURL(/#files\?resourceId=fixture_filesystem_0$/);
  await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeVisible();
  expect(
    workspace.requests.some(
      (request) => request.path.endsWith('/resources') && request.body?.kind === 'filesystem',
    ),
  ).toBe(true);
});

test('populated collections share metadata, exact-resource entry, connection and return actions', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  workspace.state.resources[0].name = 'mysql-resource-with-a-long-name-for-agents';
  workspace.state.resources[1].name = 'filesystem-resource-with-a-long-name-1234';
  for (const collection of collections) {
    const resource = workspace.state.resources.find((item) => item.id === collection.id);
    await workspace.open(collection.hash);
    const table = page.getByRole('table', { name: collection.table, exact: true });
    await expect(table.getByRole('columnheader')).toHaveText([
      'Name',
      'Region',
      'Status',
      'Service',
      'Actions',
    ]);
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table.getByText('Local demo', { exact: true })).toBeVisible();
    for (const text of ['active', 'Local demo']) {
      const label = table.getByText(text, { exact: true });
      await expect
        .poll(() => label.evaluate((element) => element.scrollWidth <= element.clientWidth))
        .toBe(true);
    }
    await table.getByRole('link', { name: `Open ${resource.name}`, exact: true }).click();
    await expect(page).toHaveURL(
      collection.id === 'db_fixture'
        ? /#databases\/db_fixture\/sql$/
        : /#files\?resourceId=fs_fixture$/,
    );
    const back = page.getByRole('button', {
      name: collection.id === 'db_fixture' ? 'All databases' : 'All file systems',
      exact: true,
    });
    await expect(back).toBeVisible();
    await expect(back).toBeEnabled();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await back.click();
    await expect(page).toHaveURL(new RegExp(`${collection.hash}$`));
    await expect(table).toBeVisible();
    await table.getByRole('button', { name: `Connect to ${resource.name}`, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveAccessibleName(`Connect to ${resource.name}`);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).press('Escape');
  }
  expect(
    workspace.requests.filter(
      (request) => request.method === 'POST' && /\/(?:resources|queries)$/.test(request.path),
    ),
  ).toEqual([]);
});

test('Overview named resources open their exact workspaces without an intermediate collection', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  for (const resource of workspace.state.resources) {
    await workspace.open('#overview');
    const entry = page.getByRole('link', { name: resource.name, exact: true });
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(page).toHaveURL(
      resource.kind === 'filesystem'
        ? /#files\?resourceId=fs_fixture$/
        : /#databases\/db_fixture\/sql$/,
    );
  }
});

test('collections keep lifecycle failures, expiry and service context visible', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  Object.assign(workspace.state.resources[0], {
    provider: 'tidb-cloud-zero',
    status: 'expired',
    expiresAt: '2026-01-01T00:00:00Z',
    connectionError: 'Fixture database expired.',
  });
  Object.assign(workspace.state.resources[1], {
    provider: 'drive9-anonymous',
    status: 'failed',
    connectionError: 'Fixture file service unavailable.',
  });
  await workspace.open('#databases');
  const databases = page.getByRole('table', { name: 'Databases', exact: true });
  await expect(databases.getByText('expired', { exact: true })).toBeVisible();
  await expect(databases.getByText('Fixture database expired.', { exact: true })).toBeVisible();
  await expect(databases).toContainText('Expires');
  await expect(databases).toContainText('TiDB Cloud Zero · Trial');
  await workspace.open('#files');
  const files = page.getByRole('table', { name: 'File systems', exact: true });
  await expect(files.getByText('failed', { exact: true })).toBeVisible();
  await expect(files.getByText('Fixture file service unavailable.', { exact: true })).toBeVisible();
  await expect(files).toContainText('Drive9 · Anonymous trial');
  await workspace.open('#overview');
  await expect(page.locator('.resource-card').getByText('expired', { exact: true })).toBeVisible();
  await expect(page.locator('.resource-card').getByText('failed', { exact: true })).toBeVisible();
});

test('Connect opens scoped Key creation directly and the empty Keys page has one create action', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  await workspace.open('#connect');
  await page.getByRole('button', { name: 'Create API key', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create API key', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/#connect$/);
  await expect(
    dialog.getByRole('checkbox', { name: 'filesystem-fixture', exact: true }),
  ).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'mysql-fixture', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await workspace.open('#keys');
  await expect(page.getByRole('button', { name: 'Create API key', exact: true })).toHaveCount(1);
  expect(
    workspace.requests.filter(
      (request) => request.method === 'POST' && request.path.endsWith('/keys'),
    ),
  ).toEqual([]);
});
