import { test, expect } from './workspace-fixture.mjs';

test('@visual only a hidden DuckDB shows the database empty state', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.state.resources = [
    {
      id: 'db_hidden_duck',
      name: 'hidden-duckdb',
      kind: 'duckdb',
      region: 'aws-ap-southeast-1',
      regionId: 'region:local',
      provider: 'duckdb-drive9',
      status: 'active',
      createdAt: '2026-11-03T00:00:00.000Z',
    },
  ];
  await workspace.open('#databases');
  await expect(page.getByText('hidden-duckdb')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create database', exact: true })).toBeVisible();
  if (process.env.HIDDEN_DUCKDB_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.HIDDEN_DUCKDB_SCREENSHOTS}/${testInfo.project.name}.png`,
      animations: 'disabled',
    });
});

test('standalone DuckDB is hidden from collections and direct navigation', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  workspace.state.resources.push({
    id: 'db_hidden_duck',
    name: 'hidden-duckdb',
    kind: 'duckdb',
    region: 'aws-ap-southeast-1',
    regionId: 'region:local',
    provider: 'duckdb-drive9',
    status: 'active',
    createdAt: '2026-11-03T00:00:00.000Z',
  });
  await workspace.open('#overview');
  await expect(page.getByText('hidden-duckdb')).toHaveCount(0);
  await page.goto('/#databases');
  await expect(page.getByRole('link', { name: 'hidden-duckdb' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'postgresql-fixture', exact: true })).toBeVisible();
  await page.goto('/#databases/db_hidden_duck/sql');
  await expect(page.getByText('Database unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run query', exact: true })).toHaveCount(0);
  expect(
    workspace.requests.some((request) => request.path.includes('/db_hidden_duck/tables')),
  ).toBe(false);
  expect(workspace.state.resources.some((resource) => resource.id === 'db_hidden_duck')).toBe(true);
});

test('retired MySQL is hidden and cannot be opened by a direct link', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  workspace.state.resources.push({
    id: 'db_retired_mysql',
    name: 'retired-mysql',
    kind: 'mysql',
    region: 'automatic',
    regionId: 'region:local',
    provider: 'tidb-cloud-zero',
    status: 'active',
    createdAt: '2026-11-03T00:00:00.000Z',
  });
  await workspace.open('#databases');
  await expect(page.getByText('retired-mysql')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'postgresql-fixture', exact: true })).toBeVisible();
  await page.goto('/#databases/db_retired_mysql/sql');
  await expect(page.getByText('Database unavailable', { exact: true })).toBeVisible();
  expect(
    workspace.requests.some((request) => request.path.includes('/db_retired_mysql/tables')),
  ).toBe(false);
  expect(workspace.state.resources.some((resource) => resource.id === 'db_retired_mysql')).toBe(
    true,
  );
});

test('a hidden DuckDB resolved outside the first page cannot be opened', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  workspace.setResourcePage('page-two', [
    {
      id: 'db_later_duck',
      name: 'later-duckdb',
      kind: 'duckdb',
      region: 'aws-ap-southeast-1',
      regionId: 'region:local',
      provider: 'duckdb-drive9',
      status: 'active',
      createdAt: '2026-11-03T00:00:00.000Z',
    },
  ]);
  workspace.state.resourceNextCursor = 'page-two';
  await workspace.open('#databases/db_later_duck/sql');
  await expect(page.getByText('Database unavailable', { exact: true })).toBeVisible();
  expect(
    workspace.requests.some((request) => request.path.endsWith('/resources/db_later_duck')),
  ).toBe(true);
  expect(workspace.requests.some((request) => request.path.includes('/db_later_duck/tables'))).toBe(
    false,
  );
});
