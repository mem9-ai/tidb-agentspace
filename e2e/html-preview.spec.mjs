import { test, expect } from './workspace-fixture.mjs';

test('@visual HTML opens as a styled page while keeping its source editable', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.addResources();
  const content =
    '<!doctype html><html><head><style>body { background: #f3eee6; color: #172437; font-family: sans-serif; padding: 24px; }</style></head><body><h1>Welcome to the workspace</h1><p>Build something useful.</p></body></html>';
  workspace.state.files.push({
    id: 'page',
    resourceId: 'fs_fixture',
    path: '/welcome.HTML',
    type: 'file',
    content,
    size: Buffer.byteLength(content),
    updatedAt: null,
  });
  await workspace.open('#files?resourceId=fs_fixture');
  await page.getByRole('button', { name: /^welcome\.HTML/ }).click();
  const frame = page.frameLocator('iframe[title="HTML preview"]');
  await expect(frame.getByRole('heading', { name: 'Welcome to the workspace' })).toBeVisible();
  await expect(frame.getByText('Build something useful.')).toBeVisible();
  await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(243, 238, 230)');
  await expect(page.getByText('Static preview:', { exact: false })).toBeVisible();
  if (process.env.VISUAL_SCREENSHOTS)
    await page.screenshot({ path: testInfo.outputPath('html-preview.png') });
  await page.getByRole('button', { name: 'Edit source', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'File content' })).toHaveValue(content);
  await page.getByRole('button', { name: 'Back to preview' }).click();
  await expect(frame.getByRole('heading', { name: 'Welcome to the workspace' })).toBeVisible();
});

test('@visual HTML without explicit colors follows the workspace theme', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.addResources();
  const content = '<!doctype html><html><body><h1>Page without custom colors</h1></body></html>';
  workspace.state.files.push({
    id: 'plain',
    resourceId: 'fs_fixture',
    path: '/plain.html',
    type: 'file',
    content,
    size: Buffer.byteLength(content),
    updatedAt: null,
  });
  await workspace.open('#files?resourceId=fs_fixture');
  await page.getByRole('button', { name: /^plain\.html/ }).click();
  const frame = page.frameLocator('iframe[title="HTML preview"]');
  await expect(frame.getByRole('heading', { name: 'Page without custom colors' })).toBeVisible();
  const html = frame.locator('html');
  const colors = () =>
    html.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      color: getComputedStyle(element).color,
      scheme: getComputedStyle(element).colorScheme,
    }));
  const initial = await colors();
  expect(initial.scheme).toBe(testInfo.project.metadata.theme);
  const channels = initial.background.match(/\d+/g).slice(0, 3).map(Number);
  const brightness = channels.reduce((sum, value) => sum + value, 0) / 3;
  if (testInfo.project.metadata.theme === 'dark') expect(brightness).toBeLessThan(80);
  else expect(brightness).toBeGreaterThan(200);
  if (process.env.VISUAL_SCREENSHOTS)
    await page.screenshot({ path: testInfo.outputPath('html-themed-preview.png') });
  await page
    .getByRole('combobox', { name: 'Color theme' })
    .selectOption(testInfo.project.metadata.theme === 'dark' ? 'light' : 'dark');
  await expect.poll(colors).not.toEqual(initial);
  await expect(frame.getByRole('heading', { name: 'Page without custom colors' })).toBeVisible();
});

test('HTML preview blocks scripts, navigation, external assets and oversized files', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  const content = `<!doctype html><html><head><style>@import url('https://example.com/style.css');</style><meta http-equiv="refresh" content="0;url=https://example.com/refresh"></head><body><h1>Safe content</h1><script>parent.document.body.innerHTML = 'PWNED'</script><img src="https://example.com/tracker.png" onerror="alert(1)"><a href="https://example.com/leave">Link</a><form action="https://example.com/submit"><button>Submit</button></form></body></html>`;
  for (const [name, source] of [
    ['unsafe.htm', content],
    ['large.html', ('a'.repeat(1023) + '\n').repeat(129)],
  ]) {
    workspace.state.files.push({
      id: name,
      resourceId: 'fs_fixture',
      path: `/${name}`,
      type: 'file',
      content: source,
      size: Buffer.byteLength(source),
      updatedAt: null,
    });
  }
  const blocked = [];
  const completed = [];
  page.on('requestfailed', (request) => {
    if (request.url().startsWith('https://example.com/'))
      blocked.push(request.failure()?.errorText);
  });
  page.on('requestfinished', (request) => {
    if (request.url().startsWith('https://example.com/')) completed.push(request.url());
  });
  await workspace.open('#files?resourceId=fs_fixture');
  await page.getByRole('button', { name: /^unsafe\.htm/ }).click();
  const frame = page.frameLocator('iframe[title="HTML preview"]');
  await expect(frame.getByRole('heading', { name: 'Safe content' })).toBeVisible();
  await expect(page.locator('iframe[title="HTML preview"]')).toHaveAttribute('sandbox', '');
  await expect(frame.locator('script, form, meta[http-equiv="refresh"], a[href]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'File System', exact: true })).toBeVisible();
  await expect.poll(() => blocked.length).toBeGreaterThanOrEqual(2);
  expect(blocked.every((reason) => reason === 'csp')).toBe(true);
  expect(completed).toEqual([]);
  await page.getByRole('button', { name: /^large\.html/ }).click();
  await expect(page.getByText('This file exceeds the 128 KiB preview limit.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
  await expect(page.locator('iframe[title="HTML preview"]')).toHaveCount(0);
});
