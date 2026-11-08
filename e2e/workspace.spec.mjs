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
  await expect(dialog.getByLabel('Provider data location')).toHaveCount(0);
  await expect(dialog.getByRole('combobox', { name: 'Database type' })).toHaveCount(0);
  await expect(dialog.getByText('PostgreSQL Compatible', { exact: true })).toBeVisible();
  await expect(dialog).not.toContainText(/db9|TiDB Cloud Starter/i);
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
    page.getByRole('heading', { name: 'How would you like to work?', level: 1 }),
  ).toBeVisible();
  const browser = page.getByRole('region', { name: 'In your browser' });
  const account = browser.getByRole('button', { name: 'Continue with TiDB Cloud' });
  await expect(account).toBeEnabled();
  await expect(browser.getByText('Guest access is currently unavailable.')).toBeVisible();
  await expect(browser.getByRole('button', { name: 'Try without an account' })).toHaveCount(0);
  await expect(
    page
      .getByRole('region', { name: 'With your coding agent' })
      .getByRole('button', { name: 'Copy prompt' }),
  ).toBeEnabled();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await account.click();
  await expect(page).toHaveURL(/\/api\/auth\/tidbcloud\/login$/);
});

test('a person can copy the agent prompt manually when clipboard access is denied', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: async () => {
        throw new DOMException('Denied', 'NotAllowedError');
      },
    }),
  );
  const agent = page.getByRole('region', { name: 'With your coding agent' });
  const copyPrompt = agent.getByRole('button', { name: 'Copy prompt' });
  await expect(copyPrompt).toBeEnabled();
  const before = workspace.requests.length;
  await copyPrompt.click();
  const manual = agent.getByRole('textbox', {
    name: 'Select and copy the prompt for your coding agent',
  });
  await expect(manual).toBeVisible();
  await expect(manual).toHaveValue(
    /https:\/\/drive9\.ai\/studio\/skills\/tidb-agent-workspace\/SKILL\.md/,
  );
  await manual.focus();
  expect(await manual.evaluate((field) => field.selectionEnd - field.selectionStart)).toBe(
    (await manual.inputValue()).length,
  );
  expect(workspace.requests).toHaveLength(before);
});

test('signed-out and signed-in browsers reuse authoritative session discovery', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Try without an account' })).toBeVisible();
  workspace.signInAsAccount();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Try with an agent' })).toBeEnabled();
  expect(workspace.requests.filter((r) => r.path === '/api/portal/v1/workspaces')).toHaveLength(0);
});

test('failed auth configuration can retry and supports hosts requiring separate discovery', async ({
  page,
  context,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  let first = true;
  await context.route('**/api/auth/config', (route) => {
    if (first) {
      first = false;
      return route.abort('failed');
    }
    return route.fulfill({
      json: { enabled: true, guestEnabled: true, loginPath: '/api/auth/tidbcloud/login' },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Couldn’t open your workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: 'Try without an account' })).toBeVisible();
  expect(workspace.requests.filter((r) => r.path === '/api/portal/v1/workspaces')).toHaveLength(1);
});

test('@visual Guest sign-in opens the Workspace when the server enables it', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  await expect(page.locator('.sign-in-brand')).toHaveText('TiDB Agent Workspace');
  await expect(page.locator('.sign-in-brand')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'How would you like to work?', level: 1 }),
  ).toBeVisible();
  const agent = page.getByRole('region', { name: 'With your coding agent' });
  const browser = page.getByRole('region', { name: 'In your browser' });
  const guest = browser.getByRole('button', { name: 'Try without an account' });
  await expect(guest).toBeEnabled();
  await expect(guest).toHaveAccessibleDescription('No account needed · 48-hour trial');
  await expect(browser.getByText('No account needed · 48-hour trial')).toBeVisible();
  await expect(
    agent.getByText(/Claude Code, Cursor, Codex, Pi, or another local coding agent/),
  ).toBeVisible();
  await expect(agent).toContainText(
    'Your agent analyzes the sales sample and gives you a report link.',
  );
  await expect(agent.getByText('No account needed · 48-hour trial')).toBeVisible();
  const account = page.getByRole('button', { name: 'Continue with TiDB Cloud' });
  await expect(account).toBeEnabled();
  await expect(browser.getByRole('button', { name: 'Continue with TiDB Cloud' })).toHaveCount(0);
  const accountBounds = await account.boundingBox();
  const browserBounds = await browser.boundingBox();
  expect(accountBounds.x + accountBounds.width).toBeCloseTo(
    browserBounds.x + browserBounds.width,
    0,
  );
  expect(accountBounds.y).toBeGreaterThanOrEqual(browserBounds.y + browserBounds.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.GUEST_SIGNIN_SCREENSHOT)
    await page.screenshot({
      path: `${process.env.GUEST_SIGNIN_SCREENSHOT}-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  const beforeCopy = workspace.requests.length;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await agent.getByRole('button', { name: 'Copy prompt' }).click();
  await expect(page.getByRole('status')).toHaveText('Copied. Paste it into your project chat.');
  const instruction = await page.evaluate(() => navigator.clipboard.readText());
  expect(instruction).toContain('https://drive9.ai/studio/skills/tidb-agent-workspace/SKILL.md');
  expect(instruction).toContain('save a report');
  expect(instruction).toContain('open the report in Workspace');
  expect(instruction).toContain('free trial');
  expect(workspace.requests).toHaveLength(beforeCopy);
  const beforeGuest = workspace.requests.length;
  await guest.click();
  await expect(page.getByRole('combobox', { name: 'Color theme', exact: true })).toBeVisible();
  await page.goto('/#settings');
  const settings = page.getByRole('main');
  await expect(settings.getByText('Temporary session', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Your temporary workspace expires 48 hours after it was created.'),
  ).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Sign out' })).toBeVisible();
  if (process.env.GUEST_SETTINGS_SCREENSHOT) {
    await settings.getByText('Temporary session', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.env.GUEST_SETTINGS_SCREENSHOT });
  }
  await settings.getByRole('button', { name: 'Sign out' }).click();
  await page
    .getByRole('dialog', { name: 'Leave this temporary workspace?' })
    .getByRole('button', {
      name: 'Cancel',
    })
    .click();
  const guestRequests = workspace.requests.slice(beforeGuest);
  expect(guestRequests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: '/api/auth/guest', method: 'POST' }),
      expect.objectContaining({
        path: `/api/portal/v1/workspaces/${workspace.state.workspace.id}/bootstrap`,
        method: 'GET',
      }),
    ]),
  );
  expect(guestRequests.filter((request) => request.path === '/api/auth/config')).toHaveLength(0);
  expect(
    guestRequests.filter((request) => request.path === '/api/portal/v1/workspaces'),
  ).toHaveLength(0);
});

test('an invalid guest workspace cannot start a workspace request', async ({
  page,
  context,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  await context.route('**/api/auth/guest', (route) =>
    route.fulfill({ json: { workspaceId: '../another-workspace' } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  await expect(
    page.getByText('Unable to start a temporary workspace. Please try again.'),
  ).toBeVisible();
  expect(workspace.requests.filter((request) => request.path.endsWith('/bootstrap'))).toHaveLength(
    0,
  );
});

test('Guest API key creation explains the Workspace expiry', async ({ page, workspace }) => {
  workspace.requireSignIn({ guestEnabled: true });
  workspace.addResources();
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  await workspace.open('#keys');
  await page.getByRole('button', { name: 'Create API key', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create API key', exact: true });
  await expect(
    dialog.getByText('Expires with your temporary workspace (within 48 hours), or on sign-out.'),
  ).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Expiration' })).toHaveCount(0);
  await dialog.getByLabel('Key name').fill('guest-agent');
  await dialog.getByRole('checkbox', { name: 'filesystem-fixture', exact: true }).check();
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Your key is ready' })).toBeVisible();
  const creation = workspace.requests.findLast(
    (request) => request.method === 'POST' && request.path.endsWith('/keys'),
  );
  expect(creation.body.expiresInDays).toBe(2);
});

test('@visual Guest can cancel or confirm sign-out from the workspace navigation', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  await expect(
    page.getByRole('main').getByRole('heading', { name: 'Work with your data, your way' }),
  ).toBeVisible();

  async function openSignOut() {
    const openNavigation = page.getByRole('button', { name: 'Open navigation' });
    if (await openNavigation.isVisible()) await openNavigation.click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    return page.getByRole('dialog', { name: 'Leave this temporary workspace?' });
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
  await expect(dialog.getByRole('alert')).toContainText('Unable to sign out');
  await expect(dialog.getByRole('button', { name: 'Sign out', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Try without an account' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Try without an account' }).click();
  await page.goto('/#settings');
  await expect(
    page.getByRole('main').getByText('Temporary session', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
});

test('@visual an empty personal account workspace is described accurately', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.signInAsAccount();
  await page.goto('/?code=redeemed-fixture&state=fixture-state&view=keep#settings');
  await expect(page).toHaveURL(/\?view=keep#settings$/);
  await expect(page.getByText('Sign in again to load your account details.')).toBeVisible();
  await expect(
    page.getByText('Admitted accounts have owner access.', { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Product prototype · Cloud resources & telemetry are simulated'),
  ).toHaveCount(0);
  await expect(page.getByText('Create a resource to get started')).toBeVisible();
  if (process.env.PERSONAL_SETTINGS_SCREENSHOT) {
    await page.locator('.account-session-summary').scrollIntoViewIfNeeded();
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
    const database = workspace.state.resources.find((resource) => resource.kind === 'postgresql');
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

test('@visual database creation offers PostgreSQL without an engine choice', async ({
  page,
  workspace,
}, testInfo) => {
  await workspace.open('#databases');
  const trigger = page.getByRole('button', { name: 'Create database', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Create a database' });
  await expect(dialog.getByText('Create a database', { exact: true })).toBeFocused();
  await expect(dialog.getByRole('combobox', { name: 'Database type' })).toHaveCount(0);
  await expect(dialog.getByLabel('Provider data location')).toHaveCount(0);
  const name = dialog.getByRole('textbox', { name: 'Resource name', exact: true });
  await expect(name).toHaveValue(/^tidb_pg-[a-f0-9]{16}$/);
  expect(await name.evaluate((element) => element.checkValidity())).toBe(true);
  await name.fill('invalid.name');
  expect(await name.evaluate((element) => element.checkValidity())).toBe(false);
  await name.fill('tidb_pg-example');
  expect(await name.evaluate((element) => element.checkValidity())).toBe(true);
  await expect(name).toHaveCSS('font-size', '16px');
  await expect(name).toHaveCSS('height', '48px');
  await expect(dialog.getByText('PostgreSQL Compatible', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create database', exact: true })).toBeEnabled();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  if (process.env.DEFAULT_DATABASE_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.DEFAULT_DATABASE_SCREENSHOTS}/${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  await dialog.getByRole('button', { name: 'Close dialog' }).press('Escape');
  await expect(trigger).toBeFocused();
});

for (const [kind, region] of [['postgresql', 'automatic']]) {
  test(`creating ${kind} sends the selected kind and default provider location`, async ({
    page,
    workspace,
  }) => {
    await workspace.open('#databases');
    await page.getByRole('button', { name: 'Create database', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a database' });
    await dialog.getByRole('button', { name: 'Create database', exact: true }).click();
    await expect
      .poll(() =>
        workspace.requests.some((r) => r.method === 'POST' && r.path.endsWith('/resources')),
      )
      .toBe(true);
    const create = workspace.requests.find(
      (r) => r.method === 'POST' && r.path.endsWith('/resources'),
    );
    expect(create.body).toMatchObject({ kind, region });
  });
}

test('@visual an unavailable PostgreSQL provider cannot create a database', async ({
  page,
  workspace,
}) => {
  workspace.state.capabilities.postgresql.available = false;
  await workspace.open('#databases');
  await page.getByRole('button', { name: 'Create database', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a database' });
  await expect(dialog.getByText(/PostgreSQL-compatible databases are unavailable/)).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Database type' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Create database', exact: true })).toBeDisabled();
  expect(
    workspace.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/resources')),
  ).toHaveLength(0);
});

test('database creation does not submit when no provider location is available', async ({
  page,
  workspace,
}) => {
  workspace.state.capabilities.postgresql.regions = [];
  await workspace.open('#databases');
  await page.getByRole('button', { name: 'Create database', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a database' });
  await expect(
    dialog.getByText('No data location is available for this resource right now.'),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create database', exact: true })).toBeDisabled();
  expect(
    workspace.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/resources')),
  ).toHaveLength(0);
});

test('@visual Guest database creation distinguishes Workspace access from provider expiry', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try without an account' }).click();
  await expect(page.getByRole('main')).toBeVisible();
  await page.goto('/#databases');
  const theme = page.getByRole('combobox', { name: 'Color theme' });
  const themeText = await theme.evaluate((element) => {
    const style = getComputedStyle(element);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const text = element.selectedOptions[0]?.textContent || '';
    return {
      text,
      textWidth: context.measureText(text).width,
      availableWidth:
        element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    };
  });
  expect(themeText.text).toBe('System');
  expect(themeText.textWidth).toBeLessThanOrEqual(themeText.availableWidth);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.getByRole('button', { name: 'Create database', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a database' });
  await expect(
    dialog.getByText('Temporary workspace access ends 48 hours after it was created.'),
  ).toBeVisible();
  if (process.env.DEFAULT_DATABASE_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.DEFAULT_DATABASE_SCREENSHOTS}/guest-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
});

for (const kind of ['filesystem']) {
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
    let suggestedName;
    if (kind === 'filesystem') {
      const name = dialog.getByRole('textbox', { name: 'Resource name' });
      await expect(name).toHaveValue(/^[a-z]+-[a-z]+$/);
      suggestedName = await name.inputValue();
    }
    await expect(dialog.getByLabel('Provider data location')).toHaveCount(0);
    await expect(dialog.getByText('AWS · Singapore')).toHaveCount(0);
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
    if (kind === 'filesystem') {
      expect(
        workspace.requests.find(
          (request) => request.path.endsWith('/resources') && request.method === 'POST',
        ).body.name,
      ).toBe(suggestedName);
    }
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
  await expect(kind.locator('option')).toHaveCount(2);
  await expect(kind.locator('option')).toHaveText(['PostgreSQL Compatible', 'File System']);
  await expect(name).toHaveValue(/^tidb_pg-/);
  await name.fill('my-custom-name');
  await kind.selectOption('filesystem');
  await expect(name).toHaveValue('my-custom-name');
  await kind.selectOption('postgresql');
  await expect(name).toHaveValue('my-custom-name');
  await name.fill('');
  await kind.selectOption('filesystem');
  await expect(name).toHaveValue(/^[a-z]+-[a-z]+$/);
  await name.fill('');
  workspace.rejectNextName();
  await dialog.getByRole('button', { name: 'Create file system', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('A new name is ready');
  const creates = () =>
    workspace.requests.filter((r) => r.path.endsWith('/resources') && r.method === 'POST');
  expect(creates()).toHaveLength(1);
  await expect(name).toHaveValue(/^[a-z]+-[a-z]+(?:-\d+)?$/);
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
  await expect(dialog.getByRole('button', { name: 'Create key', exact: true })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'filesystem-fixture', exact: true }).check();
  await expect(dialog.getByRole('checkbox', { name: /resources:write/ })).toHaveCount(0);
  await dialog.getByRole('checkbox', { name: /files:read/ }).check();
  await dialog.getByRole('combobox', { name: 'Expiration' }).selectOption('7');
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
  const readyKey = page.getByRole('dialog', { name: 'Your key is ready' });
  await expect(readyKey).toBeVisible();
  await readyKey.getByRole('button', { name: 'Continue to key' }).click();
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
  const issued = workspace.requests.find((r) => r.path.endsWith('/keys') && r.method === 'POST');
  expect(issued.path).toContain('/api/global/api/');
  await readyKey.getByRole('button', { name: 'Close dialog' }).click();
  await expect(readyKey.getByRole('alert')).toContainText('full key cannot be shown again');
  await readyKey.getByRole('button', { name: 'Close without copying' }).click();
  await expect(secret).toHaveCount(0);
  await expect(page.getByRole('cell', { name: /^file-reader/ })).toBeVisible();
});

test('@visual key permissions follow resource types and restore a specific selection', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.addResources();
  await workspace.open('#keys');
  await page.getByRole('button', { name: 'Create API key', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create API key', exact: true });
  await dialog.getByLabel('Key name').fill('mixed-agent');
  await expect(
    dialog.getByRole('checkbox', { name: 'filesystem-fixture', exact: true }),
  ).not.toBeChecked();
  await expect(
    dialog.getByRole('checkbox', { name: 'postgresql-fixture', exact: true }),
  ).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: 'filesystem-fixture', exact: true }).check();
  await expect(dialog.getByRole('checkbox', { name: /queries:read/ })).toHaveCount(0);
  await dialog.getByRole('checkbox', { name: /files:read/ }).check();
  if (process.env.KEY_PERMISSIONS_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.KEY_PERMISSIONS_SCREENSHOTS}-files-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  await dialog.getByRole('checkbox', { name: 'postgresql-fixture', exact: true }).check();
  await dialog.getByRole('checkbox', { name: /queries:read/ }).check();
  await dialog.getByRole('checkbox', { name: 'filesystem-fixture', exact: true }).uncheck();
  await expect(dialog.getByRole('checkbox', { name: /files:read/ })).toHaveCount(0);
  await expect(dialog.getByRole('status')).toContainText('files:read');
  await expect(dialog.getByRole('checkbox', { name: /queries:read/ })).toBeChecked();
  await dialog.getByText('Advanced resource access').click();
  const all = dialog.getByRole('checkbox', { name: 'All current and future resources' });
  await all.check();
  await expect(
    dialog.getByText(/All current and future resources, subject to the permissions below/),
  ).toBeVisible();
  await expect(
    dialog.getByText(/Only selected resources; future resources are excluded/),
  ).toHaveCount(0);
  await dialog.getByText('Workspace · Discover resources').click();
  await dialog.getByRole('checkbox', { name: /resources:write/ }).check();
  await all.uncheck();
  await expect(dialog.getByRole('status')).toContainText('resources:write');
  await expect(
    dialog.getByRole('checkbox', { name: 'postgresql-fixture', exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole('checkbox', { name: 'filesystem-fixture', exact: true }),
  ).not.toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /resources:write/ })).toHaveCount(0);
  await expect(dialog.getByRole('checkbox', { name: /files:read/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Your key is ready' })).toBeVisible();
  expect(
    workspace.requests.findLast((entry) => entry.method === 'POST' && entry.path.endsWith('/keys'))
      .body,
  ).toMatchObject({
    resourceIds: ['db_fixture'],
    scopes: ['resources:read', 'queries:read'],
  });
});

test('a created key leads to agent instructions after it is copied', async ({
  page,
  workspace,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (value) => (globalThis.__copiedText = value) },
    });
  });
  workspace.addResources();
  await workspace.open('#keys');
  await page.getByRole('button', { name: 'Create API key', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create API key', exact: true });
  await dialog.getByLabel('Key name').fill('agent-access');
  await dialog.getByRole('checkbox', { name: 'filesystem-fixture', exact: true }).check();
  await dialog.getByRole('checkbox', { name: /files:read/ }).check();
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
  const ready = page.getByRole('dialog', { name: 'Your key is ready' });
  await ready.getByRole('button', { name: 'Continue to key' }).click();
  await ready.getByRole('button', { name: 'Copy key', exact: true }).click();
  await ready.getByRole('button', { name: 'I’ve added the key' }).click();
  await expect(page).toHaveURL(/#connect$/);
  await expect(page.getByRole('heading', { name: 'Connect an agent', level: 1 })).toBeVisible();
  await expect(page.getByText('synthetic-browser-key-never-valid-on-a-provider')).toHaveCount(0);
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
  await dialog.getByRole('checkbox', { name: 'postgresql-fixture', exact: true }).check();
  await expect(dialog.getByRole('checkbox', { name: /files:read/ })).toHaveCount(0);
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
