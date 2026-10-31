import { readFile } from 'node:fs/promises';
import { test, expect } from './workspace-fixture.mjs';

test('cloud sign-in offers TiDB Account and clearly marks Guest access unavailable', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  const account = page.getByRole('button', { name: 'Continue with TiDB Account' });
  const guest = page.getByRole('button', { name: 'Continue as Guest' });
  await expect(account).toBeEnabled();
  await expect(guest).toBeDisabled();
  await expect(page.getByText('24-hour Guest access is coming soon.')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await account.click();
  await expect(page).toHaveURL(/\/api\/auth\/tidbcloud\/login$/);
});

test('Guest sign-in opens the Workspace when the server enables it', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  const guest = page.getByRole('button', { name: 'Continue as Guest' });
  await expect(guest).toBeEnabled();
  await expect(guest.getByText('Workspace access expires after 24 hours')).toBeVisible();
  await expect(guest).toHaveAccessibleDescription('Workspace access expires after 24 hours');
  if (process.env.GUEST_SIGNIN_SCREENSHOT)
    await page.screenshot({ path: process.env.GUEST_SIGNIN_SCREENSHOT });
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
      expect.objectContaining({ path: '/api/v1/workspaces', method: 'GET' }),
    ]),
  );
});

test('Guest can cancel or confirm sign-out from the workspace navigation', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await expect(page.getByRole('heading', { name: 'Start with your data' })).toBeVisible();

  async function openSignOut() {
    const openNavigation = page.getByRole('button', { name: 'Open navigation' });
    if (await openNavigation.isVisible()) await openNavigation.click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    return page.getByRole('dialog', { name: 'Sign out of Guest?' });
  }
  let dialog = await openSignOut();
  await expect(dialog.getByText(/won’t be able to reopen it in this browser/)).toBeVisible();
  if (process.env.GUEST_LOGOUT_SCREENSHOT)
    await page.screenshot({ path: process.env.GUEST_LOGOUT_SCREENSHOT });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(workspace.requests.some((request) => request.path.endsWith('/logout'))).toBe(false);

  dialog = await openSignOut();
  await dialog.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  expect(workspace.requests.filter((request) => request.path.endsWith('/logout'))).toHaveLength(1);
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

test('contextual creation fills the matching name, restores focus and keeps readable controls', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  workspace.state.resources = workspace.state.resources.filter((r) => r.kind === 'filesystem');
  await workspace.open();
  expect(workspace.requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: '/api/v1/workspaces', method: 'GET' }),
      expect.objectContaining({
        path: `/api/v1/workspaces/${workspace.state.workspace.id}/bootstrap`,
        method: 'GET',
      }),
    ]),
  );
  for (const [label, kind] of [
    ['MySQL', 'mysql'],
    ['PostgreSQL', 'postgresql'],
    ['DuckDB', 'duckdb'],
  ]) {
    const trigger = page.getByRole('button', { name: `Create ${label}`, exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveAccessibleName(`Create a ${label} database`);
    await expect(dialog.getByRole('combobox', { name: 'Resource type' })).toHaveCount(0);
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
    expiresInDays: 7,
  });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(secret).toHaveCount(0);
  await expect(page.getByRole('cell', { name: /^file-reader/ })).toBeVisible();
});

test('File System opens its collection; Markdown preview, draft protection and original download work inline', async ({
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
