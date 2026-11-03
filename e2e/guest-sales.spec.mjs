import { test, expect } from './workspace-fixture.mjs';

test('@visual Guest starts a sales task, grants only its file system and returns to the saved sample', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const task = page.getByRole('region', { name: 'US sales agent task' });
  await expect(
    task.getByRole('heading', { name: 'Let your agent explore US sales' }),
  ).toBeVisible();
  await expect(page.getByText('Guest workspace · Access expires after 24 hours')).toBeVisible();
  if (await page.getByRole('button', { name: 'Open navigation' }).isVisible()) {
    await expect(page.locator('.workspace-mobile-crumb')).toHaveText('Workspace');
  }
  await expect(task.getByRole('button', { name: 'Prepare sample' })).toBeVisible();
  expect(
    workspace.requests.filter(
      (entry) => entry.method === 'POST' && entry.path.endsWith('/sales-sample-attempts'),
    ),
  ).toHaveLength(0);
  if (process.env.GUEST_SALES_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.GUEST_SALES_SCREENSHOTS}-start-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  await task.getByRole('button', { name: 'Prepare sample' }).click();
  await expect(task.getByText('Sample ready · /us-sales.csv')).toBeVisible();
  await expect(task.getByRole('link', { name: 'Open sample' })).toHaveAttribute(
    'href',
    /resourceId=fs_sales.*us-sales.csv/,
  );
  expect(workspace.state.resources.map((resource) => resource.kind)).toEqual(['filesystem']);
  await task.getByRole('button', { name: 'Create agent key' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create API key' });
  await expect(dialog.getByRole('checkbox', { name: 'sales-workspace' })).toBeChecked();
  await expect(
    dialog.getByRole('checkbox', { name: 'All current and future resources' }),
  ).not.toBeChecked();
  for (const scope of ['files:read', 'files:analyze', 'files:write'])
    await expect(dialog.getByRole('checkbox', { name: new RegExp(scope) })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /queries:execute/ })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(
    workspace.requests.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/keys')),
  ).toHaveLength(0);
  await task.getByRole('button', { name: 'Create agent key' }).click();
  await page
    .getByRole('dialog', { name: 'Create API key' })
    .getByRole('button', { name: 'Create key', exact: true })
    .click();
  const readyKey = page.getByRole('dialog', { name: 'Your key is ready' });
  await expect(readyKey).toBeVisible();
  const createdKey = workspace.requests.findLast(
    (entry) => entry.method === 'POST' && entry.path.endsWith('/keys'),
  );
  expect(createdKey.body.resourceIds).toEqual(['fs_sales']);
  expect(createdKey.body.scopes).toEqual([
    'resources:read',
    'files:read',
    'files:analyze',
    'files:write',
  ]);
  await readyKey.getByRole('button', { name: 'Done' }).click();
  await task.getByRole('button', { name: 'Check for report' }).click();
  await expect(
    task.getByText('No report found yet. Check again after your agent saves it.'),
  ).toBeVisible();
  workspace.state.files.push({
    id: 'report',
    resourceId: 'fs_sales',
    path: '/us-sales-report.md',
    type: 'file',
    content: '# Report',
    size: 8,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await task.getByRole('button', { name: 'Check for report' }).click();
  await expect(task.getByRole('link', { name: 'Open report' })).toBeVisible();
  await expect(task.getByRole('button', { name: 'Copy follow-up task' })).toBeVisible();
  if (process.env.GUEST_SALES_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.GUEST_SALES_SCREENSHOTS}-report-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  await page.reload();
  await expect(task.getByText('Sample ready · /us-sales.csv')).toBeVisible();
  expect(
    workspace.requests.filter(
      (entry) => entry.method === 'POST' && entry.path.endsWith('/sales-sample-attempts'),
    ),
  ).toHaveLength(1);
  workspace.state.files.find((file) => file.path === '/us-sales.csv').version = '"edited"';
  await page.reload();
  await expect(task.getByText(/This sample has changed since it was created/)).toBeVisible();
  await expect(task.getByRole('button', { name: 'Create agent key' })).toBeDisabled();
  await expect(task.getByRole('button', { name: 'Copy agent task' })).toBeDisabled();
  expect(
    workspace.requests.filter(
      (entry) => entry.method === 'POST' && entry.path.endsWith('/sales-sample-attempts'),
    ),
  ).toHaveLength(1);
  const menu = page.getByRole('button', { name: 'Open navigation' });
  if (await menu.isVisible()) await menu.click();
  const navigation = page
    .getByRole('navigation', { name: 'Main navigation' })
    .filter({ visible: true });
  await expect(navigation.getByRole('link', { name: 'Files', exact: true })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Access', exact: true })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Databases', exact: true })).toBeHidden();
  await navigation.getByText('More', { exact: true }).click();
  await expect(navigation.getByRole('link', { name: 'Databases', exact: true })).toBeVisible();
  await navigation.getByRole('link', { name: 'Databases', exact: true }).click();
  await expect(page).toHaveURL(/#databases$/);
});
