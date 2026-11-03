import { readFile } from 'node:fs/promises';
import { test, expect } from './workspace-fixture.mjs';

test('@visual workspace settings and resource creation focus on customer choices', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.addResources();
  await workspace.open('#settings');
  await expect(page.getByLabel('Default region')).toHaveCount(0);
  await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
  await workspace.open('#databases');
  await page.getByRole('button', { name: /create database/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Workspace region')).toHaveCount(0);
  await expect(dialog.getByLabel('Provider data location')).toBeVisible();
  if (process.env.REGION_VISUAL_DIR)
    await page.screenshot({
      path: `${process.env.REGION_VISUAL_DIR}/${testInfo.project.name}.png`,
    });
});

test('cloud sign-in offers TiDB Account and clearly marks Guest access unavailable', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn();
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Give your agent a place to work' }),
  ).toBeVisible();
  const account = page.getByRole('button', { name: 'Continue with TiDB Account' });
  const guest = page.getByRole('button', { name: 'Continue as Guest' });
  await expect(account).toBeEnabled();
  await expect(guest).toBeDisabled();
  expect(await account.evaluate((element) => element.offsetTop)).toBeLessThan(
    await guest.evaluate((element) => element.offsetTop),
  );
  await expect(page.getByText('24-hour Guest access is coming soon.')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await account.click();
  await expect(page).toHaveURL(/\/api\/auth\/tidbcloud\/login$/);
});

test('@visual Guest sign-in opens the Workspace when the server enables it', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  const guest = page.getByRole('button', { name: 'Continue as Guest' });
  await expect(guest).toBeEnabled();
  const account = page.getByRole('button', { name: 'Continue with TiDB Account' });
  expect(await guest.evaluate((element) => element.offsetTop)).toBeLessThan(
    await account.evaluate((element) => element.offsetTop),
  );
  await expect(guest.getByText('Workspace access expires after 24 hours')).toBeVisible();
  const expiryColor = await guest
    .getByText('Workspace access expires after 24 hours')
    .evaluate((element) => getComputedStyle(element).color);
  expect(expiryColor).toBe(await guest.evaluate((element) => getComputedStyle(element).color));
  await expect(guest).toHaveAccessibleDescription('Workspace access expires after 24 hours');
  if (process.env.GUEST_SIGNIN_SCREENSHOT)
    await page.screenshot({
      path: `${process.env.GUEST_SIGNIN_SCREENSHOT}-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  await guest.getByText('Workspace access expires after 24 hours').click();
  await expect(page.getByRole('combobox', { name: 'Color theme', exact: true })).toBeVisible();
  await page.goto('/#settings');
  const settings = page.getByRole('main');
  await expect(settings.getByText('Guest session', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Your Guest workspace expires 24 hours after it was created.'),
  ).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Sign out' })).toBeVisible();
  if (process.env.GUEST_SETTINGS_SCREENSHOT) {
    await settings.getByText('Guest session', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.env.GUEST_SETTINGS_SCREENSHOT });
  }
  await settings.getByRole('button', { name: 'Sign out' }).click();
  await page
    .getByRole('dialog', { name: 'Sign out of Guest?' })
    .getByRole('button', {
      name: 'Cancel',
    })
    .click();
  expect(workspace.requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: '/api/auth/guest', method: 'POST' }),
      expect.objectContaining({ path: '/api/portal/v1/workspaces', method: 'GET' }),
    ]),
  );
});

test('Guest API key creation explains the Workspace expiry', async ({ page, workspace }) => {
  workspace.requireSignIn({ guestEnabled: true });
  workspace.addResources();
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await workspace.open('#keys');
  await page.getByRole('button', { name: 'Create API key', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create API key', exact: true });
  await expect(
    dialog.getByText(
      'This key expires within 24 hours, when you sign out, or when your Guest workspace expires.',
    ),
  ).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Expiration' })).toHaveCount(0);
  await dialog.getByLabel('Key name').fill('guest-agent');
  const start = Math.floor(Date.now() / 1000);
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Your key is ready' })).toBeVisible();
  const creation = workspace.requests.findLast(
    (request) => request.method === 'POST' && request.path.endsWith('/keys'),
  );
  expect(creation.body.expiresAt).toBeGreaterThanOrEqual(start + 86400);
  expect(creation.body.expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 86400);
});

test('@visual Guest can cancel or confirm sign-out from the workspace navigation', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await expect(
    page.getByRole('heading', { name: 'Give your agent a place to work' }),
  ).toBeVisible();

  async function openSignOut() {
    const openNavigation = page.getByRole('button', { name: 'Open navigation' });
    if (await openNavigation.isVisible()) await openNavigation.click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    return page.getByRole('dialog', { name: 'Sign out of Guest?' });
  }
  let dialog = await openSignOut();
  await expect(
    dialog.getByText(/won’t be able to reopen this session in this browser/),
  ).toBeVisible();
  if (process.env.GUEST_LOGOUT_SCREENSHOT)
    await page.screenshot({ path: process.env.GUEST_LOGOUT_SCREENSHOT });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    workspace.requests.filter((request) => request.path === '/api/auth/guest/logout'),
  ).toHaveLength(0);

  dialog = await openSignOut();
  workspace.rejectNextGuestLogout();
  await dialog.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Unable to finish Guest sign-out');
  await expect(dialog.getByRole('button', { name: 'Sign out', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue as Guest' })).toBeVisible();
  expect(
    workspace.requests.filter(
      (request) => request.path === '/api/auth/guest/logout' && request.method === 'POST',
    ),
  ).toHaveLength(2);
});

test('Guest sign-out is not offered until the backend supports cleanup', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true, guestCleanupEnabled: false });
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await page.goto('/#settings');
  await expect(page.getByRole('main').getByText('Guest session', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
});

test('@visual an empty personal account workspace is described accurately', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.signInAsAccount();
  await page.goto('/?code=redeemed-fixture&state=fixture-state&view=keep#settings');
  await expect(page).toHaveURL(/\?view=keep#settings$/);
  await expect(
    page.getByText('Signed in with your TiDB Account. This is your personal workspace.'),
  ).toBeVisible();
  await expect(
    page.getByText('Admitted accounts have owner access.', { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Product prototype · Cloud resources & telemetry are simulated'),
  ).toHaveCount(0);
  await expect(page.getByText('Create a resource to get started')).toBeVisible();
  if (process.env.PERSONAL_SETTINGS_SCREENSHOT) {
    await page.getByText('TiDB Account session', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${process.env.PERSONAL_SETTINGS_SCREENSHOT}-${testInfo.project.name}.png`,
    });
  }
});

async function openFileSystemsFromSidebar(page) {
  const mobileNavigation = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await mobileNavigation.isVisible()) await mobileNavigation.click();
  await page
    .getByRole('navigation', { name: 'Main navigation', exact: true })
    .getByRole('link', { name: 'File Systems', exact: true })
    .click();
}

for (const count of [0, 1, 2]) {
  test(`File System sidebar opens the collection with ${count} File Systems`, async ({
    page,
    workspace,
  }) => {
    workspace.addResources();
    const database = workspace.state.resources.find((resource) => resource.kind === 'mysql');
    const first = workspace.state.resources.find((resource) => resource.kind === 'filesystem');
    const systems = [first, { ...first, id: 'fs_second', name: 'second-filesystem' }];
    workspace.state.resources = [database, ...systems.slice(0, count)];
    await workspace.open('#databases');
    await openFileSystemsFromSidebar(page);
    await expect(page).toHaveURL(/#files$/);
    await expect(page.getByRole('heading', { name: 'File Systems', exact: true })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'File browser' })).toHaveCount(0);
    if (count === 0) {
      await expect(
        page.getByRole('heading', { name: 'Create your first File System' }),
      ).toBeVisible();
      await page.reload();
      await expect(page.getByRole('heading', { name: 'File Systems', exact: true })).toBeVisible();
      await expect(page).toHaveURL(/#files$/);
      return;
    }
    const collection = page.getByRole('table', { name: 'File systems' });
    await expect(collection.getByRole('row')).toHaveCount(count + 1);
    await page.reload();
    await expect(collection).toBeVisible();
    await expect(page).toHaveURL(/#files$/);
    await collection.getByRole('link', { name: first.name, exact: true }).click();
    await expect(page).toHaveURL(/#files\?resourceId=fs_fixture$/);
    await expect(page.getByRole('complementary', { name: 'File browser' })).toBeVisible();
    await openFileSystemsFromSidebar(page);
    await expect(page).toHaveURL(/#files$/);
    await expect(collection).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'File browser' })).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/#files\?resourceId=fs_fixture$/);
    await expect(page.getByRole('complementary', { name: 'File browser' })).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(/#files$/);
    await expect(collection).toBeVisible();
    await workspace.open('#files?resourceId=removed-system&path=%2Fservice.log&view=analyze');
    await expect(
      page.getByRole('heading', { name: 'File System unavailable', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'File browser' })).toHaveCount(0);
    await page.getByRole('button', { name: 'All file systems', exact: true }).click();
    await expect(page).toHaveURL(/#files$/);
    await expect(page.getByRole('table', { name: 'File systems' }).getByRole('row')).toHaveCount(
      count + 1,
    );
  });
}

test('@visual database creation selects each type, generates a matching name and restores focus', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  workspace.state.resources = workspace.state.resources.filter((r) => r.kind === 'filesystem');
  await workspace.open();
  expect(workspace.requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: '/api/portal/v1/workspaces', method: 'GET' }),
      expect.objectContaining({
        path: `/api/portal/v1/workspaces/${workspace.state.workspace.id}/bootstrap`,
        method: 'GET',
      }),
    ]),
  );
  await workspace.open('#databases');
  for (const kind of ['mysql', 'postgresql', 'duckdb']) {
    const trigger = page.getByRole('button', { name: 'Create database', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveAccessibleName('Create a database');
    await dialog.getByRole('combobox', { name: 'Resource type' }).selectOption(kind);
    const name = dialog.getByRole('textbox', { name: 'Resource name', exact: true });
    await expect(name).toHaveValue(new RegExp(`^${kind}-[a-f0-9]{16}$`));
    await expect(name).toHaveCSS('font-size', '16px');
    await expect(name).toHaveCSS('height', '48px');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await dialog.getByRole('button', { name: 'Close dialog' }).press('Escape');
    await expect(trigger).toBeFocused();
  }
});

for (const kind of ['filesystem', 'duckdb']) {
  test(`@visual ${kind} creation uses the configured default location and keeps it in Details`, async ({
    page,
    workspace,
  }, testInfo) => {
    workspace.state.capabilities[kind].regions = ['aws-us-east-1', 'aws-ap-southeast-1'];
    await workspace.open(kind === 'filesystem' ? '#files' : '#databases');
    await page
      .getByRole('button', {
        name: kind === 'filesystem' ? 'Create file system' : 'Create database',
        exact: true,
      })
      .click();
    const dialog = page.getByRole('dialog');
    if (kind === 'duckdb')
      await dialog.getByRole('combobox', { name: 'Resource type' }).selectOption(kind);
    await expect(dialog.getByLabel('Provider data location')).toHaveCount(0);
    await expect(dialog.getByText('AWS · Singapore')).toHaveCount(0);
    if (kind === 'duckdb') {
      const badge = dialog.getByText('Experimental', { exact: true });
      await expect(badge).toBeVisible();
      await expect
        .poll(() => badge.evaluate((element) => element.scrollWidth <= element.clientWidth))
        .toBe(true);
    }
    if (process.env.DEFAULT_LOCATION_SCREENSHOT) {
      await page.screenshot({
        path: `${process.env.DEFAULT_LOCATION_SCREENSHOT}-${kind}-${testInfo.project.name}.png`,
        animations: 'disabled',
      });
    }
    await dialog
      .getByRole('button', {
        name: kind === 'filesystem' ? 'Create file system' : 'Create database',
        exact: true,
      })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(
      workspace.requests.find(
        (request) => request.path.endsWith('/resources') && request.method === 'POST',
      ).body,
    ).toMatchObject({ kind, region: 'aws-us-east-1' });
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(page.getByText('Provider data location: AWS · N. Virginia')).toBeVisible();
  });
}

test('automatic type changes preserve manual names; a conflict requires an explicit retry', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  workspace.state.resources = workspace.state.resources.filter((r) => r.kind !== 'filesystem');
  workspace.state.files = [];
  await workspace.open();
  await page.getByRole('button', { name: 'Create resource', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const kind = dialog.getByRole('combobox', { name: 'Resource type' });
  const name = dialog.getByRole('textbox', { name: 'Resource name', exact: true });
  await kind.selectOption('postgresql');
  await expect(name).toHaveValue(/^postgresql-/);
  await name.fill('my-custom-name');
  await kind.selectOption('duckdb');
  await expect(name).toHaveValue('my-custom-name');
  await name.fill('');
  await kind.selectOption('filesystem');
  await expect(name).toHaveValue(/^filesystem-/);
  await name.fill('');
  workspace.rejectNextName();
  await dialog.getByRole('button', { name: 'Create file system', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('A new name is ready');
  const creates = () =>
    workspace.requests.filter((r) => r.path.endsWith('/resources') && r.method === 'POST');
  expect(creates()).toHaveLength(1);
  await expect(name).toHaveValue(/^filesystem-/);
  expect(await name.inputValue()).not.toBe(creates()[0].body.name);
  await dialog.getByRole('button', { name: 'Create file system', exact: true }).click();
  await expect(page).toHaveURL(/#files\?resourceId=fixture_filesystem_1$/);
  expect(creates()).toHaveLength(2);
  expect(creates()[1].body).toMatchObject({ kind: 'filesystem', region: 'aws-ap-southeast-1' });
});

test('unavailable API keys show a recoverable error instead of an empty list or sign-in', async ({
  page,
  workspace,
}) => {
  workspace.state.globalApiUnavailable = true;
  await workspace.open('#keys');
  await expect(page.getByRole('heading', { name: 'Unable to load API keys' })).toBeVisible();
  await expect(page.getByText('0 active')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create API key' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await expect(page.getByText('Global API is not configured', { exact: false })).toHaveCount(0);
  if (process.env.API_KEYS_ERROR_SCREENSHOT)
    await page.screenshot({ path: process.env.API_KEYS_ERROR_SCREENSHOT });

  workspace.state.globalApiUnavailable = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: 'Create API key' })).toBeVisible();
  await expect(page.getByText('0 active')).toBeVisible();
});

test('Key creation sends explicit resource/action grants and reveals its synthetic secret once', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  await workspace.open('#keys');
  await page.getByRole('button', { name: 'Create API key', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create API key', exact: true });
  await dialog.getByRole('textbox', { name: 'Key name' }).fill('file-reader');
  await dialog.getByRole('checkbox', { name: 'mysql-fixture', exact: true }).uncheck();
  await expect(dialog.getByRole('checkbox', { name: /resources:write/ })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /usage:read/ }).uncheck();
  await dialog.getByRole('combobox', { name: 'Expiration' }).selectOption('7');
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Your key is ready' })).toBeVisible();
  const secret = page.getByText('synthetic-browser-key-never-valid-on-a-provider', { exact: true });
  await expect(secret).toBeVisible();
  expect(
    workspace.requests.find((r) => r.path.endsWith('/keys') && r.method === 'POST').body,
  ).toEqual({
    name: 'file-reader',
    scopes: ['resources:read', 'files:read'],
    resourceIds: ['fs_fixture'],
    expiresAt: expect.any(Number),
  });
  const issued = workspace.requests.find((r) => r.path.endsWith('/keys') && r.method === 'POST');
  expect(issued.path).toContain('/api/global/api/');
  expect(issued.body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 6 * 86400);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(secret).toHaveCount(0);
  await expect(page.getByRole('cell', { name: /^file-reader/ })).toBeVisible();
});

test('@visual an agent Key can be limited to read-only SQL on a selected database', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.addResources();
  await workspace.open('#keys');
  await page.getByRole('button', { name: 'Create API key', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create API key', exact: true });
  await dialog.getByRole('textbox', { name: 'Key name' }).fill('database-reader');
  await dialog.getByRole('checkbox', { name: 'filesystem-fixture', exact: true }).uncheck();
  await dialog.getByRole('checkbox', { name: /files:read/ }).uncheck();
  await dialog.getByRole('checkbox', { name: /usage:read/ }).uncheck();
  await dialog.getByRole('checkbox', { name: /queries:read/ }).check();
  await expect(dialog.getByRole('checkbox', { name: /queries:execute/ })).not.toBeChecked();
  if (process.env.KEY_READ_SCREENSHOT) {
    await page.screenshot({
      path: `${process.env.KEY_READ_SCREENSHOT}-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  }
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Your key is ready' })).toBeVisible();
  expect(
    workspace.requests.find((r) => r.path.endsWith('/keys') && r.method === 'POST').body,
  ).toMatchObject({
    name: 'database-reader',
    scopes: ['resources:read', 'queries:read'],
    resourceIds: ['db_fixture'],
  });
});

test('@visual File System opens its collection; Markdown preview, draft protection and original download work inline', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  await workspace.open('#files');
  await expect(page.getByRole('table', { name: 'File systems' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'File browser' })).toHaveCount(0);
  await page.getByRole('link', { name: 'filesystem-fixture', exact: true }).click();
  await page.getByRole('button', { name: /^README\.md/ }).click();
  await expect(page.getByRole('heading', { name: 'Fixture file', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/resourceId=fs_fixture&path=%2FREADME.md&view=preview/);
  await page.getByRole('button', { name: 'Edit source', exact: true }).click();
  await page.getByRole('textbox', { name: 'File content', exact: true }).fill('Unsaved draft');
  await openFileSystemsFromSidebar(page);
  await expect(page.getByRole('alert', { name: 'Keep your changes?', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'File content', exact: true })).toHaveValue(
    'Unsaved draft',
  );
  await page.getByRole('button', { name: 'Close file preview', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Keep your changes?', exact: true })).toContainText(
    'This file has unsaved changes',
  );
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'File content', exact: true })).toHaveValue(
    'Unsaved draft',
  );
  await page.getByRole('button', { name: 'Close file preview', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page).toHaveURL(/#files\?resourceId=fs_fixture$/);
  await page.getByRole('button', { name: /^README\.md/ }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).filter({ visible: true }).click();
  const exporting = page.getByRole('dialog', { name: 'Export original file', exact: true });
  await expect(exporting).toBeVisible();
  const download = page.waitForEvent('download');
  await exporting.getByRole('button', { name: 'Download original', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('README.md');
  expect(await readFile(await file.path(), 'utf8')).toBe(workspace.state.files[0].content);
});
