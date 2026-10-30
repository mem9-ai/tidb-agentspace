import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createApp } from './regression-api.mjs';
import { seed } from './store.mjs';
import { createZero } from './providers/zero.mjs';
import {
  resultCollector,
  sanitizeSqlError,
  sqlLimits,
  validateBinding,
} from './providers/sql-common.mjs';

const base = '/api/v1/workspaces/ws_agentlab';
const internalPassword = 'private-zero-admin-password';
const expiry = () => new Date(Date.now() + 30 * 86400000).toISOString();
function fakeZero() {
  let creates = 0,
    failCreation = false,
    failSetup = false;
  const calls = [];
  return {
    calls,
    get creates() {
      return creates;
    },
    set failCreation(value) {
      failCreation = value;
    },
    set failSetup(value) {
      failSetup = value;
    },
    async transport(url, options) {
      creates++;
      assert.equal(url, 'https://zero.tidbapi.com/v1beta1/instances');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, undefined);
      if (failCreation) throw new Error(internalPassword);
      return new Response(
        JSON.stringify({
          instance: {
            id: 'private-instance-' + creates,
            connection: {
              host: 'test.tidbcloud.com',
              port: 4000,
              username: '12345678901234567890.root',
              password: internalPassword,
            },
            expiresAt: expiry(),
            claimInfo: { claimUrl: 'https://tidbcloud.com/private-claim' },
          },
        }),
      );
    },
    async execute(connection, sql) {
      calls.push({ user: connection.user, sql });
      if (connection.password === internalPassword) {
        if (failSetup) throw new Error(internalPassword);
        if (sql.startsWith('CREATE USER') || sql.startsWith('GRANT')) {
          const username = /'([^']+)'@/.exec(sql)?.[1];
          assert.ok(username.startsWith('12345678901234567890.'));
          assert.ok(username.length <= 32);
          assert.ok(!sql.includes('ALL PRIVILEGES'));
        }
        return { columns: [], rows: [], rowCount: 0, affectedRows: 0 };
      }
      assert.equal(connection.database, 'workspace');
      return sql.startsWith('UPDATE')
        ? { columns: [], rows: [], rowCount: 0, affectedRows: 2 }
        : { columns: ['connected'], rows: [{ connected: 1 }], rowCount: 1, affectedRows: 0 };
    },
  };
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-zero-'));
  const dataFile = join(dir, 'workspace.json');
  const initial = seed();
  initial.resources.push({
    id: 'db_legacy_pg',
    kind: 'postgresql',
    name: 'legacy-pg',
    region: 'aws-us-east-1',
    status: 'active',
  });
  initial.keys.push({
    id: 'expired',
    digest: createHash('sha256').update('expired-token').digest('hex'),
    scopes: ['queries:execute'],
    resourceIds: ['*'],
    expiresAt: '2000-01-01',
  });
  await writeFile(dataFile, JSON.stringify(initial));
  const provider = fakeZero();
  let server, origin, cookie;
  async function start() {
    server = await createApp({
      dataFile,
      filesProvider: 'local',
      mysqlProvider: 'tidb-cloud-zero',
      zeroTransport: provider.transport,
      sqlExecute: provider.execute,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(origin + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    cookie = response.headers.get('set-cookie').split(';')[0];
  }
  await start();
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  async function request(path, method = 'GET', input, key, headers = {}) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: 'Bearer ' + key } : { Cookie: cookie }),
        ...headers,
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    const body = await response.json();
    for (const value of [
      internalPassword,
      'private-instance-',
      'private-claim',
      'test.tidbcloud.com',
    ])
      assert.ok(!JSON.stringify(body).includes(value));
    return { status: response.status, body };
  }
  const create = (id = 'request-one', name = 'zero-memory') =>
    request(base + '/resources', 'POST', { kind: 'mysql', region: 'automatic', name }, undefined, {
      'Idempotency-Key': id,
    });
  const key = async (scopes, resourceIds) =>
    (
      await request(base + '/keys', 'POST', {
        name: 'test-agent',
        scopes,
        resourceIds,
        expiresInDays: 7,
      })
    ).body;
  const query = (id, key, sql = 'SELECT 1') =>
    request(base + '/queries', 'POST', { resourceId: id, sql }, key);
  return {
    dataFile,
    provider,
    request,
    create,
    key,
    query,
    async restart() {
      await new Promise((resolve) => server.close(resolve));
      await start();
    },
  };
}

test('Zero creation is idempotent across concurrency/restart; public metadata excludes internal credentials', async (t) => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.create(), f.create()]);
  assert.equal(first.status, 201);
  assert.equal(first.body.data.status, 'active');
  assert.equal(first.body.data.id, second.body.data.id);
  assert.equal(f.provider.creates, 1);
  const id = first.body.data.id;
  assert.ok(first.body.data.expiresAt);
  const vault = JSON.parse(await readFile(f.dataFile + '.databases.json', 'utf8'));
  assert.equal(vault.bindings[id].state, 'ready');
  assert.equal(vault.bindings[id].admin, undefined);
  assert.notEqual(vault.bindings[id].connection.password, internalPassword);
  assert.ok(!(await readFile(f.dataFile, 'utf8')).includes(vault.bindings[id].connection.password));
  await f.restart();
  assert.equal((await f.create()).body.data.id, id);
  assert.equal(f.provider.creates, 1);
  const result = await f.query(id);
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, 'live');
  assert.equal((await f.query(id, undefined, 'UPDATE tasks SET done = true')).body.affectedRows, 2);
  assert.equal((await f.create('request-one', 'changed-name')).status, 409);
  const discovery = await f.request(base + '/resources');
  assert.deepEqual(discovery.body.capabilities.mysql.regions, ['automatic']);
  assert.equal(discovery.body.capabilities.mysql.storageGiB, null);
  assert.equal(
    (await f.request(base + '/usage')).body.data.find((r) => r.resourceId === id).storageBytes,
    null,
  );
});

test('one scoped key uses Zero and files while authorization blocks provider I/O on denied requests', async (t) => {
  const f = await fixture(t);
  const id = (await f.create()).body.data.id;
  const both = await f.key(['queries:execute', 'files:read'], [id, 'fs_shared']);
  assert.equal((await f.query(id, both.secret)).status, 200);
  assert.equal(
    (await f.request(base + '/files?resourceId=fs_shared', 'GET', undefined, both.secret)).status,
    200,
  );
  const calls = f.provider.calls.length;
  const read = await f.key(['resources:read'], [id]);
  const unrelated = await f.key(['queries:execute', 'resources:write'], ['db_memory']);
  assert.equal((await f.query(id, read.secret)).status, 403);
  assert.equal((await f.query(id, unrelated.secret)).status, 403);
  assert.equal(
    (await f.request(base + '/resources/' + id + '/setup', 'POST', undefined, unrelated.secret))
      .status,
    403,
  );
  assert.equal((await f.query(id, 'expired-token')).status, 401);
  assert.equal(
    (
      await f.request(
        '/api/v1/workspaces/other/queries',
        'POST',
        { resourceId: id, sql: 'SELECT 1' },
        both.secret,
      )
    ).status,
    404,
  );
  await f.request(base + '/keys/' + both.data.id, 'DELETE');
  assert.equal((await f.query(id, both.secret)).status, 401);
  assert.equal(f.provider.calls.length, calls);
});

test('uncertain creation never issues a second Zero POST, including after restart or setup retry', async (t) => {
  const f = await fixture(t);
  f.provider.failCreation = true;
  const first = await f.create();
  const id = first.body.data.id;
  assert.equal(first.body.data.status, 'failed');
  assert.ok(first.body.data.connectionError);
  await f.restart();
  f.provider.failCreation = false;
  assert.equal((await f.create()).body.data.id, id);
  assert.equal(
    (await f.request(base + '/resources/' + id + '/setup', 'POST')).body.data.status,
    'failed',
  );
  assert.equal(f.provider.creates, 1);
  assert.equal((await f.query(id)).status, 409);
  assert.equal(f.provider.calls.length, 0);
});

test('interrupted SQL setup resumes the persisted instance and app password; admin credentials never execute customer SQL', async (t) => {
  const f = await fixture(t);
  f.provider.failSetup = true;
  const first = await f.create();
  const id = first.body.data.id;
  assert.equal(first.body.data.status, 'provisioning');
  const prior = JSON.parse(await readFile(f.dataFile + '.databases.json', 'utf8')).bindings[id];
  f.provider.failSetup = false;
  await f.restart();
  const result = await f.request(base + '/resources/' + id + '/setup', 'POST');
  assert.equal(result.body.data.status, 'active');
  const after = JSON.parse(await readFile(f.dataFile + '.databases.json', 'utf8')).bindings[id];
  assert.equal(after.connection.password, prior.connection.password);
  assert.equal(after.admin, undefined);
  assert.equal(f.provider.creates, 1);
  await f.query(id, undefined, 'SELECT private_test');
  assert.equal(f.provider.calls.at(-1).user, after.connection.user);
});

test('expired Zero instances return 410 without queries or replacement provisioning', async (t) => {
  const f = await fixture(t);
  const id = (await f.create()).body.data.id;
  const file = f.dataFile + '.databases.json';
  const vault = JSON.parse(await readFile(file, 'utf8'));
  vault.bindings[id].expiresAt = '2000-01-01T00:00:00.000Z';
  await writeFile(file, JSON.stringify(vault));
  await f.restart();
  const calls = f.provider.calls.length;
  assert.equal((await f.query(id)).status, 410);
  assert.equal(
    (await f.request(base + '/resources')).body.data.find((r) => r.id === id).status,
    'expired',
  );
  assert.equal((await f.create()).body.data.status, 'expired');
  assert.equal(f.provider.creates, 1);
  assert.equal(f.provider.calls.length, calls);
});

test('PG is retired from discovery, creation, key grants and SQL without deleting persisted records', async (t) => {
  const f = await fixture(t);
  const bootstrap = await f.request(base + '/bootstrap');
  assert.equal(
    bootstrap.body.resources.some((r) => r.kind === 'postgresql'),
    false,
  );
  assert.equal(bootstrap.body.capabilities.postgresql.available, false);
  assert.equal(
    (
      await f.request(base + '/resources', 'POST', {
        kind: 'postgresql',
        region: 'aws-us-east-1',
        name: 'not-supported',
      })
    ).body.error.code,
    'INVALID_KIND',
  );
  assert.equal(
    (
      await f.request(base + '/keys', 'POST', {
        name: 'old-pg-key',
        scopes: ['queries:execute'],
        resourceIds: ['db_legacy_pg'],
        expiresInDays: 7,
      })
    ).status,
    400,
  );
  assert.equal((await f.query('db_legacy_pg')).status, 404);
  assert.ok(
    JSON.parse(await readFile(f.dataFile, 'utf8')).resources.some((r) => r.id === 'db_legacy_pg'),
  );
  assert.equal(f.provider.creates, 0);
  assert.equal(f.provider.calls.length, 0);
});

test('SQL limits, credential file permissions and connection destination validation fail closed', async (t) => {
  const f = await fixture(t);
  const id = (await f.create()).body.data.id;
  assert.equal((await f.query(id, undefined, '雪'.repeat(22000))).status, 400);
  const file = f.dataFile + '.databases.json';
  await chmod(file, 0o644);
  await assert.rejects(createZero({ credentialsFile: file }));
  await chmod(file, 0o600);
  const binding = {
    kind: 'mysql',
    region: 'automatic',
    host: 'test.tidbcloud.com',
    port: 4000,
    user: 'user',
    password: 'password',
    database: 'workspace',
  };
  for (const host of ['127.0.0.1', 'x.tidbcloud.com.attacker.test'])
    assert.throws(() => validateBinding({ ...binding, host }, binding));
  assert.throws(() => validateBinding({ ...binding, kind: 'postgresql' }, binding));
  assert.equal(
    validateBinding({ ...binding, ssl: { rejectUnauthorized: false } }, binding).ssl,
    undefined,
  );
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const adapter = await createZero({
    credentialsFile: file,
    execute: async () => {
      await wait;
      return {};
    },
  });
  const resource = { id, kind: 'mysql', region: 'automatic' };
  const running = Array.from({ length: 4 }, () => adapter.execute(resource, 'SELECT 1'));
  await assert.rejects(adapter.execute(resource, 'SELECT 1'), { code: 'SQL_BUSY' });
  release();
  await Promise.all(running);
});

test('bounded results preserve duplicate names and exact values; raw SQL errors never leave the backend', () => {
  assert.equal(sanitizeSqlError({ errno: 8130 }).code, 'SQL_SYNTAX_ERROR');
  const result = resultCollector({ ...sqlLimits, rows: 1, bytes: 100 });
  result.fields(['value', 'value', '__proto__']);
  result.row(['9007199254740993', null, 'safe']);
  assert.deepEqual(result.finish().columns, ['value', 'value_2', '__proto__']);
  assert.equal(result.finish().rows[0].__proto__, 'safe');
  assert.throws(() => result.row([2, null, null]), { code: 'RESULT_TOO_LARGE' });
  const bytes = resultCollector({ ...sqlLimits, bytes: 100 });
  bytes.fields(['data']);
  assert.throws(() => bytes.row(['雪'.repeat(100)]), { code: 'RESULT_TOO_LARGE' });
  for (const code of [
    'ER_PARSE_ERROR',
    'ER_TABLEACCESS_DENIED_ERROR',
    'ER_QUERY_TIMEOUT',
    'ER_DUP_ENTRY',
    'unknown',
  ])
    assert.ok(
      !sanitizeSqlError({
        code,
        message: internalPassword,
        sql: internalPassword,
      }).message.includes(internalPassword),
    );
});
