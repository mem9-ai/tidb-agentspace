import { expect, test } from './workspace-fixture.mjs';

async function accountMenu(page) {
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true, level: 1 }),
  ).toBeVisible();
  const open = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await open.isVisible()) await open.click();
  return page.locator('.sidebar-bottom a[href="#settings"]:visible');
}

test('@visual signed-in identity shows verified name and email instead of Workspace display profile', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.state.profile.name = 'Developer';
  const email = 'alex.long-account-name@example.org';
  workspace.signInAsAccount({ name: 'Alex Example', email });
  await page.goto('/#settings');
  const account = page
    .locator('.settings-panel')
    .filter({ has: page.getByRole('heading', { name: 'Personal account', exact: true }) });
  await expect(account).toContainText('Alex Example');
  await expect(account).toContainText(email);
  await expect(account.getByRole('textbox', { name: 'Workspace display name' })).toHaveValue(
    'Developer',
  );
  const menu = await accountMenu(page);
  await expect(menu).toContainText('Alex Example');
  await expect(menu).toContainText(email);
  await expect(menu).not.toContainText('Developer');
  expect(await menu.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('account-identity.png'), fullPage: true });
});

test('email-only and older account sessions use honest identity fallbacks', async ({
  page,
  workspace,
}) => {
  workspace.state.profile.name = 'Developer';
  workspace.signInAsAccount({ email: 'alex@example.org' });
  await page.goto('/#settings');
  let menu = await accountMenu(page);
  await expect(menu).toContainText('alex@example.org');
  await expect(menu).not.toContainText('Developer');
  workspace.signInAsAccount();
  await page.reload();
  menu = await accountMenu(page);
  await expect(menu).toContainText('TiDB Cloud account');
  await expect(menu).not.toContainText('Developer');
});
