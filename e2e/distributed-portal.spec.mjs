import { test, expect } from './workspace-fixture.mjs';

test('distributed Portal exchanges a verified login for a regional session and signs out', async ({
  page,
  workspace,
}) => {
  const id = '6298280f-5113-435e-938c-058d0ed2beff';
  workspace.state.workspace.id = id;
  workspace.addResources();
  let issued = 0;
  let exchanged = 0;
  let signedOut = 0;
  await page.route('**/config.json', (route) =>
    route.fulfill({
      json: {
        apiOrigin: 'http://127.0.0.1:4389',
        apiPathPrefix: '/api/global',
        portalMode: 'distributed',
      },
    }),
  );
  await page.route('**/regional-session-tickets', (route) => {
    issued++;
    return route.fulfill({
      status: 201,
      json: {
        ticket: 'test-ticket',
        region: { regionId: 'region:local', apiOrigin: 'http://127.0.0.1:4389', apiPathPrefix: '' },
        expiresIn: 60,
      },
    });
  });
  await page.route('**/session-exchanges', (route) => {
    expect(route.request().postDataJSON()).toEqual({ ticket: 'test-ticket' });
    exchanged++;
    return route.fulfill({ json: { workspaceId: id } });
  });
  await page.route('**/api/auth/tidbcloud/logout**', (route) => {
    expect(route.request().method()).toBe('POST');
    signedOut++;
    return route.fulfill({ json: { loggedOut: true } });
  });

  await page.goto(`/?portal_workspace=${id}#databases`);
  await expect(page.getByText('mysql-fixture', { exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/portal_workspace/);
  expect(issued).toBe(1);
  expect(exchanged).toBe(1);
  await page.reload();
  await expect(page.getByText('mysql-fixture', { exact: true })).toBeVisible();
  expect(issued).toBe(2);
  expect(exchanged).toBe(2);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  expect(signedOut).toBe(2);
  expect(issued).toBe(2);
});

test('distributed Portal does not send session tickets to an untrusted Region address', async ({
  page,
  workspace,
}) => {
  const id = '6298280f-5113-435e-938c-058d0ed2beff';
  workspace.state.workspace.id = id;
  await page.route('**/config.json', (route) =>
    route.fulfill({
      json: {
        apiOrigin: 'http://127.0.0.1:4389',
        apiPathPrefix: '/api/global',
        portalMode: 'distributed',
      },
    }),
  );
  await page.route('**/regional-session-tickets', (route) =>
    route.fulfill({
      status: 201,
      json: {
        ticket: 'test-ticket',
        region: {
          regionId: 'region:local',
          apiOrigin: 'http://attacker.example',
          apiPathPrefix: '',
        },
        expiresIn: 60,
      },
    }),
  );
  let exchange = false;
  await page.route('**/session-exchanges', (route) => {
    exchange = true;
    return route.abort();
  });
  await page.goto(`/?portal_workspace=${id}`);
  await expect(page.getByRole('heading', { name: 'Couldn’t open your workspace' })).toBeVisible();
  await expect(page.getByText('The Workspace Region address is invalid.')).toBeVisible();
  expect(exchange).toBe(false);
});
