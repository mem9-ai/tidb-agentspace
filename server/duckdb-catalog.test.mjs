import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDuckdbCatalog } from './providers/duckdb-catalog.mjs';
import { runDuckdbWorker } from './providers/duckdb.mjs';
import { browseDuckdb } from './duckdb-browser.mjs';
import { sqlLimits } from './providers/sql-common.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'duckdb-catalog-'));
  const children = [];
  const reader = createDuckdbCatalog({
    disposable: runDuckdbWorker,
    ...options,
    launch(...args) {
      const child = fork(...args);
      children.push(child);
      return child;
    },
  });
  t.after(async () => {
    await reader.close();
    await rm(dir, { recursive: true, force: true });
  });
  const input = (key, sql, extra = {}) => ({
    key,
    connection: { localPath: join(dir, key) },
    sql,
    ...extra,
  });
  for (const key of ['first', 'second'])
    await runDuckdbWorker(
      input(key, "CREATE TABLE items(id INT PRIMARY KEY, label VARCHAR UNIQUE DEFAULT 'new')"),
    );
  return {
    reader,
    children,
    input,
    read: (sql, key = 'first', extra) => reader.query(input(key, sql, extra)),
  };
}

test('table details use one bounded catalog statement and reuse the list reader', async (t) => {
  const f = await fixture(t);
  const browse = (action, name = 'items') =>
    browseDuckdb({ resource: { status: 'active' }, action, name, execute: f.read });
  assert.equal((await browse('tables')).data[0].name, 'items');
  const detail = await browse('table');
  assert.deepEqual(
    detail.columns.map((c) => [c.name, c.key, c.nullable]),
    [
      ['id', 'PRI', false],
      ['label', 'UNI', true],
    ],
  );
  assert.equal(detail.columns[1].default, "'new'");
  assert.equal(detail.indexes.length, 2);
  assert.equal((await browse('rows')).rowCount, 0);
  assert.equal(f.children.length, 1, 'list, details and preview share one native open');
  await assert.rejects(browse('table', "missing'; --"), { code: 'TABLE_NOT_FOUND' });
  // Catalog results are not cached: release the reader before ordinary SQL, then see fresh schema.
  await f.reader.invalidateIdle();
  await runDuckdbWorker(f.input('first', 'ALTER TABLE items ADD COLUMN active BOOLEAN'));
  assert.equal((await browse('table')).columns[2].name, 'active');
  assert.equal(f.children.length, 2);
});

test('quoted names, views, composite constraints and explicit indexes keep their contract', async (t) => {
  const f = await fixture(t);
  for (const sql of [
    `CREATE TABLE "odd'""name"("a""x" INT, b INT, PRIMARY KEY("a""x", b))`,
    `CREATE UNIQUE INDEX "by value" ON "odd'""name"(b)`,
    'CREATE VIEW items_view AS SELECT id FROM items',
  ])
    await runDuckdbWorker(f.input('first', sql));
  let calls = 0;
  const execute = (sql) => {
    calls++;
    return f.read(sql);
  };
  const detail = await browseDuckdb({
    resource: { status: 'active' },
    action: 'table',
    name: `odd'"name`,
    execute,
  });
  assert.equal(calls, 1);
  assert.deepEqual(
    detail.indexes[0].columns.map((c) => c.name),
    ['a"x', 'b'],
  );
  assert.equal(detail.indexes[1].name, 'by value');
  assert.deepEqual(
    detail.indexes[1].columns.map((c) => c.name),
    ['b'],
  );
  const view = await browseDuckdb({
    resource: { status: 'active' },
    action: 'table',
    name: 'items_view',
    execute,
  });
  assert.equal(view.type, 'VIEW');
  assert.deepEqual(view.indexes, []);
});

test('readers are read-only, isolated by database, and disposed on failures without retry', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.read('SELECT count(*) AS n FROM items')).rows[0].n, '0');
  await assert.rejects(f.read('CREATE TABLE forbidden AS SELECT 1'), {
    code: 'SQL_PERMISSION_DENIED',
  });
  assert.equal(f.children.length, 1);
  await f.read('SELECT 1');
  assert.equal(f.children.length, 2);
  await f.read('SELECT 1', 'second');
  assert.equal(f.children.length, 3, 'a different database never reuses the previous connection');
  await assert.rejects(f.read('SELECT * FROM missing', 'second'), { code: 'SQL_OBJECT_NOT_FOUND' });
  assert.equal(f.children.length, 3, 'a failed request is not retried');
  await f.read('SELECT 1', 'second');
  assert.equal(f.children.length, 4);
});

test('deadline, cancellation, idle eviction and shutdown dispose native readers', async (t) => {
  const f = await fixture(t, { idleMs: 100 });
  await f.read('SELECT 1');
  const idleExit = once(f.children.at(-1), 'exit');
  await idleExit;
  await f.read('SELECT 1');
  await assert.rejects(
    f.read('SELECT sum(a.i*b.i) FROM range(10000000) a(i), range(10000000) b(i)', 'first', {
      limits: { ...sqlLimits, timeoutMs: 50 },
    }),
    { code: 'SQL_TIMEOUT' },
  );
  await f.read('SELECT 1');
  const controller = new AbortController();
  const running = f.read(
    'SELECT sum(a.i*b.i) FROM range(10000000) a(i), range(10000000) b(i)',
    'first',
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(running, { code: 'SQL_CANCELED' });
  await f.read('SELECT 1');
  const child = f.children.at(-1),
    exited = once(child, 'exit');
  await f.reader.close();
  await exited;
  assert.ok(child.killed);
});

test('maximum reader age expires even while successive requests keep it warm', async (t) => {
  const f = await fixture(t, { idleMs: 10_000, maxAgeMs: 2_000 });
  await f.read('SELECT 1');
  const child = f.children.at(-1),
    exited = once(child, 'exit');
  await f.read('SELECT 2');
  await exited;
  await f.read('SELECT 3');
  assert.equal(f.children.length, 2);
});

test('another database uses a disposable reader while the reusable reader is busy; shutdown aborts active work', async (t) => {
  let disposableCalls = 0;
  const f = await fixture(t, {
    disposable(input) {
      disposableCalls++;
      assert.equal(input.readOnly, true);
      return runDuckdbWorker(input);
    },
  });
  await f.read('SELECT 1');
  const running = f.read('SELECT sum(a.i*b.i) FROM range(10000000) a(i), range(10000000) b(i)');
  const rejected = assert.rejects(running, { code: 'SQL_CANCELED' });
  assert.equal((await f.read('SELECT 42 AS n', 'second')).rows[0].n, 42);
  assert.equal(disposableCalls, 1);
  assert.equal(f.children.length, 1);
  await f.reader.close();
  await rejected;
});
