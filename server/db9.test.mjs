import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDb9, validatePgBinding } from './providers/db9.mjs';
import { createApp } from './regression-api.mjs';
import Ajv2020 from 'ajv/dist/2020.js';
import { seed } from './store.mjs';

const resource = { id: 'db_pg', kind: 'postgresql', region: 'automatic', name: 'pg-demo' };
const root = '/api/v1/workspaces/ws_agentlab';
function fakeDb9() {
  const requests = [],
    sql = [],
    databases = [],
    roles = new Set();
  let loseCreate = false,
    loseRegister = false,
    failSetup = false;
  return {
    requests,
    sql,
    databases,
    set loseCreate(v) {
      loseCreate = v;
    },
    set loseRegister(v) {
      loseRegister = v;
    },
    set failSetup(v) {
      failSetup = v;
    },
    async transport(url, options) {
      const path = url.replace('https://api.db9.ai/customer', '');
      requests.push({ path, method: options.method, body: options.body });
      assert.equal(options.redirect, 'error');
      const response = (value) => new Response(JSON.stringify(value));
      if (path === '/anonymous-register') {
        if (loseRegister) throw new Error('private-registration-secret');
        assert.equal(options.headers.Authorization, undefined);
        return response({
          anonymous_id: 'anon_fixture',
          anonymous_secret: 'private-anonymous-secret',
          token: 'private-provider-token',
          expires_at: new Date(Date.now() + 86400000).toISOString(),
        });
      }
      if (path === '/anonymous-refresh') {
        assert.equal(JSON.parse(options.body).anonymous_secret, 'private-anonymous-secret');
        return response({
          token: 'private-provider-token',
          expires_at: new Date(Date.now() + 86400000).toISOString(),
        });
      }
      assert.equal(options.headers.Authorization, 'Bearer private-provider-token');
      if (path === '/databases' && options.method === 'POST') {
        const input = JSON.parse(options.body),
          id = `tenant00000${databases.length + 1}`;
        const db = {
          id,
          name: input.name,
          connection_string: `postgresql://${id}.admin@pg.db9.io:5432/postgres`,
        };
        databases.push(db);
        if (loseCreate) throw new Error('private-provider-token');
        return response(db);
      }
      if (path === '/databases') return response(databases);
      return response(databases.find((db) => path === '/databases/' + db.id));
    },
    async execute(binding, text, options) {
      sql.push({ user: binding.user, text });
      if (binding.user.endsWith('.admin')) {
        assert.equal(options.setup, true);
        if (failSetup) throw new Error(binding.password);
        const role = /rolname = '([^']+)'/.exec(text)?.[1];
        if (text.startsWith('CREATE ROLE')) roles.add(/"([^"]+)"/.exec(text)[1]);
        if (text.startsWith('SELECT rol'))
          return {
            columns: [],
            rows: roles.has(role)
              ? [{ rolname: role, rolsuper: false, rolcreatedb: false, rolcreaterole: false }]
              : [],
            rowCount: roles.has(role) ? 1 : 0,
          };
        return { columns: [], rows: [], rowCount: 0 };
      }
      assert.match(binding.user, /\.w[a-f0-9]{12}$/);
      if (text.includes('AS owned'))
        return { columns: ['owned'], rows: [{ owned: true }], rowCount: 1 };
      return { columns: ['connected'], rows: [{ connected: 1 }], rowCount: 1, affectedRows: 0 };
    },
  };
}
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'db9-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function provider(t, fake = fakeDb9()) {
  const file = join(await directory(t), 'credentials.json');
  const open = () =>
    createDb9({ credentialsFile: file, transport: fake.transport, execute: fake.execute });
  return { fake, file, open, adapter: await open() };
}
test('db9: persist one anonymous account/instance, coalesce setup and reuse native role after restart', async (t) => {
  const f = await provider(t);
  await Promise.all([f.adapter.provision(resource), f.adapter.provision(resource)]);
  assert.equal(f.fake.requests.filter((r) => r.path === '/anonymous-register').length, 1);
  assert.equal(
    f.fake.requests.filter((r) => r.path === '/databases' && r.method === 'POST').length,
    1,
  );
  assert.equal(f.adapter.status(resource.id).status, 'active');
  const saved = JSON.parse(await readFile(f.file));
  assert.equal(saved.bindings[resource.id].admin, undefined);
  assert.equal(saved.bindings[resource.id].response, undefined);
  const second = await f.open();
  await second.provision(resource);
  await second.execute(resource, 'SELECT 1');
  assert.equal(f.fake.requests.length, 2);
  assert.ok(!f.fake.sql.at(-1).user.endsWith('.admin'));
  await f.adapter.provision({ ...resource, id: 'db_other' });
  assert.equal(f.fake.requests.filter((r) => r.path === '/anonymous-register').length, 1);
});
test('db9: recover uncertain creation by name without another create; native setup retries same binding', async (t) => {
  const f = await provider(t);
  f.fake.loseCreate = true;
  await assert.rejects(
    f.adapter.provision(resource),
    (e) => e.code === 'DB9_CREATION_UNCONFIRMED' && !e.message.includes('private'),
  );
  f.fake.loseCreate = false;
  f.fake.failSetup = true;
  await assert.rejects(f.adapter.provision(resource), { code: 'DB9_SETUP_INCOMPLETE' });
  f.fake.failSetup = false;
  await (await f.open()).provision(resource);
  assert.equal(f.fake.databases.length, 1);
  assert.equal(
    f.fake.requests.filter((r) => r.path === '/databases' && r.method === 'POST').length,
    1,
  );
});
test('db9: uncertain registration never registers again; expired token refresh keeps account identity', async (t) => {
  const f = await provider(t);
  f.fake.loseRegister = true;
  await assert.rejects(f.adapter.provision(resource));
  f.fake.loseRegister = false;
  await assert.rejects((await f.open()).provision(resource), {
    code: 'DB9_REGISTRATION_UNCONFIRMED',
  });
  assert.equal(f.fake.requests.filter((r) => r.path === '/anonymous-register').length, 1);
  const good = await provider(t);
  await good.adapter.provision(resource);
  const saved = JSON.parse(await readFile(good.file));
  saved.account.expiresAt = 0;
  await writeFile(good.file, JSON.stringify(saved), { mode: 0o600 });
  await (await good.open()).provision({ ...resource, id: 'db_next' });
  assert.equal(good.fake.requests.filter((r) => r.path === '/anonymous-refresh').length, 1);
  assert.equal(good.fake.requests.filter((r) => r.path === '/anonymous-register').length, 1);
});
test('db9: validate private vault permissions, destination and supported connection fields', async (t) => {
  const f = await provider(t);
  await f.adapter.provision(resource);
  await chmod(f.file, 0o644);
  await assert.rejects(f.open(), /owner-only/);
  const binding = {
    kind: 'postgresql',
    region: 'automatic',
    host: 'pg.db9.io',
    port: 5432,
    user: 'tenant.w1234567890ab',
    password: 'private',
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionString: 'unsafe',
  };
  const safe = validatePgBinding(binding, resource);
  assert.equal(safe.ssl, undefined);
  assert.equal(safe.connectionString, undefined);
  for (const changes of [
    { host: '127.0.0.1' },
    { host: 'pg.db9.io.attacker.test' },
    { port: 443 },
    { user: 'tenant.admin.extra' },
    { user: 'tenant.admin' },
    { database: 'other' },
    { region: 'elsewhere' },
  ])
    assert.throws(() => validatePgBinding({ ...binding, ...changes }, resource));
});

async function apiFixture(t) {
  const dir = await directory(t),
    file = join(dir, 'workspace.json'),
    fake = fakeDb9(),
    initial = seed();
  initial.resources.push({ ...resource, id: 'db_retired', provider: undefined, status: 'active' });
  for (const [id, expiresAt, revokedAt] of [
    ['expired', '2000-01-01', null],
    ['revoked', '2999-01-01', '2026-01-01'],
  ])
    initial.keys.push({
      id,
      digest: createHash('sha256').update(id).digest('hex'),
      scopes: ['queries:execute'],
      resourceIds: ['*'],
      expiresAt,
      revokedAt,
    });
  await writeFile(file, JSON.stringify(initial));
  const server = await createApp({
    dataFile: file,
    postgresProvider: 'db9-anonymous',
    db9Transport: fake.transport,
    postgresExecute: fake.execute,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = await fetch(origin + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  async function request(path, method = 'GET', body, key, idem) {
    const headers = {
      'Content-Type': 'application/json',
      ...(key === null ? {} : key ? { Authorization: `Bearer ${key}` } : { Cookie: cookie }),
      ...(idem ? { 'Idempotency-Key': idem } : {}),
    };
    const response = await fetch(origin + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  return { request, fake };
}
test('db9 API: resource idempotency, public secret exclusion, usage and retired PG isolation', async (t) => {
  const f = await apiFixture(t);
  const body = { name: 'live-postgres', kind: 'postgresql', region: 'automatic' };
  const [a, b] = await Promise.all([
    f.request(root + '/resources', 'POST', body, undefined, 'pg-create'),
    f.request(root + '/resources', 'POST', body, undefined, 'pg-create'),
  ]);
  assert.equal(a.status, 201);
  assert.equal(a.body.data.id, b.body.data.id);
  assert.equal(a.body.data.status, 'active');
  assert.equal(f.fake.databases.length, 1);
  const bootstrap = await f.request(root + '/bootstrap');
  assert.equal(bootstrap.body.capabilities.postgresql.available, true);
  const contract = JSON.parse(
    await readFile(new URL('../public/openapi.json', import.meta.url), 'utf8'),
  );
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  for (const [schema, value] of [
    ['Resource', a.body.data],
    ['Capabilities', bootstrap.body.capabilities],
  ]) {
    const validate = ajv.compile({
      ...contract.components.schemas[schema],
      components: contract.components,
    });
    assert.ok(validate(value), ajv.errorsText(validate.errors));
  }
  assert.ok(!bootstrap.body.resources.some((r) => r.id === 'db_retired'));
  assert.ok(!JSON.stringify(bootstrap.body).includes('private-'));
  assert.ok(!JSON.stringify(bootstrap.body).includes('connection_string'));
  const usage = bootstrap.body.usage.find((r) => r.resourceId === a.body.data.id);
  assert.equal(usage.measured, false);
  assert.equal(usage.storageBytes, null);
  assert.equal(usage.storageLimitBytes, null);
  const before = f.fake.sql.length;
  assert.equal(
    (await f.request(root + '/queries', 'POST', { resourceId: 'db_retired', sql: 'SELECT 1' }))
      .status,
    404,
  );
  assert.equal(f.fake.sql.length, before);
});
test('db9 API: PG+Files Workspace Key enforces scopes, resource selection, workspace, expiry and revocation before I/O', async (t) => {
  const f = await apiFixture(t);
  const pg = (
    await f.request(root + '/resources', 'POST', {
      name: 'authorized-pg',
      kind: 'postgresql',
      region: 'automatic',
    })
  ).body.data;
  async function key(scopes, resources) {
    return (
      await f.request(root + '/keys', 'POST', {
        name: 'fixture-key',
        scopes,
        resourceIds: resources,
        expiresInDays: 7,
      })
    ).body;
  }
  const allowed = await key(['queries:execute', 'files:read'], [pg.id, 'fs_shared']);
  assert.equal(
    (
      await f.request(
        root + '/queries',
        'POST',
        { resourceId: pg.id, sql: 'SELECT 1' },
        allowed.secret,
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.request(root + '/files?resourceId=fs_shared', 'GET', undefined, allowed.secret))
      .status,
    200,
  );
  const readOnly = await key(['resources:read'], [pg.id]);
  const unrelated = await key(['queries:execute', 'resources:write'], ['db_memory']);
  const before = f.fake.sql.length;
  const paths = [
    `/resources/${pg.id}/tables`,
    `/resources/${pg.id}/table?name=notes`,
    `/resources/${pg.id}/table/rows?name=notes`,
  ];
  for (const path of paths) {
    assert.equal((await f.request(root + path, 'GET', undefined, readOnly.secret)).status, 403);
    assert.equal((await f.request(root + path, 'GET', undefined, unrelated.secret)).status, 403);
    assert.equal(
      (await f.request('/api/v1/workspaces/other' + path, 'GET', undefined, allowed.secret)).status,
      404,
    );
    for (const token of [null, 'bad-token', 'expired', 'revoked'])
      assert.equal((await f.request(root + path, 'GET', undefined, token)).status, 401);
  }
  assert.equal(
    (
      await f.request(
        root + '/queries',
        'POST',
        { resourceId: 'db_memory', sql: 'SELECT 1' },
        allowed.secret,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        root + '/queries',
        'POST',
        { resourceId: pg.id, sql: 'SELECT 1' },
        readOnly.secret,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        '/api/v1/workspaces/other/queries',
        'POST',
        { resourceId: pg.id, sql: 'SELECT 1' },
        allowed.secret,
      )
    ).status,
    404,
  );
  assert.equal(f.fake.sql.length, before);
  assert.equal(
    (await f.request(root + `/resources/${pg.id}/setup`, 'POST', {}, unrelated.secret)).status,
    403,
  );
  assert.equal(
    (await f.request(root + `/resources/${pg.id}/setup`, 'POST', {}, allowed.secret)).status,
    403,
  );
  assert.equal(f.fake.sql.length, before);
  await f.request(root + `/keys/${allowed.data.id}`, 'DELETE');
  assert.equal(
    (
      await f.request(
        root + '/queries',
        'POST',
        { resourceId: pg.id, sql: 'SELECT 1' },
        allowed.secret,
      )
    ).status,
    401,
  );
  assert.equal(f.fake.sql.length, before);
});

test('db9: malformed SQL and four-query admission are enforced without leaking permits', async (t) => {
  const fake = fakeDb9();
  let release;
  const wait = new Promise((r) => {
    release = r;
  });
  const execute = async (binding, sql, options) =>
    sql === 'SELECT hold' ? wait : fake.execute(binding, sql, options);
  const file = join(await directory(t), 'vault.json');
  const pg = await createDb9({ credentialsFile: file, transport: fake.transport, execute });
  await pg.provision(resource);
  for (const sql of ['', null, 'x'.repeat(65537)])
    await assert.rejects(pg.execute(resource, sql), { code: 'INVALID_SQL' });
  const pending = Array.from({ length: 4 }, () => pg.execute(resource, 'SELECT hold'));
  await assert.rejects(pg.execute(resource, 'SELECT 1'), { code: 'SQL_BUSY' });
  release({ columns: [], rows: [], rowCount: 0 });
  await Promise.all(pending);
  assert.equal((await pg.execute(resource, 'SELECT 1')).mode, 'live');
});

test('db9: unsafe native role or schema ownership never activates a resource', async (t) => {
  for (const unsafe of ['role', 'schema']) {
    const fake = fakeDb9();
    const original = fake.execute;
    fake.execute = async (binding, sql, options) => {
      if (unsafe === 'role' && sql.startsWith('SELECT rolsuper'))
        return { rows: [{ rolsuper: true, rolcreatedb: false, rolcreaterole: false }] };
      if (unsafe === 'schema' && sql.includes('AS owned')) return { rows: [{ owned: false }] };
      return original(binding, sql, options);
    };
    const f = await provider(t, fake);
    await assert.rejects(f.adapter.provision(resource), { code: 'DB9_SETUP_INCOMPLETE' });
    assert.equal(f.adapter.status(resource.id).status, 'provisioning');
    await assert.rejects(f.adapter.execute(resource, 'SELECT 1'), { code: 'DATABASE_NOT_READY' });
  }
});
