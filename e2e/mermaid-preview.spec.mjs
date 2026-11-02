import { test, expect } from './workspace-fixture.mjs';

test('@visual Markdown Mermaid diagrams render safely and preserve normal file reading', async ({
  page,
  workspace,
}, testInfo) => {
  workspace.addResources();
  workspace.state.resources[1].name = 'agent-files';
  const markdown = [
    '# Architecture',
    '',
    'Text before the diagram.',
    '',
    '```mermaid',
    'flowchart LR',
    '  Agent --> Workspace',
    '```',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  Agent->>Workspace: Request',
    '```',
    '',
    '```sql',
    'SELECT 1;',
    '```',
  ].join('\n');
  workspace.state.files[0].content = markdown;
  workspace.state.files[0].size = Buffer.byteLength(markdown);
  await workspace.open('#files?resourceId=fs_fixture');
  await page.getByRole('button', { name: /^README\.md/ }).click();
  await expect(page.getByRole('heading', { name: 'Architecture' })).toBeVisible();
  await expect(page.getByText('Text before the diagram.', { exact: true })).toBeVisible();
  const frames = page.frameLocator('iframe[title="Mermaid diagram"]');
  const frame = frames.first();
  await expect(page.locator('iframe[title="Mermaid diagram"]')).toHaveCount(2);
  await expect(frame.locator('svg')).toBeVisible({ timeout: 20000 });
  await expect(frames.nth(1).locator('svg')).toBeVisible({ timeout: 20000 });
  await expect(frames.nth(1).getByText('Request', { exact: true })).toBeVisible();
  await expect(frame.getByText('Agent', { exact: true })).toBeVisible();
  const colors = await frame.getByText('Agent', { exact: true }).evaluate((element) => ({
    text: getComputedStyle(element).fill,
    node: getComputedStyle(document.querySelector('g.node rect')).fill,
  }));
  const luminance = (color) => {
    const channels = color
      .match(/\d+/g)
      .slice(0, 3)
      .map((value) => {
        const component = Number(value) / 255;
        return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
      });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const [textLuminance, nodeLuminance] = [luminance(colors.text), luminance(colors.node)];
  expect(
    (Math.max(textLuminance, nodeLuminance) + 0.05) /
      (Math.min(textLuminance, nodeLuminance) + 0.05),
  ).toBeGreaterThan(4.5);
  await expect(frame.getByText('Workspace', { exact: true })).toBeVisible();
  const labelHeight = await frame
    .getByText('Agent', { exact: true })
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(labelHeight).toBeGreaterThanOrEqual(16);
  if (testInfo.project.name.startsWith('narrow')) {
    await expect(
      page.getByText('Scroll horizontally to see the full diagram.').first(),
    ).toBeVisible();
    const scroller = frame.locator('html');
    await scroller.evaluate((element) => {
      element.scrollLeft = 50;
    });
    await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await scroller.evaluate((element) => {
      element.scrollLeft = 0;
    });
  }
  await expect(page.locator('pre code.language-sql')).toContainText('SELECT 1');
  if (testInfo.project.name === 'desktop-light') {
    const before = await frame
      .locator('body')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.getByRole('combobox', { name: 'Color theme' }).selectOption('dark');
    await expect(frame.locator('svg')).toBeVisible({ timeout: 20000 });
    await expect
      .poll(() =>
        frame.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .not.toBe(before);
    await page.getByRole('combobox', { name: 'Color theme' }).selectOption('light');
    await expect(frame.locator('svg')).toBeVisible({ timeout: 20000 });
  }
  await expect(page.locator('iframe[title="Mermaid diagram"]').first()).toHaveAttribute(
    'sandbox',
    'allow-scripts',
  );
  if (process.env.VISUAL_SCREENSHOTS)
    await page.screenshot({ path: testInfo.outputPath('mermaid-preview.png') });
  await page.getByText('View diagram source').first().click();
  await expect(
    page.locator('details code').getByText('flowchart LR', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Edit source', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'File content' })).toHaveValue(markdown);
});

test('standalone, invalid and oversized diagrams offer usable fallbacks', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  for (const [name, content] of [
    ['flow.mmd', 'sequenceDiagram\n  Agent->>Workspace: Read'],
    ['broken.mmd', 'not a mermaid diagram'],
    ['large.mmd', ('a'.repeat(200) + '\n').repeat(100)],
    [
      'complex.mmd',
      'flowchart LR\n' +
        Array.from({ length: 201 }, (_, index) => `a${index} --> a${index + 1}`).join('\n'),
    ],
  ]) {
    workspace.state.files.push({
      id: name,
      resourceId: 'fs_fixture',
      path: `/${name}`,
      type: 'file',
      content,
      size: Buffer.byteLength(content),
      updatedAt: null,
    });
  }
  await workspace.open('#files?resourceId=fs_fixture');
  await page.getByRole('button', { name: /^flow\.mmd/ }).click();
  await expect(page.frameLocator('iframe[title="Mermaid diagram"]').locator('svg')).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole('button', { name: /^broken\.mmd/ }).click();
  await expect(page.getByText('This diagram could not be rendered.', { exact: false })).toBeVisible(
    { timeout: 20000 },
  );
  await page.getByText('View diagram source').click();
  await expect(
    page.locator('details code').getByText('not a mermaid diagram', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^large\.mmd/ }).click();
  await expect(page.getByText('This diagram exceeds the 20 KB preview limit.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^complex\.mmd/ }).click();
  await expect(page.getByText('This diagram could not be rendered.', { exact: false })).toBeVisible(
    { timeout: 20000 },
  );
});

test('untrusted Mermaid cannot load remote images or enable diagram links', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  const source = [
    '# Shared diagram',
    '',
    '```mermaid',
    '%%{init: {"htmlLabels": true, "securityLevel": "loose"}}%%',
    'flowchart LR',
    `A["<img src='https://example.com/tracker.png' onerror='alert(1)'>"] --> B[Safe]`,
    'click A "https://example.com/leave"',
    '```',
  ].join('\n');
  workspace.state.files[0].content = source;
  workspace.state.files[0].size = Buffer.byteLength(source);
  const external = [];
  page.on('request', (request) => {
    if (request.url().startsWith('https://example.com/')) external.push(request.url());
  });
  await workspace.open('#files?resourceId=fs_fixture');
  await page.getByRole('button', { name: /^README\.md/ }).click();
  const frame = page.frameLocator('iframe[title="Mermaid diagram"]');
  await expect(frame.locator('svg')).toBeVisible({ timeout: 20000 });
  await expect(frame.locator('img')).toHaveCount(0);
  await expect(frame.locator('a[href]')).toHaveCount(0);
  await expect(page.locator('iframe[title="Mermaid diagram"]')).toHaveAttribute(
    'sandbox',
    'allow-scripts',
  );
  expect(external).toEqual([]);
});

test('diagram image nodes cannot fetch remote content', async ({ page, workspace }) => {
  workspace.addResources();
  const source = [
    '# Remote image',
    '',
    '```mermaid',
    'flowchart LR',
    'A@{ img: "https://example.com/diagram-image.png", label: "Remote", w: 60, h: 60 }',
    '```',
  ].join('\n');
  workspace.state.files[0].content = source;
  workspace.state.files[0].size = Buffer.byteLength(source);
  const requests = [];
  page.on('request', (request) => {
    if (request.url().startsWith('https://example.com/')) requests.push(request);
  });
  await workspace.open('#files?resourceId=fs_fixture');
  await page.getByRole('button', { name: /^README\.md/ }).click();
  await expect(
    page.getByText('Images inside Mermaid diagrams are not supported.', { exact: false }),
  ).toBeVisible();
  await expect(page.locator('iframe[title="Mermaid diagram"]')).toHaveCount(0);
  await page.getByText('View diagram source').click();
  await expect(page.locator('details code')).toContainText('https://example.com/diagram-image.png');
  expect(requests).toHaveLength(0);
});

test('the published Studio subpath loads the isolated Mermaid renderer', async ({
  page,
  workspace,
}) => {
  workspace.addResources();
  const source = '# Diagram\n\n```mermaid\nflowchart LR\n  A --> B\n```';
  workspace.state.files[0].content = source;
  workspace.state.files[0].size = Buffer.byteLength(source);
  await page.goto('/studio/#files?resourceId=fs_fixture');
  await expect(page.getByRole('main')).toBeVisible();
  await page.getByRole('button', { name: /^README\.md/ }).click();
  const frame = page.frameLocator('iframe[title="Mermaid diagram"]');
  await expect(frame.locator('svg')).toBeVisible({ timeout: 20000 });
  await expect(frame.getByText('A', { exact: true })).toBeVisible();
});

test('ordinary Markdown does not load the Mermaid runtime', async ({ page, workspace }) => {
  workspace.addResources();
  const rendererRequests = [];
  page.on('request', (request) => {
    if (request.url().includes('/MermaidFrame-')) rendererRequests.push(request.url());
  });
  await workspace.open('#files?resourceId=fs_fixture');
  await page.getByRole('button', { name: /^README\.md/ }).click();
  await expect(page.getByRole('heading', { name: 'Fixture file' })).toBeVisible();
  expect(rendererRequests).toEqual([]);
});
