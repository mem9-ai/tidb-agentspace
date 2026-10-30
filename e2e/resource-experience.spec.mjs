import { test, expect } from './workspace-fixture.mjs';

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

test('empty collections share one in-context create action and readable TiUI presentation', async ({
  page,
  workspace,
}) => {
  const presentations = [];
  for (const collection of collections) {
    await workspace.open(collection.hash);
    await expect(
      page.getByRole('heading', { level: 1, name: collection.title, exact: true }),
    ).toBeVisible();
    const empty = page.getByRole('region', { name: collection.empty, exact: true });
    const create = empty.getByRole('button', { name: collection.create, exact: true });
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
