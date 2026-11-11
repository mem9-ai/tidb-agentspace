import { test, expect } from './workspace-fixture.mjs';

for (const session of ['account', 'guest']) {
  test(`@visual AgentSpace ${session} navigation keeps real capabilities primary`, async ({
    page,
    workspace,
  }, testInfo) => {
    workspace.addResources();
    if (session === 'account') workspace.signInAsAccount();
    else workspace.requireSignIn({ guestEnabled: true });
    if (session === 'guest') {
      await page.goto('/#overview');
      await page.getByRole('button', { name: 'Try without an account' }).click();
      await page
        .getByRole('combobox', { name: 'Color theme', exact: true })
        .selectOption(testInfo.project.metadata.theme);
    } else await workspace.open('#overview');
    await expect(page).toHaveTitle('TiDB AgentSpace');
    const menu = page.getByRole('button', { name: 'Open navigation' });
    if (await menu.isVisible()) await menu.click();
    const navigation = page
      .getByRole('navigation', { name: 'Main navigation' })
      .filter({ visible: true });
    const more = navigation.locator('details');
    await expect(more).not.toHaveAttribute('open', '');
    for (const label of ['Home', 'Agents', 'Files', 'Databases', 'Access'])
      await expect(navigation.getByRole('link', { name: label, exact: true })).toBeVisible();
    await expect(
      navigation.getByRole('link', { name: /Runs|Memory|Activity|Monitoring/ }),
    ).toHaveCount(0);
    await more.getByText('More', { exact: true }).press('Enter');
    for (const label of ['Quickstarts', 'Developers', 'Usage', 'Settings'])
      await expect(more.getByRole('link', { name: label, exact: true })).toBeVisible();
    if (process.env.AGENTSPACE_SCREENSHOTS)
      await page.screenshot({
        path: `${process.env.AGENTSPACE_SCREENSHOTS}/navigation-${session}-${testInfo.project.name}.png`,
        animations: 'disabled',
      });
    await navigation.getByRole('link', { name: 'Agents', exact: true }).click();
    await expect(page).toHaveURL(/#connect$/);
    await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
    if (await menu.isVisible())
      await expect(page.getByRole('dialog', { name: 'TiDB AgentSpace' })).not.toBeVisible();
    await expect(
      page.getByText('Creating a key does not confirm that an agent is connected.', {
        exact: false,
      }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    if (process.env.AGENTSPACE_SCREENSHOTS)
      await page.screenshot({
        path: `${process.env.AGENTSPACE_SCREENSHOTS}/agents-${session}-${testInfo.project.name}.png`,
        fullPage: true,
        animations: 'disabled',
      });
  });
}

test('@visual Home links to saved resources and first-result quickstarts across reloads', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.addResources();
  workspace.signInAsAccount();
  workspace.state.resources[0].name = 'Sales database';
  workspace.state.resources[1].name = 'Research files';
  await workspace.open('#overview');
  const resources = page.getByRole('region', { name: 'Your resources' });
  await expect(resources.getByRole('link', { name: 'Research files' })).toBeVisible();
  await expect(
    page.getByRole('main').getByRole('link', { name: 'Connect an agent', exact: true }),
  ).toHaveAttribute('href', '#connect');
  await expect(page.getByRole('link', { name: 'Explore the sales sample' })).toHaveAttribute(
    'href',
    '#overview?example=sales',
  );
  await expect(page.getByRole('link', { name: 'Open saved files', exact: true })).toHaveAttribute(
    'href',
    '#files',
  );
  if (process.env.AGENTSPACE_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.AGENTSPACE_SCREENSHOTS}/home-${testInfo.project.name}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  await expect(page.locator('footer')).toContainText(
    'Open Files or Databases to continue your work',
  );
  await resources.getByRole('link', { name: 'Research files' }).click();
  await expect(page).toHaveURL(/#files\?resourceId=fs_fixture$/);
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'File system', exact: true })).toHaveValue(
    'fs_fixture',
  );
  await page.goto('/#overview');
  await expect(resources.getByRole('link', { name: 'Research files' })).toBeVisible();
  expect(
    workspace.requests.filter(
      ({ method, path }) =>
        method === 'POST' && /\/(?:keys|queries|sales-sample-attempts)$/.test(path),
    ),
  ).toHaveLength(0);
});

test('Agents onboarding offers a real task without granting access or asserting connectivity', async ({
  page,
  workspace,
}) => {
  await workspace.open('#connect');
  await expect(page.getByRole('link', { name: 'Add your files', exact: true })).toHaveAttribute(
    'href',
    '#files',
  );
  await page.getByRole('button', { name: 'Create API key' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create API key' });
  await expect(dialog.getByRole('button', { name: 'Create key', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const result = page.getByRole('region', { name: 'Get your first result' });
  await expect(result).toContainText('It does not verify who created it');
  await result.getByRole('link', { name: 'Try the sales task' }).click();
  await expect(page).toHaveURL(/#overview\?example=sales$/);
  await expect(page.getByRole('region', { name: 'Explore US sales' })).toBeVisible();
  expect(
    workspace.requests.filter(
      ({ method, path }) =>
        method === 'POST' && /\/(?:keys|queries|sales-sample-attempts)$/.test(path),
    ),
  ).toHaveLength(0);
});
