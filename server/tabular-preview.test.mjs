import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { createApp } from './index.mjs';
import { seed } from './store.mjs';
import { createFileAnalysis } from './file-analysis.mjs';
import { analysisLimits } from './file-analysis-contract.mjs';
const resource = { id: 'fs_shared', kind: 'filesystem', status: 'active' };
const input = { resourceId: resource.id, path: '/orders.csv' };
const csv = Buffer.from('id,region,amount\n1,"APAC, east",10\n2,"EU\nwest",20\n');
const service = (bytes, options = {}) =>
  createFileAnalysis({ snapshot: async () => ({ bytes, size: bytes.length }), ...options });

test('fixed CSV preview shares SQL parsing, infers types, bounds rows, and versions saved bytes', async () => {
  const a = service(csv);
  const preview = await a.preview(resource, input);
  assert.deepEqual(preview.columns, ['id', 'region', 'amount']);
  assert.deepEqual(preview.columnTypes, ['BIGINT', 'VARCHAR', 'BIGINT']);
  assert.equal(preview.rows[0].region, 'APAC, east');
  assert.equal(preview.rows[1].region, 'EU\nwest');
  assert.equal(preview.totalRows, null);
  assert.equal(preview.typesInferred, true);
  assert.equal(preview.truncated, false);
  const result = await a.execute(resource, {
    ...input,
    engine: 'duckdb',
    sql: 'SELECT * FROM file',
  });
  assert.deepEqual(preview.rows, result.rows);
  assert.equal(preview.fileVersion, result.fileVersion);
  assert.notEqual(
    (await service(Buffer.from('n\n99\n')).preview(resource, input)).fileVersion,
    result.fileVersion,
  );
  const many = await service(
    Buffer.from('id\n' + Array.from({ length: 100 }, (_, i) => i).join('\n')),
  ).preview(resource, input);
  assert.equal(many.rowCount, 20);
  assert.equal(many.rows.length, 20);
  assert.equal(many.truncated, true);
  assert.equal(many.totalRows, null);
});

test('Parquet preview reports exact metadata count and typed sample, including an empty table', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tabular-fixture-'));
  const db = await DuckDBInstance.create(':memory:');
  const connection = await db.connect();
  try {
    for (const n of [0, 37]) {
      const path = join(directory, `orders-${n}.parquet`);
      await connection.run(
        `COPY (SELECT i::BIGINT AS id, 'APAC' AS region FROM range(${n}) t(i)) TO '${path}' (FORMAT PARQUET)`,
      );
      const result = await service(await readFile(path)).preview(resource, {
        ...input,
        path: '/orders.parquet',
      });
      assert.equal(result.totalRows, String(n));
      assert.equal(result.typesInferred, false);
      assert.equal(result.rowCount, Math.min(n, 20));
      assert.equal(result.truncated, n > 20);
      assert.deepEqual(result.columnTypes, ['BIGINT', 'VARCHAR']);
    }
  } finally {
    connection.closeSync();
    db.closeSync();
    await rm(directory, { recursive: true, force: true });
  }
});

test('preview rejects injected computation, unsupported/oversized inputs, wide schema and excessive output', async () => {
  let reads = 0;
  const a = service(csv, {
    snapshot: async () => {
      reads++;
      return { bytes: csv };
    },
  });
  for (const extra of [{ sql: 'SELECT 1' }, { engine: 'duckdb' }, { limit: 1000 }])
    await assert.rejects(a.preview(resource, { ...input, ...extra }), { code: 'INVALID_PREVIEW' });
  await assert.rejects(a.preview(resource, { ...input, path: '/secret.db' }), {
    code: 'UNSUPPORTED_PREVIEW',
  });
  assert.equal(reads, 0);
  await assert.rejects(
    service(Buffer.alloc(analysisLimits.inputBytes + 1)).preview(resource, input),
    { code: 'ANALYSIS_INPUT_LIMIT' },
  );
  const wide = Buffer.from(
    Array.from({ length: 51 }, (_, i) => `c${i}`).join(',') + '\n' + Array(51).fill('1').join(','),
  );
  await assert.rejects(service(wide).preview(resource, input), { code: 'PREVIEW_COLUMN_LIMIT' });
  await assert.rejects(
    service(Buffer.from('value\n' + 'x'.repeat(140000))).preview(resource, input),
    { code: 'ANALYSIS_OUTPUT_LIMIT' },
  );
  await assert.rejects(
    service(Buffer.from('not parquet')).preview(resource, { ...input, path: '/bad.parquet' }),
    { code: 'ANALYSIS_FAILED' },
  );
});

test('preview and analysis share admission, clean snapshots on failure, and recover from cancellation', async () => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let directory;
  let runs = 0;
  const a = service(csv, {
    limits: { ...analysisLimits, concurrency: 1 },
    runner: async (job, signal) => {
      if (++runs > 1) return { rowCount: 0 };
      directory = job.directory;
      entered();
      await new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Canceled')), { once: true }),
      );
    },
  });
  const controller = new AbortController();
  const pending = a.preview(resource, input, controller.signal);
  await started;
  await assert.rejects(a.execute(resource, { ...input, engine: 'duckdb', sql: 'SELECT 1' }), {
    code: 'ANALYSIS_BUSY',
  });
  controller.abort();
  await assert.rejects(pending, { code: 'ANALYSIS_CANCELED' });
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  const recovered = await a.preview(resource, input);
  assert.equal(recovered.rowCount, 0);
});

test('tabular preview authorizes read and resource before I/O; preview access never permits custom analysis', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'preview-api-'));
  const dataFile = join(directory, 'state.json');
  const state = seed();
  for (const [secret, fields] of [
    ['read', { scopes: ['files:read'] }],
    ['compute', { scopes: ['files:analyze'] }],
    ['other', { scopes: ['files:read'], resourceIds: ['db_memory'] }],
    ['expired', { scopes: ['files:read'], expiresAt: '2000-01-01' }],
    ['revoked', { scopes: ['files:read'], revokedAt: new Date().toISOString() }],
  ])
    state.keys.push({
      id: secret,
      digest: createHash('sha256').update(secret).digest('hex'),
      scopes: [],
      resourceIds: ['fs_shared'],
      expiresAt: '2099-01-01',
      ...fields,
    });
  await writeFile(dataFile, JSON.stringify(state));
  let io = 0;
  const app = await createApp({
    dataFile,
    filesProvider: 'local',
    mysqlProvider: 'local',
    analysisSnapshot: async () => {
      io++;
      return { bytes: csv, size: csv.length };
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${app.address().port}`;
  const base = '/api/v1/workspaces/ws_agentlab';
  const path = '/files/tabular-preview?resourceId=fs_shared&path=/orders.csv';
  const get = (secret, route = base + path) =>
    fetch(origin + route, { headers: { Authorization: `Bearer ${secret}` } });
  for (const [secret, status] of [
    ['compute', 403],
    ['other', 403],
    ['expired', 401],
    ['revoked', 401],
    ['invalid', 401],
  ])
    assert.equal((await get(secret)).status, status);
  assert.equal((await get('read', '/api/v1/workspaces/other' + path)).status, 404);
  assert.equal((await get('read', base + path + '&sql=SELECT%201')).status, 400);
  assert.equal(
    (await get('read', base + '/files/tabular-preview?resourceId=fs_shared&path=/../orders.csv'))
      .status,
    400,
  );
  assert.equal(io, 0);
  const response = await get('read');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).rows[1].region, 'EU\nwest');
  assert.equal(io, 1);
  const run = await fetch(origin + base + '/file-analyses', {
    method: 'POST',
    headers: { Authorization: 'Bearer read', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, engine: 'duckdb', sql: 'SELECT 1' }),
  });
  assert.equal(run.status, 403);
  assert.equal(io, 1);
});
