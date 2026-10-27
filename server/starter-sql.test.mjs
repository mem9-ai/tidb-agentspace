import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from './index.mjs';
import { seed } from './store.mjs';
import {
  createStarterSql,
  resultCollector,
  sanitizeSqlError,
  sqlLimits,
  validateBinding,
} from './providers/starter-sql.mjs';

const base = '/api/v1/workspaces/ws_agentlab';
const secret = 'private-native-password-never-public';
const binding = (kind = 'mysql') => ({
  kind,
  region: 'aws-us-east-1',
  host: 'gateway.example.tidbcloud.com',
  port: kind === 'mysql' ? 4000 : 5432,
  user: 'workspace_role',
  password: secret,
  database: 'workspace_data',
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-sql-'));
  const dataFile = join(dir, 'state.json');
  const state = seed();
  for (const resource of state.resources.filter((r) => r.kind !== 'filesystem'))
    resource.provider = 'tidb-cloud-starter';
  const expired = 'expired-workspace-key';
  state.keys.push({
    id: 'expired',
    name: 'expired',
    digest: createHash('sha256').update(expired).digest('hex'),
    expiresAt: '2000-01-01',
    scopes: ['queries:execute'],
    resourceIds: ['*'],
  });
  await writeFile(dataFile, JSON.stringify(state));
  await writeFile(
    dataFile + '.databases.json',
    JSON.stringify({ bindings: { db_memory: binding(), db_vectors: binding('postgresql') } }),
    { mode: 0o600 },
  );
  const calls = [];
  const sqlExecute = async (connection, sql) => {
    calls.push({ kind: connection.kind, sql });
    assert.equal(connection.password, secret);
    return sql.startsWith('UPDATE')
      ? { columns: [], rows: [], rowCount: 0, affectedRows: 2 }
      : { columns: ['connected'], rows: [{ connected: '1' }], rowCount: 1, affectedRows: 0 };
  };
  let server, origin, cookie;
  async function start() {
    server = await createApp({ dataFile, filesProvider: 'local', sqlExecute });
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
  async function request(path, method = 'GET', body, token) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    assert.ok(!JSON.stringify(value).includes(secret));
    return { status: response.status, body: value };
  }
  const query = (resourceId, token, sql = 'SELECT 1') =>
    request(base + '/queries', 'POST', { resourceId, sql }, token);
  const key = async (scopes, resourceIds) =>
    (
      await request(base + '/keys', 'POST', {
        name: 'sql-agent',
        scopes,
        resourceIds,
        expiresInDays: 7,
      })
    ).body;
  return {
    dataFile,
    calls,
    query,
    request,
    key,
    expired,
    async restart() {
      await new Promise((resolve) => server.close(resolve));
      await start();
    },
  };
}

test('one Workspace Key executes both bound protocols; writes and restarts retain the private boundary', async (t) => {
  const f = await fixture(t);
  const key = await f.key(
    ['queries:execute', 'resources:read', 'files:read'],
    ['db_memory', 'db_vectors', 'fs_shared'],
  );
  for (const id of ['db_memory', 'db_vectors']) {
    const result = await f.query(id, key.secret);
    assert.equal(result.status, 200);
    assert.equal(result.body.mode, 'live');
    assert.equal(result.body.rowCount, 1);
  }
  assert.deepEqual(
    f.calls.map((c) => c.kind),
    ['mysql', 'postgresql'],
  );
  const write = await f.query('db_vectors', key.secret, 'UPDATE events SET done = true');
  assert.equal(write.body.affectedRows, 2);
  assert.deepEqual(write.body.rows, []);
  const files = await f.request(base + '/files?resourceId=fs_shared', 'GET', undefined, key.secret);
  assert.equal(files.status, 200);
  const bootstrap = await f.request(base + '/bootstrap');
  assert.equal(bootstrap.body.mode, 'hybrid');
  assert.equal(bootstrap.body.usage.find((u) => u.resourceId === 'db_memory').storageBytes, null);
  assert.ok(!(await readFile(f.dataFile, 'utf8')).includes(secret));
  await f.restart();
  assert.equal((await f.query('db_memory', key.secret)).status, 200);
});

test('authorization denies provider I/O for wrong scopes, resources, workspace, revoked and expired keys', async (t) => {
  const f = await fixture(t);
  const read = await f.key(['resources:read'], ['*']);
  const scoped = await f.key(['queries:execute'], ['db_memory']);
  assert.equal((await f.query('db_memory', read.secret)).status, 403);
  assert.equal((await f.query('db_vectors', scoped.secret)).status, 403);
  assert.equal((await f.query('db_memory', f.expired)).status, 401);
  assert.equal(
    (
      await f.request(
        '/api/v1/workspaces/other/queries',
        'POST',
        { resourceId: 'db_memory', sql: 'SELECT 1' },
        scoped.secret,
      )
    ).status,
    404,
  );
  await f.request(base + '/keys/' + scoped.data.id, 'DELETE');
  assert.equal((await f.query('db_memory', scoped.secret)).status, 401);
  assert.equal(f.calls.length, 0);
});

test('missing, public-readable, mismatched or invalid native bindings fail closed without demo fallback', async (t) => {
  const f = await fixture(t);
  const file = f.dataFile + '.databases.json';
  await chmod(file, 0o644);
  assert.equal((await f.query('db_memory')).body.error.code, 'DATABASE_NOT_CONFIGURED');
  await chmod(file, 0o600);
  for (const invalid of [
    null,
    binding('postgresql'),
    { ...binding(), host: '127.0.0.1' },
    { ...binding(), host: 'x.tidbcloud.com.attacker.test' },
  ]) {
    await writeFile(file, JSON.stringify({ bindings: { db_memory: invalid } }));
    assert.equal((await f.query('db_memory')).status, 503);
  }
  await rm(file);
  assert.equal((await f.query('db_memory')).status, 503);
  assert.equal(f.calls.length, 0);
});

test('SQL byte and concurrency limits apply before opening additional connections', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.query('db_memory', undefined, '雪'.repeat(22_000))).status, 400);
  assert.equal((await f.query('db_memory', undefined, {})).status, 400);
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const adapter = createStarterSql({
    credentialsFile: f.dataFile + '.databases.json',
    execute: async () => {
      await wait;
      return {};
    },
  });
  const resource = { id: 'db_memory', ...binding() };
  const running = Array.from({ length: 4 }, () => adapter.execute(resource, 'SELECT 1'));
  await assert.rejects(adapter.execute(resource, 'SELECT 1'), { code: 'SQL_BUSY' });
  release();
  await Promise.all(running);
});

test('result collection preserves duplicate/prototype column names and bounds bytes and rows', () => {
  const result = resultCollector({ ...sqlLimits, rows: 2, bytes: 100 });
  result.fields(['value', 'value', '__proto__']);
  result.row(['9007199254740993', null, 'safe']);
  assert.deepEqual(result.finish().columns, ['value', 'value_2', '__proto__']);
  assert.equal(Object.getPrototypeOf(result.finish().rows[0]), Object.prototype);
  assert.equal(result.finish().rows[0].__proto__, 'safe');
  assert.throws(() => result.row(['雪'.repeat(100), null, null]), { code: 'RESULT_TOO_LARGE' });
  const count = resultCollector({ ...sqlLimits, rows: 1 });
  count.fields(['n']);
  count.row([1]);
  assert.throws(() => count.row([2]), { code: 'RESULT_TOO_LARGE' });
});

test('native SQL failures never expose upstream credentials, SQL text, or connection details', () => {
  for (const code of [
    '42601',
    'ER_PARSE_ERROR',
    '42501',
    '23505',
    '57014',
    '28P01',
    'unexpected',
  ]) {
    const error = sanitizeSqlError({ code, message: secret, detail: secret, sql: secret });
    assert.ok(!error.message.includes(secret));
    assert.ok(error.status >= 400);
  }
  const safe = validateBinding(
    { ...binding(), ssl: { rejectUnauthorized: false }, connectionString: secret },
    binding(),
  );
  assert.equal(safe.ssl, undefined);
  assert.equal(safe.connectionString, undefined);
});
