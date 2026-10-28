import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './index.mjs';
import { seed } from './store.mjs';
import { openDuckdb } from './providers/duckdb-engine.mjs';
import { runDuckdbWorker } from './providers/duckdb.mjs';
import { browseDuckdb } from './duckdb-browser.mjs';

const base = '/api/v1/workspaces/ws_agentlab';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-duckdb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const artifact = join(dir, 'extension');
  await writeFile(artifact, 'test-only-artifact');
  const digest = createHash('sha256').update('test-only-artifact').digest('hex');
  const dataFile = join(dir, 'state.json');
  const initial = seed();
  initial.keys.push({
    id: 'expired',
    digest: createHash('sha256').update('expired-token').digest('hex'),
    scopes: ['queries:execute'],
    resourceIds: ['*'],
    expiresAt: '2000-01-01',
  });
  await writeFile(dataFile, JSON.stringify(initial));
  let creates = 0,
    failProvision = false,
    failSetup = false,
    release;
  const calls = [];
  let app, origin, cookie;
  const options = {
    dataFile,
    filesProvider: 'local',
    mysqlProvider: 'local',
    duckdbExtensionPath: artifact,
    duckdbExtensionSha256: digest,
    drive9Transport: async (url, input) => {
      if (url.endsWith('/v1/provision')) {
        creates++;
        if (failProvision) throw Error('lost response');
        return Response.json({
          tenant_id: 'tenant-' + creates,
          api_key: 'private-duck-' + creates,
        });
      }
      assert.ok(input.headers.Authorization.startsWith('Bearer private-duck-'));
      return Response.json({
        status: 'active',
        max_upload_bytes: 1048576,
        inline_threshold: 1048576,
      });
    },
    duckdbExecute: async ({ connection, sql, probe, readOnly }) => {
      if (probe) return {};
      calls.push(sql);
      if (failSetup)
        throw Object.assign(Error('safe test setup failure'), {
          code: 'TEST_SETUP_FAILED',
          status: 503,
        });
      if (release) await release;
      const engine = await openDuckdb({
        localPath: join(dir, connection.apiKey + '.duckdb'),
        readOnly,
      });
      try {
        return await engine.query(sql);
      } finally {
        engine.close();
      }
    },
  };
  async function start(override = {}) {
    app = await createApp({ ...options, ...override });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${app.address().port}`;
    const r = await fetch(origin + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    cookie = r.headers.get('set-cookie').split(';')[0];
  }
  await start();
  t.after(async () => {
    await new Promise((r) => app.close(r));
  });
  async function request(path, method = 'GET', body, token, extraHeaders = {}) {
    const r = await fetch(origin + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...extraHeaders,
        ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() };
  }
  const create = (name = 'analytics') =>
    request(base + '/resources', 'POST', { name, kind: 'duckdb', region: 'aws-ap-southeast-1' });
  const query = (id, sql, token) =>
    request(base + '/queries', 'POST', { resourceId: id, sql }, token);
  const key = async (scopes, resourceIds) => {
    const r = await request(base + '/keys', 'POST', {
      name: 'test-key',
      scopes,
      resourceIds,
      expiresInDays: 7,
    });
    assert.equal(r.status, 201);
    return r.body;
  };
  return {
    dir,
    dataFile,
    artifact,
    request,
    create,
    query,
    key,
    calls,
    get creates() {
      return creates;
    },
    set failProvision(v) {
      failProvision = v;
    },
    set failSetup(v) {
      failSetup = v;
    },
    set wait(v) {
      release = v;
    },
    restart: async () => {
      await new Promise((r) => app.close(r));
      await start();
    },
  };
}

test('DuckDB owns hidden storage; all public surfaces and wildcard file/key access conceal it', async (t) => {
  const f = await fixture(t),
    created = await f.create();
  assert.equal(created.status, 201);
  assert.equal(created.body.data.status, 'active');
  const id = created.body.data.id;
  const vault = JSON.parse(await readFile(f.dataFile + '.duckdb.json'));
  const storageId = vault.bindings[id].storageId;
  for (const path of ['/bootstrap', '/resources', '/usage', '/events', '/keys']) {
    const r = await f.request(base + path);
    assert.equal(r.status, 200);
    assert.ok(!JSON.stringify(r.body).includes(storageId));
    assert.ok(!JSON.stringify(r.body).includes('private-duck-'));
  }
  const all = await f.key(
    ['resources:read', 'files:read', 'files:write', 'files:analyze', 'queries:execute'],
    ['*'],
  );
  for (const token of [undefined, all.secret]) {
    assert.equal(
      (await f.request(base + `/files?resourceId=${storageId}`, 'GET', undefined, token)).status,
      404,
    );
    assert.equal(
      (
        await f.request(
          base + `/files/content?resourceId=${storageId}&path=/workspace.duckdb`,
          'GET',
          undefined,
          token,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request(
          base + '/files',
          'PUT',
          { resourceId: storageId, path: '/x', type: 'file', content: 'x' },
          token,
        )
      ).status,
      404,
    );
    const beforeAnalysis = f.calls.length;
    assert.equal(
      (
        await f.request(
          base + `/file-analyses/capabilities?resourceId=${storageId}&path=/workspace.duckdb`,
          'GET',
          undefined,
          token,
        )
      ).status,
      404,
    );
    for (const resourceId of [storageId, id])
      assert.equal(
        (
          await f.request(
            base + '/file-analyses',
            'POST',
            { resourceId, path: '/orders.csv', engine: 'duckdb', sql: 'SELECT * FROM file' },
            token,
          )
        ).status,
        404,
      );
    assert.equal(f.calls.length, beforeAnalysis);
    assert.equal((await f.query(storageId, 'SELECT 1', token)).status, 404);
  }
  assert.equal(
    (
      await f.request(base + '/keys', 'POST', {
        name: 'hidden',
        scopes: ['files:read'],
        resourceIds: [storageId],
        expiresInDays: 7,
      })
    ).status,
    400,
  );
  assert.equal((await f.request(base + '/resources')).body.data.length, 3);
  assert.equal(f.creates, 1);
});

test('same Workspace Key runs persistent DuckDB and permitted MySQL/Files; scope/resource/workspace and revocation are enforced', async (t) => {
  const f = await fixture(t),
    id = (await f.create()).body.data.id;
  const key = await f.key(
    ['queries:execute', 'files:read', 'files:write'],
    [id, 'db_memory', 'fs_shared'],
  );
  assert.equal(
    (await f.query(id, 'CREATE TABLE items(id BIGINT PRIMARY KEY, note VARCHAR)', key.secret))
      .status,
    200,
  );
  assert.equal(
    (await f.query(id, "INSERT INTO items VALUES (9007199254740993,'hello')", key.secret)).body
      .affectedRows,
    1,
  );
  await f.restart();
  const result = await f.query(id, 'SELECT * FROM items', key.secret);
  assert.equal(result.body.rows[0].id, '9007199254740993');
  assert.equal(result.body.mode, 'live');
  assert.equal((await f.query('db_memory', 'SELECT 1', key.secret)).status, 200);
  assert.equal(
    (
      await f.request(
        base + '/files',
        'PUT',
        { resourceId: 'fs_shared', path: '/duck.txt', type: 'file', content: 'same key' },
        key.secret,
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.request(base + `/resources/${id}/table?name=items`, 'GET', undefined, key.secret)).body
      .columns[0].name,
    'id',
  );
  const second = (await f.create('second-analytics')).body.data.id;
  const count = f.calls.length;
  assert.equal((await f.query(second, 'SELECT 1', key.secret)).status, 403);
  assert.equal((await f.query(id, 'SELECT 1', 'expired-token')).status, 401);
  const wrong = await f.key(['queries:execute'], ['db_memory']),
    missing = await f.key(['resources:read'], [id]);
  assert.equal((await f.query(id, 'SELECT 1', wrong.secret)).status, 403);
  assert.equal((await f.query(id, 'SELECT 1', missing.secret)).status, 403);
  assert.equal(
    (
      await f.request(
        '/api/v1/workspaces/other/queries',
        'POST',
        { resourceId: id, sql: 'SELECT 1' },
        key.secret,
      )
    ).status,
    404,
  );
  assert.equal(
    (await f.request(base + `/resources/${id}/tables`, 'GET', undefined, wrong.secret)).status,
    403,
  );
  await f.request(base + '/keys/' + key.data.id, 'DELETE');
  assert.equal((await f.query(id, 'SELECT 1', key.secret)).status, 401);
  for (const suffix of ['tables', 'table?name=items', 'table/rows?name=items']) {
    for (const [token, status] of [
      [key.secret, 401],
      ['expired-token', 401],
      [wrong.secret, 403],
      [missing.secret, 403],
    ])
      assert.equal(
        (await f.request(base + `/resources/${id}/${suffix}`, 'GET', undefined, token)).status,
        status,
      );
  }
  assert.equal(
    (
      await f.request(
        '/api/v1/workspaces/other/resources/' + id + '/tables',
        'GET',
        undefined,
        wrong.secret,
      )
    ).status,
    404,
  );
  assert.equal(f.calls.length, count);
});

test('partial setup and restart reuse a private store; an uncertain provision is never blindly repeated', async (t) => {
  const f = await fixture(t);
  f.failSetup = true;
  const r = await f.create();
  const id = r.body.data.id;
  assert.equal(r.body.data.status, 'provisioning');
  f.failSetup = false;
  await f.restart();
  assert.equal(
    (await f.request(base + `/resources/${id}/setup`, 'POST')).body.data.status,
    'active',
  );
  assert.equal(f.creates, 1);
  f.failProvision = true;
  const lost = await f.create('uncertain');
  assert.equal(lost.body.data.status, 'provisioning');
  await f.restart();
  assert.equal(
    (await f.request(base + `/resources/${lost.body.data.id}/setup`, 'POST')).body.data.status,
    'provisioning',
  );
  assert.equal(f.creates, 2);
});

test('unavailable or changed runtime fails closed before provisioning or executing', async (t) => {
  const f = await fixture(t);
  await writeFile(f.artifact, 'changed');
  const created = await f.create();
  assert.equal(created.status, 503);
  assert.equal(f.creates, 0);
  // A newly started API discovers the mismatch before resource reservation or cloud I/O.
  await f.restart();
  const count = f.creates;
  assert.equal((await f.create('unavailable')).status, 503);
  assert.equal(f.creates, count);
});

test('native SQL parsing, output bounds, precise values and host/config/credential restrictions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'duckdb-engine-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const engine = await openDuckdb({ localPath: join(dir, 'db') });
  t.after(() => engine.close());
  await engine.query('CREATE TABLE data(id INT PRIMARY KEY, label VARCHAR)');
  await engine.query("INSERT INTO data VALUES(1,'x')");
  assert.equal((await engine.query("UPDATE data SET label='updated'")).affectedRows, 1);
  assert.equal(
    (await engine.query('SELECT 9007199254740993::BIGINT AS exact')).rows[0].exact,
    '9007199254740993',
  );
  for (const sql of [
    "SELECT * FROM read_text('/etc/hosts')",
    "SELECT * FROM read_csv('https://example.com/x.csv')",
    'SET enable_external_access=true',
    "LOAD 'untrusted'",
    "ATTACH '/tmp/other' AS other",
    'CREATE SECRET other(TYPE http)',
    'DROP SECRET workspace_storage',
    "COPY data TO '/tmp/stolen.csv'",
    'PRAGMA enable_profiling',
  ])
    await assert.rejects(engine.query(sql), (error) =>
      ['SQL_PERMISSION_DENIED', 'SQL_OBJECT_NOT_FOUND'].includes(error.code),
    );
  await assert.rejects(engine.query('SELECT 1; DELETE FROM data'), { code: 'INVALID_SQL' });
  assert.equal((await engine.query('SELECT * FROM data')).rowCount, 1);
  await assert.rejects(engine.query('SELECT * FROM range(1001)'), { code: 'RESULT_TOO_LARGE' });
  await assert.rejects(engine.query("SELECT repeat('x',1048577)"), { code: 'RESULT_TOO_LARGE' });
  await assert.rejects(engine.query('BROKEN SQL'), { code: 'SQL_PERMISSION_DENIED' });
  const execute = (sql) => engine.query(sql);
  await engine.query('CREATE INDEX by_label ON data(label)');
  const detail = await browseDuckdb({
    resource: { status: 'active' },
    action: 'table',
    name: 'data',
    execute,
  });
  assert.equal(detail.columns[0].key, 'PRI');
  assert.ok(detail.indexes.some((x) => x.name === 'by_label'));
  assert.equal(
    (await browseDuckdb({ resource: { status: 'active' }, action: 'rows', name: 'data', execute }))
      .rows[0].label,
    'updated',
  );
});

test('separate native worker persists a database and deadlines terminate execution', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'duckdb-worker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const connection = { localPath: join(dir, 'db') };
  const badExtension = join(dir, 'bad-extension');
  await writeFile(badExtension, 'not a native library');
  await assert.rejects(runDuckdbWorker({ extensionPath: badExtension, probe: true }), {
    code: 'DUCKDB_RUNTIME_UNAVAILABLE',
  });
  await runDuckdbWorker({ connection, sql: 'CREATE TABLE persisted AS SELECT 42 AS value' });
  assert.equal(
    (await runDuckdbWorker({ connection, sql: 'SELECT * FROM persisted' })).rows[0].value,
    42,
  );
  await assert.rejects(
    runDuckdbWorker({
      connection,
      sql: 'SELECT sum(a.i*b.i) FROM range(10000000) a(i), range(10000000) b(i)',
      limits: { rows: 1000, bytes: 1048576, sqlBytes: 65536, timeoutMs: 100 },
    }),
    { code: 'SQL_TIMEOUT' },
  );
});

test('idempotent concurrent creation, resource isolation and per-database admission', async (t) => {
  const f = await fixture(t);
  const createSame = () =>
    f.request(
      base + '/resources',
      'POST',
      { name: 'idempotent', kind: 'duckdb', region: 'aws-ap-southeast-1' },
      undefined,
      { 'Idempotency-Key': 'duck-one' },
    );
  const [first, replayed] = await Promise.all([createSame(), createSame()]);
  assert.equal(first.body.data.id, replayed.body.data.id);
  assert.equal(f.creates, 1);
  await f.restart();
  assert.equal((await createSame()).body.data.id, first.body.data.id);
  assert.equal(f.creates, 1);
  const second = await f.create('another');
  assert.notEqual(first.body.data.id, second.body.data.id);
  const vault = JSON.parse(await readFile(f.dataFile + '.duckdb.json'));
  assert.notEqual(
    vault.bindings[first.body.data.id].storageId,
    vault.bindings[second.body.data.id].storageId,
  );
  await f.query(first.body.data.id, 'CREATE TABLE only_first(value INT)');
  assert.equal((await f.query(second.body.data.id, 'SELECT * FROM only_first')).status, 422);
  let release;
  f.wait = new Promise((r) => {
    release = r;
  });
  const running = f.query(first.body.data.id, 'SELECT 1');
  while (!f.calls.at(-1)?.includes('SELECT 1')) await new Promise((r) => setTimeout(r, 1));
  try {
    assert.equal((await f.query(first.body.data.id, 'SELECT 2')).status, 429);
  } finally {
    release();
  }
  await running;
});
