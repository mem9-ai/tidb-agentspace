import { test, expect } from './workspace-fixture.mjs';

async function expireAccessSession(page) {
  await page.route('**/api/global/api/auth/session?*', (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: 'UNAUTHENTICATED', message: 'Sign in' } },
    }),
  );
  await page.route('**/api/global/api/auth/config', (route) =>
    route.fulfill({ json: { mode: 'hosted' } }),
  );
}

test('@visual an expired access session offers sign-in without losing regional work', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.addResources();
  workspace.state.resources[0].name = 'Sales database';
  workspace.state.resources[1].name = 'Research files';
  workspace.signInAsAccount();
  await expireAccessSession(page);
  await workspace.open('#keys');
  await expect(page.getByRole('heading', { name: 'Sign in again to manage access' })).toBeVisible();
  await expect(page.getByText('0 active')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create API key' })).toHaveCount(0);
  await expect(
    page.getByText('Your files and databases are still available.', { exact: false }),
  ).toBeVisible();
  if (process.env.ACCESS_SESSION_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.ACCESS_SESSION_SCREENSHOTS}/access-${testInfo.project.name}.png`,
      fullPage: true,
    });
  // Re-entry through a named resource still uses its existing regional session.
  await page.goto('/#overview');
  await page
    .getByRole('region', { name: 'Your resources' })
    .getByRole('link', { name: 'Research files' })
    .click();
  await expect(page.getByRole('combobox', { name: 'File system', exact: true })).toHaveValue(
    'fs_fixture',
  );
  await page.goto('/#keys');
  await expect(page.getByRole('button', { name: 'Sign in again', exact: true })).toBeVisible();
  let login;
  await page.route('**/api/global/api/auth/tidbcloud/login?*', (route) => {
    login = new URL(route.request().url());
    return route.fulfill({ contentType: 'text/html', body: '<p>Sign-in requested</p>' });
  });
  await page.getByRole('button', { name: 'Sign in again', exact: true }).click();
  await expect(page.getByText('Sign-in requested', { exact: true })).toBeVisible();
  expect(login.searchParams.get('workspaceId')).toBe(workspace.state.workspace.id);
  expect(login.searchParams.get('returnTo')).toBe('http://127.0.0.1:4389/#keys');
  expect(
    workspace.requests.filter(
      ({ method, path }) => method !== 'GET' && /\/(?:keys|session)$/.test(path),
    ),
  ).toHaveLength(0);
});

test('@visual agent key creation recovers authentication without creating or broadening a key', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.addResources();
  workspace.state.resources[0].name = 'Sales database';
  workspace.state.resources[1].name = 'Research files';
  workspace.signInAsAccount();
  await expireAccessSession(page);
  await workspace.open('#connect');
  await page.getByRole('button', { name: 'Create API key' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create API key' });
  await dialog.getByRole('textbox', { name: 'Key name' }).fill('Research assistant');
  await dialog.getByRole('checkbox', { name: 'Research files', exact: true }).check();
  await dialog.getByRole('checkbox', { name: /files:read/ }).check();
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Sign in again', exact: true })).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText('Sign in again to manage access.');
  await expect(dialog.getByRole('textbox', { name: 'Key name' })).toHaveValue('Research assistant');
  await expect(dialog.getByRole('checkbox', { name: /files:read/ })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /files:write/ })).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Create key', exact: true })).toBeDisabled();
  expect(workspace.state.keys).toHaveLength(0);
  expect(
    workspace.requests.filter(({ method, path }) => method === 'POST' && path.endsWith('/keys')),
  ).toHaveLength(0);
  if (process.env.ACCESS_SESSION_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.ACCESS_SESSION_SCREENSHOTS}/create-${testInfo.project.name}.png`,
      fullPage: true,
    });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
});

for (const status of [403, 503]) {
  test(`a ${status} access-session failure does not trigger sign-in or local session creation`, async ({
    page,
    workspace,
  }) => {
    workspace.addResources();
    await page.route('**/api/global/api/auth/session?*', (route) =>
      route.fulfill({ status, json: { error: { code: 'UNAVAILABLE', message: 'Unavailable' } } }),
    );
    let configChecks = 0;
    await page.route('**/api/global/api/auth/config', (route) => {
      configChecks++;
      return route.fulfill({ json: { mode: 'local' } });
    });
    await workspace.open('#keys');
    await expect(page.getByRole('heading', { name: 'Unable to load API keys' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in again' })).toHaveCount(0);
    expect(configChecks).toBe(0);
  });
}

test('an explicitly local profile retains its existing session bootstrap on a 401', async ({
  page,
  workspace,
}) => {
  let created = 0;
  await page.route('**/api/global/api/auth/session?*', (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: 'UNAUTHENTICATED', message: 'Sign in' } },
    }),
  );
  await page.route('**/api/global/api/auth/config', (route) =>
    route.fulfill({ json: { mode: 'local' } }),
  );
  await page.route('**/api/global/api/session', (route) => {
    expect(route.request().method()).toBe('POST');
    created++;
    return route.fulfill({ json: { workspaceId: workspace.state.workspace.id } });
  });
  await workspace.open('#keys');
  await expect(page.getByRole('button', { name: 'Create API key' })).toBeVisible();
  expect(created).toBe(1);
});
