import { test, expect, sampleResources } from './workspace-fixture.mjs';
import { readFile } from 'node:fs/promises';

const collections = [
  {
    hash: '#databases',
    title: 'Databases',
    table: 'Databases',
    create: 'Create database',
    dialog: 'Create a database',
    empty: 'Databases empty state',
    id: 'db_fixture',
  },
  {
    hash: '#files',
    title: 'File Systems',
    table: 'File systems',
    create: 'Create file system',
    dialog: 'Create a File System',
    empty: 'File Systems empty state',
    id: 'fs_fixture',
  },
];

test('a new source editor waits for its saved content before accepting a draft and receiving focus', async ({
  page,
  context,
  workspace,
}) => {
  workspace.addResources();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.pathname.endsWith('/files/content') &&
      url.searchParams.get('path') === '/agent-notes.md'
    ) {
      await pending;
      return route.fulfill({ json: { content: '', size: 0 } });
    }
    if (!url.pathname.endsWith('/files') || request.method() !== 'PUT') return route.fallback();
    const input = request.postDataJSON();
    const saved = {
      id: 'new-source',
      resourceId: input.resourceId,
      path: input.path,
      type: 'file',
      size: 0,
      updatedAt: null,
    };
    workspace.state.files.push({ ...saved, content: '' });
    return route.fulfill({ json: { data: saved } });
  });
  try {
    await workspace.open('#files?resourceId=fs_fixture');
    await page.getByRole('button', { name: 'Create file or folder', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New file', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a file', exact: true });
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('agent-notes.md');
    await dialog.getByRole('button', { name: 'Create file', exact: true }).click();
    const source = page.getByRole('textbox', { name: 'File content', exact: true });
    await expect(source).toBeVisible();
    await expect(source).toBeDisabled();
    await expect(page.getByText('Loading saved file…', { exact: true })).toBeVisible();
    release();
    await expect(source).toBeEnabled();
    await expect(source).toBeFocused();
    await source.fill('# Agent notes\n\nKeep this draft.');
    await page.getByRole('button', { name: 'All file systems', exact: true }).click();
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(source).toHaveValue('# Agent notes\n\nKeep this draft.');
  } finally {
    release();
  }
});

test('new files open for editing, lock creation, protect drafts and survive summary refresh failure', async ({
  page,
  context,
  workspace,
}, testInfo) => {
  workspace.addResources();
  workspace.state.resources[1].name = 'demo-files';
  workspace.state.profile.name = 'Developer';
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const writes = [];
  let failSummary = false;
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/bootstrap') && request.method() === 'GET' && failSummary) {
      failSummary = false;
      return route.fulfill({
        status: 503,
        json: { error: { code: 'UNAVAILABLE', message: 'Summary temporarily unavailable.' } },
      });
    }
    if (!path.endsWith('/files') || request.method() !== 'PUT') return route.fallback();
    const body = request.postDataJSON();
    writes.push(body);
    if (writes.length === 1) await pending;
    else failSummary = true;
    const saved = {
      ...body,
      id: 'created-notes',
      size: Buffer.byteLength(body.content || ''),
      updatedAt: '2026-11-01T00:00:00Z',
    };
    workspace.state.files = [
      ...workspace.state.files.filter((file) => file.path !== body.path),
      saved,
    ];
    return route.fulfill({ json: { data: saved } });
  });
  try {
    await workspace.open('#files?resourceId=fs_fixture');
    await page.getByRole('button', { name: 'Create file or folder', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New file', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a file', exact: true });
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('notes.md');
    await dialog.getByRole('button', { name: 'Create file', exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    release();
    const source = page.getByRole('textbox', { name: 'File content', exact: true });
    await expect(source).toBeVisible();
    await expect(source).toBeFocused();
    await expect(page).toHaveURL(/path=%2Fnotes.md&view=preview/);
    await source.fill('# Sales notes\n\nKeep this draft.');
    await page.getByRole('button', { name: 'Create file or folder', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New file', exact: true }).click();
    await expect(
      page.getByRole('alert', { name: 'Keep your changes?', exact: true }),
    ).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(source).toHaveValue('# Sales notes\n\nKeep this draft.');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('Unsaved changes', { exact: true })).toHaveCount(0);
    await expect(source).toHaveValue('# Sales notes\n\nKeep this draft.');
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
    await expect(
      page.getByText('Saved. Refresh the file list to see the update; do not repeat the save.', {
        exact: true,
      }),
    ).toBeVisible();
    expect(writes).toHaveLength(2);
    expect(workspace.state.files.find((file) => file.path === '/notes.md').content).toBe(
      '# Sales notes\n\nKeep this draft.',
    );
    if (process.env.EXPERIENCE_SCREENSHOTS)
      await page.screenshot({
        path: `${process.env.EXPERIENCE_SCREENSHOTS}/file-editor-${testInfo.project.name}.png`,
        animations: 'disabled',
      });
    await page.getByRole('button', { name: 'Close file preview', exact: true }).click();
    await page.getByRole('button', { name: /^notes\.md / }).click();
    await expect(page.getByRole('heading', { name: 'Sales notes', exact: true })).toBeVisible();
  } finally {
    release();
  }
});

test('@visual live workspaces show recorded state without illustrative charts or local-only instructions', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.addResources();
  workspace.state.resources[0].name = 'sales-demo';
  workspace.state.resources[1].name = 'demo-files';
  workspace.state.profile.name = 'Developer';
  workspace.signInAsAccount();
  workspace.state.mode = 'hybrid';
  workspace.state.resources[0].provider = 'tidb-cloud-zero';
  workspace.state.resources[0].status = 'expired';
  await workspace.open('#overview');
  await expect(page.getByRole('heading', { name: 'Workspace activity', exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('img', { name: 'Illustrative request activity', exact: true }),
  ).toHaveCount(0);
  if (testInfo.project.name.startsWith('narrow'))
    await page.getByRole('button', { name: 'Open navigation' }).click();
  const navigation = page
    .getByRole('navigation', { name: 'Main navigation' })
    .filter({ visible: true });
  await expect(navigation.getByRole('link', { name: 'Monitoring', exact: true })).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: 'Activity', exact: true })).toHaveCount(0);
  if (process.env.EXPERIENCE_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.EXPERIENCE_SCREENSHOTS}/navigation-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  if (testInfo.project.name.startsWith('narrow'))
    await page.getByRole('button', { name: 'Close navigation' }).click();
  await page.goto('/#monitoring');
  await expect(page).toHaveURL(/#overview$/);
  await expect(page.getByRole('region', { name: 'Your resources' })).toBeVisible();
  await page.goto('/#activity');
  await expect(page).toHaveURL(/#overview$/);
  await expect(page.getByRole('region', { name: 'Your resources' })).toBeVisible();
  expect(
    workspace.requests.filter(({ path }) => /\/(?:audit|request)-history$/.test(path)),
  ).toHaveLength(0);
  await page.goto('/#connect');
  await expect(page.getByText('REST API · Available locally', { exact: true })).toHaveCount(0);
  await page.goto('/#api');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.getByRole('main')).toContainText('sales-demo');
  await expect(page.getByRole('main')).toContainText('Workspace owner session');
});

test('@visual the shared shell identifies Agent Workspace and separates Cloud attribution from help', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.addResources();
  workspace.signInAsAccount();
  workspace.state.resources[0].provider = 'tidb-cloud-zero';
  await workspace.open('#overview');
  await expect(page).toHaveTitle('TiDB Agent Workspace');
  const brand = page.getByRole('link', { name: 'TiDB Agent Workspace', exact: true });
  const narrow = testInfo.project.name.startsWith('narrow');
  if (!narrow) {
    await expect(brand).toBeVisible();
    await expect(brand).toHaveAttribute('href', '#overview');
  }
  await expect(page.getByText('Live resources', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Prototype · Live resources', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open documentation' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Documentation', exact: true })).toHaveCount(0);
  if (process.env.BRANDING_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.BRANDING_SCREENSHOTS}/header-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  const footer = page.locator('footer');
  const attribution = footer.getByRole('link', { name: 'TiDB Cloud', exact: true });
  await attribution.scrollIntoViewIfNeeded();
  await expect(footer).toContainText('Powered by TiDB Cloud');
  await expect(attribution).toHaveAttribute('href', 'https://www.pingcap.com/tidb/cloud/');
  await expect(attribution).toHaveAttribute('target', '_blank');
  await expect(attribution).toHaveAttribute('rel', 'noopener noreferrer');
  if (process.env.BRANDING_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.BRANDING_SCREENSHOTS}/footer-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  if (narrow) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(
      page.getByRole('dialog', { name: 'TiDB Agent Workspace', exact: true }),
    ).toBeVisible();
    if (process.env.BRANDING_SCREENSHOTS)
      await page.screenshot({
        path: `${process.env.BRANDING_SCREENSHOTS}/navigation-${testInfo.project.name}.png`,
        animations: 'disabled',
      });
  }
  await page.getByRole('link', { name: 'Usage & billing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Usage & billing', exact: true })).toBeVisible();
  await expect(page.locator('a[href^="https://docs.pingcap.com/"]')).toHaveCount(0);
  if (!narrow) await brand.click();
  else {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('link', { name: 'Overview', exact: true }).click();
  }
  await expect(page).toHaveURL(/#overview$/);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
});

test('@visual resource pages distinguish unloaded collections and resolve deep links', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.state.resources = [structuredClone(sampleResources[0])];
  workspace.state.resourceNextCursor = 'page-two';
  workspace.setResourcePage('page-two', [structuredClone(sampleResources[1])]);
  await workspace.open('#files');
  await expect(
    page.getByText('No File Systems in the loaded resources. Load more to continue.'),
  ).toBeVisible();
  if (process.env.QUICKSTART_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.QUICKSTART_SCREENSHOTS}/pagination-${testInfo.project.name}.png`,
      fullPage: true,
    });
  await expect(page.getByRole('region', { name: 'File Systems empty state' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more resources' }).click();
  await expect(
    page.getByRole('table', { name: 'File systems' }).getByText('filesystem-fixture'),
  ).toBeVisible();
  expect(workspace.requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: `/api/portal/v1/workspaces/${workspace.state.workspace.id}/resources`,
        query: expect.objectContaining({ cursor: 'page-two', limit: '100' }),
      }),
    ]),
  );
  const beforeSelection = workspace.requests.length;
  await workspace.open('#files?resourceId=fs_fixture');
  await expect
    .poll(() =>
      workspace.requests
        .slice(beforeSelection)
        .some((request) => request.path.endsWith('/resources/fs_fixture')),
    )
    .toBe(true);
  const beforeReload = workspace.requests.length;
  await page.reload();
  await expect(page.getByText('File System unavailable')).toHaveCount(0);
  await expect
    .poll(() =>
      workspace.requests
        .slice(beforeReload)
        .some((request) => request.path.endsWith('/resources/fs_fixture')),
    )
    .toBe(true);
});

test('a directly linked database outside the first page keeps query results after refresh', async ({
  page,
  workspace,
}) => {
  workspace.state.resources = [structuredClone(sampleResources[1])];
  workspace.state.resourceNextCursor = 'page-two';
  workspace.setResourcePage('page-two', [structuredClone(sampleResources[0])]);
  await workspace.open('#databases/db_fixture/sql');
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(page.getByText('agent_started', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#databases\/db_fixture\/sql$/);
});

test('a directly linked local File System loads its own files outside the first page', async ({
  page,
  workspace,
}) => {
  workspace.state.resources = [structuredClone(sampleResources[0])];
  workspace.state.resourceNextCursor = 'page-two';
  workspace.setResourcePage('page-two', [structuredClone(sampleResources[1])]);
  workspace.state.files = [
    {
      id: 'file-off-page',
      resourceId: 'fs_fixture',
      path: '/outside.txt',
      type: 'file',
      content: 'preserved',
      size: 9,
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ];
  await workspace.open('#files?resourceId=fs_fixture');
  await expect(
    page.getByRole('navigation', { name: 'File entries' }).getByText('outside.txt'),
  ).toBeVisible();
  await expect
    .poll(() =>
      workspace.requests.some(
        (request) => request.path.endsWith('/files') && request.query.resourceId === 'fs_fixture',
      ),
    )
    .toBe(true);
});

test('@visual local File System loads directory pages on demand', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.addResources();
  workspace.state.files = Array.from({ length: 40 }, (_, index) => ({
    id: `file-${index}`,
    resourceId: 'fs_fixture',
    path: `/page-${String(index).padStart(2, '0')}.txt`,
    type: 'file',
    content: 'sample',
    size: 6,
    updatedAt: '2026-01-01T00:00:00Z',
  }));
  await workspace.open('#files?resourceId=fs_fixture');
  const entries = page.getByRole('navigation', { name: 'File entries' });
  await expect(entries.getByText('page-00.txt')).toBeVisible();
  await expect(entries.getByText('page-39.txt')).toHaveCount(0);
  const more = page.getByRole('button', { name: 'Load more files' });
  await expect(more).toBeVisible();
  if (process.env.FILE_PAGE_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.FILE_PAGE_SCREENSHOTS}/files-${testInfo.project.name}.png`,
    });
  await more.click();
  await expect(entries.getByText('page-39.txt')).toBeVisible();
  await expect(more).toHaveCount(0);
});

test('resource windows stay bounded and disclose selections from earlier pages', async ({
  page,
  workspace,
}, testInfo) => {
  test.setTimeout(60000);
  const resources = Array.from({ length: 400 }, (_, index) => ({
    ...structuredClone(sampleResources[0]),
    id: `db_window_${String(index).padStart(4, '0')}`,
    name: `window-database-${String(index).padStart(4, '0')}`,
  }));
  workspace.state.resources = resources.slice(0, 100);
  workspace.state.resourceNextCursor = 'window-1';
  for (let pageNumber = 1; pageNumber <= 3; pageNumber++) {
    workspace.setResourcePage(
      `window-${pageNumber}`,
      resources.slice(pageNumber * 100, (pageNumber + 1) * 100),
      pageNumber < 3 ? `window-${pageNumber + 1}` : null,
    );
  }
  await workspace.open('#keys');
  await page.getByRole('button', { name: 'Create API key', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create API key', exact: true });
  for (let pageNumber = 0; pageNumber < 3; pageNumber++)
    await dialog.getByRole('button', { name: 'Load more resources' }).click();
  await expect(dialog.getByRole('checkbox', { name: 'window-database-0000' })).toHaveCount(0);
  await expect(dialog.getByRole('checkbox', { name: 'window-database-0399' })).toBeVisible();
  await expect(
    dialog.getByText('100 selected resources are outside the loaded window.'),
  ).toBeVisible();
  if (process.env.SCALE_SCREENSHOTS) {
    await dialog
      .getByText('100 selected resources are outside the loaded window.')
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${process.env.SCALE_SCREENSHOTS}/resource-window-${testInfo.project.name}.png`,
    });
  }
  await dialog.getByRole('button', { name: 'Back to first resources' }).click();
  await expect(dialog.getByRole('checkbox', { name: 'window-database-0000' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('Key inventory pages keep a bounded window with a route back to the first page', async ({
  page,
  workspace,
}) => {
  test.setTimeout(60000);
  const keys = Array.from({ length: 400 }, (_, index) => ({
    id: `key_window_${String(index).padStart(4, '0')}`,
    name: `window-key-${String(index).padStart(4, '0')}`,
    prefix: 'fixture',
    scopes: ['resources:read'],
    resourceIds: ['*'],
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    lastUsedAt: null,
    revokedAt: null,
  }));
  workspace.state.keys = keys.slice(0, 100);
  workspace.state.keysNextCursor = 'keys-1';
  for (let pageNumber = 1; pageNumber <= 3; pageNumber++)
    workspace.setKeyPage(
      `keys-${pageNumber}`,
      keys.slice(pageNumber * 100, (pageNumber + 1) * 100),
      pageNumber < 3 ? `keys-${pageNumber + 1}` : null,
    );
  await workspace.open('#keys');
  for (let pageNumber = 0; pageNumber < 3; pageNumber++)
    await page.getByRole('button', { name: 'Load more keys' }).click();
  await expect(page.getByText('window-key-0000', { exact: true })).toHaveCount(0);
  await expect(page.getByText('window-key-0399', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to first keys' }).click();
  await expect(page.getByText('window-key-0000', { exact: true })).toBeVisible();
});

test('@visual empty collections share one in-context create action and readable TiUI presentation', async ({
  page,
  workspace,
}, testInfo) => {
  const presentations = [];
  for (const collection of collections) {
    await workspace.open(collection.hash);
    await expect(
      page.getByRole('heading', { level: 1, name: collection.title, exact: true }),
    ).toBeVisible();
    const empty = page.getByRole('region', { name: collection.empty, exact: true });
    const create = empty.getByRole('button', { name: collection.create, exact: true });
    if (process.env.QUICKSTART_SCREENSHOTS)
      await page.screenshot({
        path: `${process.env.QUICKSTART_SCREENSHOTS}/${collection.hash.slice(1)}-${testInfo.project.name}.png`,
        fullPage: true,
      });
    await page.getByRole('heading', { level: 1, name: collection.title, exact: true }).hover();
    if (presentations.length)
      await expect(create).toHaveCSS('background-color', presentations[0].background);
    await expect(page.getByRole('button', { name: collection.create, exact: true })).toHaveCount(1);
    await expect(create).toHaveCSS('height', '48px');
    await expect(create).toHaveCSS('font-size', '16px');
    presentations.push(
      await empty.evaluate((element) => {
        const state = getComputedStyle(element);
        const action = getComputedStyle(element.querySelector('button'));
        return {
          padding: state.padding,
          gap: state.gap,
          align: state.alignItems,
          background: action.backgroundColor,
          radius: action.borderRadius,
          font: action.fontSize,
        };
      }),
    );
    await create.click();
    await expect(page.getByRole('dialog')).toHaveAccessibleName(collection.dialog);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).press('Escape');
    await expect(create).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
  }
  expect(presentations[0]).toEqual(presentations[1]);
  await workspace.open('#overview');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Give your agent a place to work', exact: true }),
  ).toBeVisible();
  const startingChoices = page.getByRole('region', { name: 'Get started', exact: true });
  if (process.env.QUICKSTART_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.QUICKSTART_SCREENSHOTS}/overview-${testInfo.project.name}.png`,
      fullPage: true,
    });
  await expect(startingChoices.getByRole('button')).toHaveCount(2);
  await expect(startingChoices.getByRole('link', { name: 'Connect an agent' })).toHaveAttribute(
    'href',
    '#connect',
  );
  for (const collection of collections) {
    const create = startingChoices.getByRole('button', { name: collection.create, exact: true });
    await create.click();
    const dialog = page.getByRole('dialog', { name: collection.dialog, exact: true });
    await expect(dialog).toBeVisible();
    if (collection.hash === '#databases') await dialog.getByLabel(/^Database type:/).click();
    const kind = dialog.getByRole('combobox', { name: 'Resource type', exact: true });
    if (collection.hash === '#databases') {
      expect(
        await kind
          .locator('option')
          .evaluateAll((options) => options.map((option) => option.value)),
      ).toEqual(['mysql', 'postgresql', 'duckdb']);
    } else {
      await expect(kind).toHaveCount(0);
    }
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(create).toBeFocused();
  }
  await expect(page.getByRole('heading', { name: 'Workspace activity', exact: true })).toHaveCount(
    0,
  );
  await expect(startingChoices.locator('.live-dot')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Your resources' })).toHaveCount(0);
});

test('populated Overview stays focused on existing resources and keeps creation available', async ({
  page,
  workspace,
}) => {
  for (const existingKind of ['mysql', 'filesystem']) {
    workspace.state.resources = structuredClone(
      sampleResources.filter((resource) => resource.kind === existingKind),
    );
    await workspace.open('#overview');
    await page.reload();
    await expect(page.getByRole('region', { name: 'Get started' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create resource', exact: true })).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: 'Your resources' })
        .getByRole('link', { name: workspace.state.resources[0].name }),
    ).toBeVisible();
  }
});

test('Quick Start creates a database and reaches a first query result', async ({
  page,
  workspace,
}) => {
  await workspace.open('#overview');
  const guide = page.getByRole('region', { name: 'Get started' });
  await expect(guide.getByText('Need a database?')).toBeVisible();
  await guide.getByRole('button', { name: 'Create database', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a database' });
  await dialog.getByRole('button', { name: 'Create database', exact: true }).click();
  await expect(page).toHaveURL(/#databases\/fixture_mysql_0\/sql$/);
  const run = page.getByRole('button', { name: 'Run query', exact: true });
  await expect(run).toBeEnabled();
  expect(workspace.requests.filter((request) => request.path.endsWith('/queries'))).toHaveLength(0);
  await run.click();
  await expect(page.getByText('agent_started', { exact: true })).toBeVisible();
  expect(workspace.requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: `/api/portal/v1/workspaces/${workspace.state.workspace.id}/queries`,
        method: 'POST',
        body: expect.objectContaining({ resourceId: 'fixture_mysql_0' }),
      }),
    ]),
  );
});

test('Guest sees expiry and can use their own files from the sample entry', async ({
  page,
  workspace,
}) => {
  workspace.requireSignIn({ guestEnabled: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const guide = page.getByRole('region', { name: 'US sales agent task' });
  await expect(page.getByText(/Your Guest Workspace expires 24 hours/)).toBeVisible();
  await expect(guide.getByRole('button', { name: 'Prepare sample' })).toBeVisible();
  await page.goto('/#connect');
  await expect(page.getByRole('heading', { name: 'Connect an agent', level: 1 })).toBeVisible();
  await page.goto('/#overview');
  await guide.getByRole('link', { name: 'Use your own files' }).click();
  const empty = page.getByRole('region', { name: 'File Systems empty state' });
  await expect(empty.getByText(/Your Guest Workspace expires 24 hours/)).toBeVisible();
  await expect(empty.getByText('Preview and explore', { exact: true })).toBeVisible();
  await empty.getByRole('button', { name: 'Create file system' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a File System' });
  await dialog.getByRole('button', { name: 'Create file system', exact: true }).click();
  await expect(page).toHaveURL(/#files\?resourceId=fixture_filesystem_0$/);
  await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeVisible();
  expect(
    workspace.requests.some(
      (request) => request.path.endsWith('/resources') && request.body?.kind === 'filesystem',
    ),
  ).toBe(true);
});

test('@visual populated collections share metadata, exact-resource entry, connection and return actions', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  workspace.state.resources[0].name = 'mysql-resource-with-a-long-name-for-agents';
  workspace.state.resources[1].name = 'filesystem-resource-with-a-long-name-1234';
  for (const collection of collections) {
    const resource = workspace.state.resources.find((item) => item.id === collection.id);
    await workspace.open(collection.hash);
    const table = page.getByRole('table', { name: collection.table, exact: true });
    await expect(table.getByRole('columnheader')).toHaveText([
      'Name',
      'Provider location',
      'Status',
      'Service',
      'Actions',
    ]);
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table.getByText('Local demo', { exact: true })).toBeVisible();
    for (const text of ['active', 'Local demo']) {
      const label = table.getByText(text, { exact: true });
      await expect
        .poll(() => label.evaluate((element) => element.scrollWidth <= element.clientWidth))
        .toBe(true);
    }
    await table.getByRole('link', { name: `Open ${resource.name}`, exact: true }).click();
    await expect(page).toHaveURL(
      collection.id === 'db_fixture'
        ? /#databases\/db_fixture\/sql$/
        : /#files\?resourceId=fs_fixture$/,
    );
    const back = page.getByRole('button', {
      name: collection.id === 'db_fixture' ? 'All databases' : 'All file systems',
      exact: true,
    });
    await expect(back).toBeVisible();
    await expect(back).toBeEnabled();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await back.click();
    await expect(page).toHaveURL(new RegExp(`${collection.hash}$`));
    await expect(table).toBeVisible();
    await table.getByRole('button', { name: `Connect to ${resource.name}`, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveAccessibleName(`Connect to ${resource.name}`);
    await expect(page.getByRole('dialog')).toContainText('REGION_ACCESS_TOKEN');
    await expect(page.getByRole('dialog')).not.toContainText('$WORKSPACE_API_KEY');
    const command = await page.getByRole('dialog').locator('pre').innerText();
    expect(command).toContain(' \\\n');
    expect(command).not.toContain(' \\\\\n');
    await expect(
      page.getByRole('dialog').getByRole('link', { name: 'API documentation' }),
    ).toHaveAttribute('href', '#api');
    await page.getByRole('button', { name: 'Close dialog', exact: true }).press('Escape');
  }
  expect(
    workspace.requests.filter(
      (request) => request.method === 'POST' && /\/(?:resources|queries)$/.test(request.path),
    ),
  ).toEqual([]);
});

test('@visual Overview named resources open their exact workspaces without an intermediate collection', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.addResources();
  workspace.state.resources[0].name = 'Sales data';
  workspace.state.resources[1].name = 'Project files';
  workspace.state.profile.name = 'Developer';
  await workspace.open('#overview');
  const resources = page.getByRole('region', { name: 'Your resources' });
  await expect(resources.getByRole('link', { name: 'Project files', exact: true })).toBeVisible();
  await expect(resources.getByRole('link', { name: 'Sales data', exact: true })).toBeVisible();
  await expect(page.getByText('No resources yet', { exact: true })).toHaveCount(0);
  await expect(page.getByText('From workspace to workflow', { exact: true })).toHaveCount(0);
  await expect(page.getByText('WORKSPACE API', { exact: true })).toHaveCount(0);
  if (process.env.OVERVIEW_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.OVERVIEW_SCREENSHOTS}/overview-${testInfo.project.name}.png`,
      fullPage: true,
    });
  for (const [index, resource] of workspace.state.resources.entries()) {
    if (index) await workspace.open('#overview');
    const entry = page.getByRole('link', { name: resource.name, exact: true });
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(page).toHaveURL(
      resource.kind === 'filesystem'
        ? /#files\?resourceId=fs_fixture$/
        : /#databases\/db_fixture\/sql$/,
    );
  }
});

test('collections keep lifecycle failures, expiry and service context visible', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  Object.assign(workspace.state.resources[0], {
    provider: 'tidb-cloud-zero',
    status: 'expired',
    expiresAt: '2026-01-01T00:00:00Z',
    connectionError: 'Fixture database expired.',
  });
  Object.assign(workspace.state.resources[1], {
    provider: 'drive9-anonymous',
    status: 'failed',
    connectionError: 'Fixture file service unavailable.',
  });
  await workspace.open('#databases');
  const databases = page.getByRole('table', { name: 'Databases', exact: true });
  await expect(databases.getByText('expired', { exact: true })).toBeVisible();
  await expect(databases.getByText('Fixture database expired.', { exact: true })).toBeVisible();
  await expect(databases).toContainText('Expires');
  await expect(databases).toContainText('TiDB Cloud Zero · Trial');
  await workspace.open('#files');
  const files = page.getByRole('table', { name: 'File systems', exact: true });
  await expect(files.getByText('failed', { exact: true })).toBeVisible();
  await expect(files.getByText('Fixture file service unavailable.', { exact: true })).toBeVisible();
  await expect(files).toContainText('Drive9 · Anonymous trial');
  await workspace.open('#overview');
  const overview = page.getByRole('region', { name: 'Your resources' });
  await expect(overview.getByText('expired', { exact: true })).toBeVisible();
  await expect(overview.getByText('failed', { exact: true })).toBeVisible();
  await expect(overview.getByText('Fixture database expired.', { exact: true })).toBeVisible();
  await expect(
    overview.getByText('Fixture file service unavailable.', { exact: true }),
  ).toBeVisible();
});

test('Connect opens scoped Key creation directly and the empty Keys page has one create action', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  await workspace.open('#connect');
  await page.getByRole('button', { name: 'Create API key', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create API key', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/#connect$/);
  await expect(
    dialog.getByRole('checkbox', { name: 'filesystem-fixture', exact: true }),
  ).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'mysql-fixture', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await workspace.open('#keys');
  await expect(page.getByRole('button', { name: 'Create API key', exact: true })).toHaveCount(1);
  expect(
    workspace.requests.filter(
      (request) => request.method === 'POST' && request.path.endsWith('/keys'),
    ),
  ).toEqual([]);
});

test('@visual image preview displays bounded images and explains unavailable files', async ({
  page,
  context,
  workspace,
}, testInfo) => {
  workspace.addResources();
  workspace.state.resources[1].provider = 'drive9-anonymous';
  const imageBytes = await readFile(new URL('./fixtures/image-preview.png', import.meta.url));
  for (const [name, size] of [
    ['photo.png', imageBytes.length],
    ['large.jpg', 1048577],
    ['broken.gif', 12],
  ]) {
    workspace.state.files.push({
      id: name,
      resourceId: 'fs_fixture',
      path: `/${name}`,
      type: 'file',
      size,
      updatedAt: null,
    });
  }
  const pixel = imageBytes.toString('base64');
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith('/files/content')) return route.fallback();
    const path = url.searchParams.get('path');
    if (path === '/photo.png')
      return route.fulfill({
        json: {
          size: imageBytes.length,
          image: { mimeType: 'image/png', base64: pixel },
          unavailableReason: 'This image cannot be displayed by this version.',
        },
      });
    if (path === '/large.jpg')
      return route.fulfill({
        json: { size: 1048577, unavailableReason: 'This image exceeds the 1 MiB preview limit.' },
      });
    if (path === '/broken.gif')
      return route.fulfill({
        json: { size: 12, image: { mimeType: 'image/gif', base64: 'R0lGODlhAAAA' } },
      });
    return route.fallback();
  });
  await workspace.open('#files?resourceId=fs_fixture&path=%2Fphoto.png&view=source');
  const image = page.getByRole('img', { name: 'photo.png' });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((node) => node.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Edit source', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
  if (process.env.VISUAL_SCREENSHOTS)
    await page.screenshot({ path: testInfo.outputPath('image-preview.png') });
  await page.getByRole('button', { name: /^large\.jpg/ }).click();
  await expect(
    page.getByText(
      'This image exceeds the 1 MiB preview limit. Use Export to download the file and open it in another tool.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^broken\.gif/ }).click();
  await expect(
    page.getByText('This image could not be displayed.', { exact: false }),
  ).toBeVisible();
});

test('Overview directs paginated resource discovery to the full collections', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  workspace.state.resourceNextCursor = 'page-two';
  workspace.setResourcePage('page-two', [
    { ...structuredClone(sampleResources[1]), id: 'fs_later', name: 'Later files' },
  ]);
  await workspace.open('#overview');
  const resources = page.getByRole('region', { name: 'Your resources' });
  await expect(resources.getByText('More resources may be available.')).toBeVisible();
  await expect(resources.getByRole('link', { name: 'All file systems' })).toHaveAttribute(
    'href',
    '#files',
  );
  await expect(resources.getByRole('link', { name: 'All databases' })).toHaveAttribute(
    'href',
    '#databases',
  );
  await expect(page.getByRole('button', { name: 'Load more resources' })).toHaveCount(0);
});
