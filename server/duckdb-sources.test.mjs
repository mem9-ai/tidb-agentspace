import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DuckDBInstance } from '@duckdb/node-api';
import { createApp } from './regression-api.mjs';
import { seed } from './store.mjs';
import { openDuckdb } from './providers/duckdb-engine.mjs';
import { runDuckdbWorker } from './providers/duckdb.mjs';
import { parseSources, sourceLimits, stageSources } from './duckdb-sources.mjs';

const base = '/api/v1/workspaces/ws_agentlab';
const actions = ['queries:execute', 'files:read', 'files:analyze'];
const csv = 'id,region,amount\n9007199254740993,APAC,10\n2,APAC,20\n3,EU,20\n4,EU,\n';
const json =
  '[{"id":9007199254740993,"region":"APAC","amount":10},{"id":2,"region":"APAC","amount":20},{"id":3,"region":"EU","amount":20},{"id":4,"region":"EU","amount":null}]';
const source = (path = '/orders.csv', name = 'orders', resourceId = 'fs_source') => ({
  path,
  name,
  resourceId,
});
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'duckdb-file-query-test-'));
  const snapshots = join(dir, 'snapshots');
  await mkdir(snapshots);
  const dbPath = join(dir, 'database.duckdb');
  const engine = await openDuckdb({ localPath: dbPath });
  await engine.query('CREATE TABLE durable AS SELECT 2 AS id, 7 AS factor');
  engine.close();
  const csvPath = join(dir, 'orders.csv'),
    parquetPath = join(dir, 'orders.parquet');
  await writeFile(csvPath, csv);
  const builder = await DuckDBInstance.create(':memory:');
  const c = await builder.connect();
  await c.run(`COPY (SELECT * FROM read_csv('${csvPath}')) TO '${parquetPath}' (FORMAT PARQUET)`);
  c.closeSync();
  builder.closeSync();
  const files = new Map([
    ['/orders.csv', Buffer.from(csv)],
    ['/orders.json', Buffer.from(json)],
    ['/object.json', Buffer.from('{"region":"APAC","amount":30}')],
    ['/invalid.json', Buffer.from('{')],
    ['/orders.jsonl', Buffer.from(json.slice(1, -1).replaceAll('},{', '}\n{'))],
    ['/orders.parquet', await readFile(parquetPath)],
    ['/invalid.parquet', Buffer.from('invalid')],
    ['/empty.csv', Buffer.alloc(0)],
    ['/changed.csv', Buffer.from(csv)],
    ['/replaced.csv', Buffer.from(csv)],
    ['/huge.csv', Buffer.from(csv)],
    ['/growth.csv', Buffer.from(csv)],
    ['/slow.csv', Buffer.from(csv)],
    ["/x'); DROP TABLE durable;--.csv", Buffer.from(csv)],
  ]);
  const state = seed();
  state.resources.push(
    {
      id: 'db_source',
      name: 'analytics',
      kind: 'duckdb',
      status: 'active',
      provider: 'duckdb-drive9',
      region: 'aws-ap-southeast-1',
      createdAt: new Date().toISOString(),
    },
    ...['fs_source', 'fs_other'].map((id) => ({
      id,
      name: id,
      kind: 'filesystem',
      status: 'active',
      provider: 'drive9-anonymous',
      region: 'aws-ap-southeast-1',
      createdAt: new Date().toISOString(),
    })),
  );
  state.keys.push({
    id: 'expired',
    digest: createHash('sha256').update('expired-fixture').digest('hex'),
    resourceIds: ['*'],
    scopes: actions,
    expiresAt: '2000-01-01',
  });
  const dataFile = join(dir, 'state.json');
  await writeFile(dataFile, JSON.stringify(state));
  const artifact = join(dir, 'runtime');
  await writeFile(artifact, 'fixture-runtime');
  await writeFile(
    dataFile + '.duckdb.json',
    JSON.stringify({ bindings: { db_source: { storageId: 'hidden_storage', state: 'ready' } } }),
    { mode: 0o600 },
  );
  await writeFile(
    dataFile + '.providers.json',
    JSON.stringify({
      bindings: {
        hidden_storage: { apiKey: 'internal-database-fixture' },
        fs_source: { apiKey: 'internal-file-fixture' },
        fs_other: { apiKey: 'internal-other-fixture' },
      },
    }),
    { mode: 0o600 },
  );
  const io = [],
    workers = [],
    paths = [];
  let changed = 0,
    replaced = 0,
    afterRead,
    canceled = false;
  const app = await createApp({
    dataFile,
    duckdbSourceDirectory: snapshots,
    duckdbExtensionPath: artifact,
    duckdbExtensionSha256: createHash('sha256').update('fixture-runtime').digest('hex'),
    drive9Transport: async (url, input) => {
      const path = decodeURIComponent(new URL(url).pathname.slice('/v1/fs'.length));
      io.push({ path, method: input.method || 'GET' });
      assert.ok(
        ['Bearer internal-file-fixture', 'Bearer internal-other-fixture'].includes(
          input.headers.Authorization,
        ),
      );
      const bytes = files.get(path);
      if (!bytes) return new Response('', { status: 404 });
      if (input.method === 'HEAD')
        return new Response(null, {
          headers: {
            'Content-Length': String(
              path === '/huge.csv'
                ? sourceLimits.bytes + 1
                : path === '/growth.csv'
                  ? 1
                  : bytes.length,
            ),
            'X-Dat9-Revision': String(path === '/changed.csv' ? ++changed : 1),
            'X-Dat9-Resource-ID': path === '/replaced.csv' ? String(++replaced) : 'stable-file',
          },
        });
      if (afterRead) await afterRead();
      if (path === '/slow.csv')
        return new Response(
          new ReadableStream({
            start(controller) {
              input.signal.addEventListener('abort', () => {
                canceled = true;
                controller.error(Error('aborted'));
              });
            },
            cancel() {
              canceled = true;
            },
          }),
        );
      return new Response(bytes);
    },
    duckdbExecute: async ({ sql, sources, probe, signal, limits, connection }) => {
      if (probe) return {};
      workers.push(sql);
      assert.equal(connection.apiKey, 'internal-database-fixture');
      assert.ok(!JSON.stringify(sources || []).includes('internal-file-fixture'));
      for (const source of sources || []) {
        assert.equal((await stat(source.path)).mode & 0o777, 0o600);
        assert.equal((await stat(join(source.path, '..'))).mode & 0o777, 0o700);
        paths.push(source.path);
      }
      return runDuckdbWorker({ connection: { localPath: dbPath }, sql, sources, signal, limits });
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.address().port}`;
  const session = await fetch(origin + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  t.after(async () => {
    await new Promise((resolve) => app.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  async function request(path, method = 'GET', body, token, signal) {
    const r = await fetch(origin + (path.startsWith('/api/') ? path : base + path), {
      method,
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() };
  }
  const key = async (scopes = actions, resourceIds = ['db_source', 'fs_source']) => {
    const r = await request('/keys', 'POST', {
      name: 'source-verification',
      scopes,
      resourceIds,
      expiresInDays: 7,
    });
    assert.equal(r.status, 201);
    return r.body;
  };
  const query = (sources, sql = 'SELECT * FROM files.orders', token, signal) =>
    request('/queries', 'POST', { resourceId: 'db_source', sql, sources }, token, signal);
  return {
    dir,
    snapshots,
    files,
    io,
    workers,
    paths,
    request,
    key,
    query,
    afterRead: (callback) => {
      afterRead = callback;
    },
    canceled: () => canceled,
  };
}

test('file queries use native CSV/JSON/NDJSON/Parquet, exact integers, NULLs, joins and query-only catalogs', async (t) => {
  const f = await fixture(t),
    key = await f.key();
  for (const suffix of ['csv', 'json', 'jsonl', 'parquet']) {
    const r = await f.query(
      [source('/orders.' + suffix)],
      'SELECT region,SUM(amount) AS total,COUNT(amount)::INTEGER AS count FROM files.orders GROUP BY region ORDER BY region',
      key.secret,
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.rows, [
      { region: 'APAC', total: '30', count: 2 },
      { region: 'EU', total: '20', count: 1 },
    ]);
    assert.equal(
      (
        await f.query(
          [source('/orders.' + suffix)],
          "SELECT id FROM files.orders WHERE region='APAC' ORDER BY id DESC LIMIT 1",
          key.secret,
        )
      ).body.rows[0].id,
      '9007199254740993',
    );
  }
  assert.deepEqual(
    (await f.query([source('/object.json')], 'SELECT * FROM files.orders', key.secret)).body.rows,
    [{ region: 'APAC', amount: '30' }],
  );
  const precise = await f.query(
    [source()],
    "SELECT id FROM files.orders WHERE region='APAC' ORDER BY id DESC LIMIT 1",
    key.secret,
  );
  assert.equal(precise.body.rows[0].id, '9007199254740993');
  const joined = await f.query(
    [source(), source('/orders.json', 'other', 'fs_other')],
    'SELECT a.amount*d.factor AS amount FROM files.orders a JOIN files.other b USING(id) JOIN durable d USING(id)',
    (await f.key(actions, ['db_source', 'fs_source', 'fs_other'])).secret,
  );
  assert.equal(joined.status, 200);
  assert.equal(joined.body.rows[0].amount, '140');
  assert.equal(
    (
      await f.query(
        [source("/x'); DROP TABLE durable;--.csv")],
        'SELECT COUNT(*)::INTEGER AS n FROM files.orders',
      )
    ).body.rows[0].n,
    4,
  );
  assert.equal((await f.query([], 'INSERT INTO durable VALUES (3,8)')).status, 200);
  const ordinary = await f.query([], 'SELECT * FROM durable ORDER BY id');
  assert.equal(ordinary.body.rowCount, 2);
  assert.equal((await f.query([], 'SELECT * FROM files.orders')).status, 422);
  assert.deepEqual(await readdir(f.snapshots), []);
  for (const path of f.paths) await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.deepEqual(f.files.get('/orders.csv'), Buffer.from(csv));
});

test('every action/resource/workspace/key denial precedes source and native I/O, including hidden storage', async (t) => {
  const f = await fixture(t);
  for (const action of actions) {
    const key = await f.key(actions.filter((a) => a !== action));
    assert.equal((await f.query([source()], undefined, key.secret)).status, 403);
  }
  for (const resources of [['db_source'], ['fs_source']])
    assert.equal(
      (await f.query([source()], undefined, (await f.key(actions, resources)).secret)).status,
      403,
    );
  assert.equal(
    (
      await f.query(
        [source(), source('/orders.json', 'other', 'fs_other')],
        undefined,
        (await f.key()).secret,
      )
    ).status,
    403,
  );
  const wildcard = await f.key(actions, ['*']);
  assert.equal(
    (await f.query([source('/orders.csv', 'orders', 'hidden_storage')], undefined, wildcard.secret))
      .status,
    404,
  );
  assert.equal(
    (await f.query([source('/orders.csv', 'orders', 'db_source')], undefined, wildcard.secret))
      .status,
    404,
  );
  assert.equal(
    (
      await f.request(
        '/api/v1/workspaces/other/queries',
        'POST',
        { resourceId: 'db_source', sql: 'SELECT 1', sources: [source()] },
        wildcard.secret,
      )
    ).status,
    404,
  );
  assert.equal((await f.query([source()], undefined, 'expired-fixture')).status, 401);
  await f.request('/keys/' + wildcard.data.id, 'DELETE');
  assert.equal((await f.query([source()], undefined, wildcard.secret)).status, 401);
  assert.deepEqual(f.io, []);
  assert.deepEqual(f.workers, []);
  assert.equal(
    (
      await f.request('/queries', 'POST', {
        resourceId: 'db_memory',
        sql: 'SELECT 1',
        sources: [source()],
      })
    ).body.error.code,
    'SOURCES_REQUIRE_DUCKDB',
  );
  assert.deepEqual(f.io, []);
});

test('selected-file SQL is native SELECT only and cannot read host/network, write, attach or alter security', async (t) => {
  const f = await fixture(t);
  for (const sql of [
    'CREATE TABLE leaked AS SELECT * FROM files.orders',
    'INSERT INTO durable VALUES(99,99)',
    'DELETE FROM files.orders',
    "COPY files.orders TO '/tmp/leaked.csv'",
    "ATTACH ':memory:' AS other",
    'SET enable_external_access=true',
    "CREATE SECRET leak (TYPE http, BEARER_TOKEN 'leak')",
    "SELECT * FROM read_csv('/etc/passwd')",
    "SELECT * FROM read_json('https://example.com/private')",
    "SELECT * FROM read_parquet('tidbfs:///another.parquet')",
    "SELECT * FROM read_text('/tmp/*')",
    "SELECT * FROM query('DELETE FROM durable RETURNING *')",
  ]) {
    const r = await f.query([source()], sql);
    assert.ok([403, 422].includes(r.status), sql + ': ' + JSON.stringify(r.body));
    assert.ok(!JSON.stringify(r.body).includes('internal-file-fixture'));
    assert.ok(!JSON.stringify(r.body).includes(f.dir));
  }
  assert.equal((await f.query([source()], 'SELECT 1; SELECT 2')).status, 400);
  assert.equal((await f.query([], 'SELECT COUNT(*)::INTEGER AS n FROM durable')).body.rows[0].n, 1);
  assert.deepEqual(await readdir(f.snapshots), []);
});

test('invalid source manifests fail before I/O; input growth, revision change, invalid formats and result limits clean snapshots', async (t) => {
  const f = await fixture(t);
  for (const sources of [
    null,
    {},
    [source(), source()],
    Array(5).fill(source()),
    [source('/../orders.csv')],
    [source('/orders*.csv')],
    [source('/orders.csv', 'bad.name')],
    [{ ...source(), token: 'not-accepted' }],
  ])
    assert.equal((await f.query(sources)).status, 400);
  assert.equal((await f.query([source('/orders.exe')])).status, 415);
  assert.deepEqual(f.io, []);
  for (const [path, status] of [
    ['/huge.csv', 413],
    ['/growth.csv', 409],
    ['/changed.csv', 409],
    ['/replaced.csv', 409],
    ['/empty.csv', 422],
    ['/missing.csv', 404],
    ['/invalid.parquet', 422],
    ['/invalid.json', 422],
  ]) {
    const r = await f.query([source(path)]);
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.deepEqual(await readdir(f.snapshots), []);
  }
  assert.ok(!f.io.some((call) => call.path === '/huge.csv' && call.method === 'GET'));
  assert.equal(
    (await f.query([source()], 'SELECT * FROM range(1001)')).body.error.code,
    'RESULT_TOO_LARGE',
  );
  assert.equal(
    (await f.query([source()], "SELECT repeat('x',1048577) AS big")).body.error.code,
    'RESULT_TOO_LARGE',
  );
  assert.deepEqual(await readdir(f.snapshots), []);
});

test('revocation during file load discards data before engine I/O; repeated queries reauthorize', async (t) => {
  const f = await fixture(t),
    key = await f.key();
  f.afterRead(async () => {
    await f.request('/keys/' + key.data.id, 'DELETE');
  });
  assert.equal((await f.query([source()], undefined, key.secret)).status, 401);
  assert.deepEqual(f.workers, []);
  assert.deepEqual(await readdir(f.snapshots), []);
  f.afterRead(undefined);
  assert.equal((await f.query([source()], undefined, key.secret)).status, 401);
  assert.equal(f.io.length, 2); // one preflight HEAD and one GET; no post-revocation read
});

test('disconnect cancels a stalled source stream, releases admission and cleans its private directory', async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  const pending = f.query([source('/slow.csv')], undefined, undefined, controller.signal);
  pending.catch(() => {});
  t.after(() => controller.abort());
  for (
    let i = 0;
    i < 200 && !f.io.some((call) => call.path === '/slow.csv' && call.method === 'GET');
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(f.io.some((call) => call.path === '/slow.csv' && call.method === 'GET'));
  assert.equal((await f.query([source()])).status, 429);
  controller.abort();
  await assert.rejects(pending);
  for (let i = 0; i < 100 && !f.canceled(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.canceled(), true);
  for (let i = 0; i < 100 && (await readdir(f.snapshots)).length; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await readdir(f.snapshots), []);
  assert.equal((await f.query([source()])).status, 200);
});

test('file loading shares the 15-second query deadline and leaves no snapshot or admitted operation', async (t) => {
  const f = await fixture(t),
    started = performance.now();
  const r = await f.query([source('/slow.csv')]);
  assert.equal(r.status, 504);
  assert.equal(r.body.error.code, 'SQL_TIMEOUT');
  assert.ok(
    performance.now() - started < 18_000,
    'loading must use the SQL deadline, not the provider 30-second timeout',
  );
  assert.equal(f.canceled(), true);
  assert.deepEqual(f.workers, []);
  assert.deepEqual(await readdir(f.snapshots), []);
  assert.equal((await f.query([source()])).status, 200);
});

test('stream byte bounds and abort clean staged snapshots, including combined preflight rejection', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'source-stage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inputs = parseSources([source(), source('/orders.json', 'other')]).map((source) => ({
    ...source,
    resource: { provider: 'drive9-anonymous' },
  }));
  let reads = 0;
  const options = {
    directory: dir,
    authorize: () => {},
    readState: () => ({ files: [] }),
    drive9: {
      stat: async () => ({ size: sourceLimits.bytes, directory: false }),
      read: async () => {
        reads++;
        return new Response('x');
      },
    },
  };
  await assert.rejects(stageSources(inputs, options), { code: 'SOURCE_TOO_LARGE' });
  assert.equal(reads, 0);
  options.drive9.stat = async () => ({ size: 1, directory: false });
  options.drive9.read = async () => new Response(Buffer.alloc(sourceLimits.bytes + 1));
  await assert.rejects(stageSources(inputs.slice(0, 1), options), { code: 'SOURCE_TOO_LARGE' });
  assert.deepEqual(await readdir(dir), []);
});
