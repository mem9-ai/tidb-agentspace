import { test, expect } from './workspace-fixture.mjs';

const csv = 'state,sales_usd\nCalifornia,120\nTexas,80\n';

function addSalesFile(workspace, path = '/us-sales.csv') {
  workspace.addResources();
  workspace.state.files.push({
    id: 'sales-fixture',
    resourceId: 'fs_fixture',
    path,
    type: 'file',
    content: csv,
    size: Buffer.byteLength(csv),
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

async function mockFileWork(context, { onPrepare, onExport }) {
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/files/tabular-preview'))
      return route.fulfill({
        json: {
          resourceId: 'fs_fixture',
          path: url.searchParams.get('path'),
          format: url.searchParams.get('path')?.endsWith('.parquet') ? 'parquet' : 'csv',
          readOnly: true,
          inputBytes: csv.length,
          durationMs: 1,
          fileVersion: 'a'.repeat(64),
          columns: ['state', 'sales_usd'],
          columnTypes: ['VARCHAR', 'BIGINT'],
          schema: [
            { column_name: 'state', column_type: 'VARCHAR' },
            { column_name: 'sales_usd', column_type: 'BIGINT' },
          ],
          rows: [{ state: 'California', sales_usd: 120 }],
          rowCount: 1,
          totalRows: null,
          typesInferred: true,
          truncated: false,
        },
      });
    if (url.pathname.endsWith('/file-export-preparations') && request.method() === 'POST') {
      onPrepare.push(request.postDataJSON());
      return route.fulfill({
        status: 201,
        json: {
          id: 'prepared-sales',
          status: 'ready',
          createdAt: '2026-01-01T00:00:00Z',
          expiresAt: '2099-01-01T00:00:00Z',
          fields: [
            { source: 'state', name: 'state', type: 'TEXT' },
            { source: 'sales_usd', name: 'sales_usd', type: 'BIGINT' },
          ],
          rows: [{ state: 'California', sales_usd: 120 }],
          rowCount: 2,
          sourceVersion: 'fixture-version',
          inputBytes: csv.length,
          format: request.postDataJSON().parsing.format,
        },
      });
    }
    if (url.pathname.endsWith('/file-exports') && request.method() === 'POST') {
      onExport.push(request.postDataJSON());
      return route.fulfill({
        json: {
          kind: 'database',
          resourceId: 'db_fixture',
          table: 'imported_us_sales',
          rowCount: 2,
          columns: [
            { name: 'state', type: 'TEXT' },
            { name: 'sales_usd', type: 'BIGINT' },
          ],
        },
      });
    }
    return route.fallback();
  });
}

test('@visual create a table from a saved CSV after explicitly reviewing its data', async ({
  page,
  context,
  workspace,
}, testInfo) => {
  addSalesFile(workspace);
  workspace.state.resources[0].provider = 'tidb-cloud-zero';
  const preparations = [];
  const exports = [];
  await mockFileWork(context, { onPrepare: preparations, onExport: exports });
  await workspace.open('#files?resourceId=fs_fixture&path=%2Fus-sales.csv&view=preview');
  await page.getByRole('button', { name: 'Create table', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create table from file' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/the file remains unchanged/)).toBeVisible();
  await expect(dialog.getByText('Parsing options · CSV · Comma · Header row')).toBeVisible();
  await expect(dialog.getByLabel('Destination', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Confirm and create table' })).toBeDisabled();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  expect(preparations).toHaveLength(0);
  expect(exports).toHaveLength(0);
  if (process.env.FILE_TO_TABLE_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.FILE_TO_TABLE_SCREENSHOTS}/entry-${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  await dialog.getByLabel('Database', { exact: true }).selectOption('db_fixture');
  await dialog.getByRole('button', { name: 'Parse and review' }).click();
  await expect(dialog.getByRole('region', { name: 'Parsed import sample' })).toContainText(
    'California',
  );
  expect(preparations).toEqual([
    {
      source: { kind: 'original', resourceId: 'fs_fixture', path: '/us-sales.csv' },
      parsing: { format: 'csv', header: true, delimiter: ',' },
    },
  ]);
  expect(exports).toHaveLength(0);
  if (process.env.FILE_TO_TABLE_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.FILE_TO_TABLE_SCREENSHOTS}/${testInfo.project.name}.png`,
      animations: 'disabled',
    });
  await dialog.getByRole('button', { name: 'Confirm and create table' }).click();
  await expect(dialog.getByText('Table created')).toBeVisible();
  await expect(dialog.getByText('2 rows imported.')).toBeVisible();
  expect(exports).toEqual([
    {
      preparationId: 'prepared-sales',
      confirmed: true,
      fields: [
        { source: 'state', name: 'state', type: 'TEXT' },
        { source: 'sales_usd', name: 'sales_usd', type: 'BIGINT' },
      ],
      target: { kind: 'database', resourceId: 'db_fixture', table: 'imported_us_sales' },
    },
  ]);
  expect(workspace.state.files.find((file) => file.path === '/us-sales.csv').content).toBe(csv);
  await expect(dialog.getByRole('link', { name: 'Open table' })).toBeVisible();
});

test('Parquet starts with the matching format and prepares the saved source', async ({
  page,
  context,
  workspace,
}) => {
  addSalesFile(workspace, '/us-sales.parquet');
  workspace.state.resources[0].provider = 'tidb-cloud-zero';
  const preparations = [];
  const exports = [];
  await mockFileWork(context, { onPrepare: preparations, onExport: exports });
  await workspace.open('#files?resourceId=fs_fixture&path=%2Fus-sales.parquet&view=preview');
  await page.getByRole('button', { name: 'Create table', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create table from file' });
  await dialog.getByText('Parsing options · Parquet').click();
  await expect(dialog.getByLabel('Input format')).toHaveValue('parquet');
  await dialog.getByRole('button', { name: 'Parse and review' }).click();
  await expect(dialog.getByRole('region', { name: 'Parsed import sample' })).toBeVisible();
  expect(preparations).toEqual([
    {
      source: { kind: 'original', resourceId: 'fs_fixture', path: '/us-sales.parquet' },
      parsing: { format: 'parquet' },
    },
  ]);
  expect(exports).toHaveLength(0);
});

test('changing parsing options invalidates the reviewed data before table creation', async ({
  page,
  context,
  workspace,
}) => {
  addSalesFile(workspace);
  workspace.state.resources[0].provider = 'tidb-cloud-zero';
  const preparations = [];
  const exports = [];
  await mockFileWork(context, { onPrepare: preparations, onExport: exports });
  await workspace.open('#files?resourceId=fs_fixture&path=%2Fus-sales.csv&view=preview');
  await page.getByRole('button', { name: 'Create table', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create table from file' });
  await dialog.getByLabel('Database', { exact: true }).selectOption('db_fixture');
  await dialog.getByText('Parsing options · CSV · Comma · Header row').click();
  await dialog.getByLabel('Separator').selectOption(';');
  await dialog.getByLabel('First row contains column names').uncheck();
  await dialog.getByRole('button', { name: 'Parse and review' }).click();
  await expect(dialog.getByRole('button', { name: 'Confirm and create table' })).toBeEnabled();
  expect(preparations[0].parsing).toEqual({ format: 'csv', header: false, delimiter: ';' });
  await dialog.getByLabel('Separator').selectOption('|');
  await expect(dialog.getByRole('button', { name: 'Confirm and create table' })).toBeDisabled();
  await expect(dialog.getByRole('region', { name: 'Parsed import sample' })).toHaveCount(0);
  expect(exports).toHaveLength(0);
});

test('table creation remains explicit when there is no database or when the file has a draft', async ({
  page,
  context,
  workspace,
}) => {
  addSalesFile(workspace);
  const preparations = [];
  const exports = [];
  await mockFileWork(context, { onPrepare: preparations, onExport: exports });
  await workspace.open('#files?resourceId=fs_fixture&path=%2Fus-sales.csv&view=preview');
  await page.getByRole('button', { name: 'Create table', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create table from file' });
  await expect(dialog.getByText('No active database is available.')).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Open databases' })).toHaveAttribute(
    'href',
    '#databases',
  );
  await dialog.getByRole('link', { name: 'Open databases' }).click();
  await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
  await page.goto('/#files?resourceId=fs_fixture&path=%2Fus-sales.csv&view=preview');
  await page.getByRole('button', { name: 'Edit source', exact: true }).click();
  await page.getByRole('textbox', { name: 'File content', exact: true }).fill('unsaved draft');
  await expect(page.getByRole('button', { name: 'Create table', exact: true })).toHaveCount(0);
  expect(preparations).toHaveLength(0);
  expect(exports).toHaveLength(0);
});
