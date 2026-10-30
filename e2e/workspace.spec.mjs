import { readFile } from 'node:fs/promises';
import { test, expect } from './workspace-fixture.mjs';

test('contextual creation fills the matching name, restores focus and keeps readable controls', async ({
  page,
  workspace,
}) => {
  await workspace.open();
  for (const [label, kind] of [
    ['MySQL', 'mysql'],
    ['PostgreSQL', 'postgresql'],
    ['DuckDB', 'duckdb'],
    ['File System', 'filesystem'],
  ]) {
    const trigger = page.getByRole('button', { name: `Create ${label}`, exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveAccessibleName(
      kind === 'filesystem' ? 'Create a File System' : `Create a ${label} database`,
    );
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
  await expect(page).toHaveURL(/#files\?resourceId=fixture_filesystem_0$/);
  expect(creates()).toHaveLength(2);
  expect(creates()[1].body).toMatchObject({ kind: 'filesystem', region: 'aws-ap-southeast-1' });
});

test('Key creation sends explicit resource/action grants and reveals its synthetic secret once', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  await workspace.open('#keys');
  await page
    .locator('.page-heading')
    .getByRole('button', { name: 'Create API key', exact: true })
    .click();
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
