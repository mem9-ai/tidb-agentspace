import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expectedTotals,
  matchesTotals,
  orderRows,
  ordersCsv,
  totalsQuery,
  tutorialSample,
} from '../../src/features/portal/tutorial-data.ts';
import { productApiFixture } from './product-api-fixture.mjs';

test(
  'tutorial sample uses Rust import and file analysis APIs without losing data on restart',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const f = await productApiFixture(t, 'inProcess');
    const request = async (path, options = {}, status = 200) => {
      const result = await f.request(path, options);
      assert.equal(result.status, status, `${path}: ${JSON.stringify(result.body)}`);
      return result.body;
    };
    const sample = tutorialSample('a'.repeat(32));
    const parsing = { format: 'csv', header: 'true', delimiter: ',' };
    const preparation = await request(
      '/database-import-preparations?' +
        new URLSearchParams({ resourceId: 'db_live', filename: 'tutorial.csv', ...parsing }),
      {
        method: 'POST',
        raw: Buffer.from(ordersCsv),
        headers: { 'Content-Type': 'application/octet-stream' },
      },
      201,
    );
    assert.equal(preparation.rowCount, orderRows.length);
    assert.deepEqual(
      preparation.rows.map((row) => ({
        id: Number(row.id),
        region: row.region,
        amount: Number(row.amount),
      })),
      orderRows,
    );
    const before = f.provider.statements.length;
    const input = {
      resourceId: 'db_live',
      preparationId: preparation.id,
      confirmed: true,
      table: sample.table,
      fields: preparation.fields,
    };
    await request('/database-imports', { method: 'POST', body: input });
    const writes = f.provider.statements.slice(before);
    assert.equal(writes.length, 2);
    assert.ok(writes.every((statement) => statement.includes(sample.table)));
    await request('/database-imports', { method: 'POST', body: input }, 409);
    assert.equal(f.provider.statements.length, before + 2);

    await request('/files', {
      method: 'PUT',
      body: { resourceId: 'fs_shared', path: sample.path, type: 'file', content: ordersCsv },
    });
    const analysis = {
      resourceId: 'fs_shared',
      path: sample.path,
      engine: 'duckdb',
      sql: totalsQuery('file'),
    };
    const checkTotals = async () => {
      const result = await request('/file-analyses', { method: 'POST', body: analysis });
      assert.equal(result.readOnly, true);
      assert.deepEqual(
        result.rows.map((row) => ({ region: row.region, total: Number(row.total) })),
        expectedTotals,
      );
      assert.equal(matchesTotals(result.rows), true);
    };
    await checkTotals();
    const issued = await f.issueKey({
      name: 'tutorial-read-only',
      scopes: ['files:read'],
      resourceIds: ['fs_shared'],
      expiresInDays: 7,
    });
    assert.equal(issued.status, 201);
    await request(
      '/file-analyses',
      { method: 'POST', token: issued.body.secret, body: analysis },
      403,
    );
    await f.restart({ crash: true });
    await checkTotals();
    const files = await request('/files?resourceId=fs_shared&path=%2F');
    assert.equal(files.data.find((file) => file.path === sample.path).content, ordersCsv);
    assert.throws(() => tutorialSample('../orders'));
    assert.throws(() => tutorialSample('orders; DROP TABLE data;'));
    assert.equal(matchesTotals([{ region: 'AMER', total: 90 }]), false);
  },
);
