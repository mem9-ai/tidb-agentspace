import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './regression-api.mjs';
import { seed } from './store.mjs';
import { browseDatabase, tableName, tableQuery } from './database-browser.mjs';
import { sqlError } from './providers/sql-common.mjs';

const base = '/api/v1/workspaces/ws_agentlab';
const strangeName = "订单 `x'; DROP TABLE users; --";
const fixtureTables = [
  { name: strangeName, type: 'BASE TABLE' },
  { name: 'empty', type: 'BASE TABLE' },
  { name: 'summary', type: 'VIEW' },
];
const rowset = (rows, columns = Object.keys(rows[0] ?? {})) => ({
  columns,
  rows,
  rowCount: rows.length,
  affectedRows: 0,
});
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-browser-'));
  const dataFile = join(dir, 'state.json');
  const state = seed();
  state.resources.push({
    id: 'db_expired',
    name: 'expired',
    kind: 'mysql',
    region: 'automatic',
    provider: 'tidb-cloud-zero',
    status: 'expired',
  });
  state.keys.push({
    id: 'expired-key',
    digest: createHash('sha256').update('expired-token').digest('hex'),
    scopes: ['queries:execute'],
    resourceIds: ['*'],
    expiresAt: '2000-01-01',
  });
  await writeFile(dataFile, JSON.stringify(state));
  const calls = [];
  let failure;
  const app = await createApp({
    dataFile,
    filesProvider: 'local',
    mysqlProvider: 'tidb-cloud-zero',
    zeroTransport: async () =>
      Response.json({
        instance: {
          id: 'fixture',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          connection: {
            host: 'browser.tidbcloud.com',
            port: 4000,
            username: 'prefix.root',
            password: 'private-fixture-password',
          },
        },
      }),
    sqlExecute: async (connection, sql, { signal }) => {
      if (!sql.startsWith('SELECT')) return rowset([]);
      if (sql === 'SELECT 1 AS connected') return rowset([{ connected: 1 }]);
      assert.equal(connection.database, 'workspace');
      assert.notEqual(connection.password, 'private-fixture-password');
      assert.ok(signal);
      calls.push(sql);
      if (failure) throw failure;
      const hex = /CONVERT\(X'([a-f0-9]+)' USING utf8mb4\)/.exec(sql)?.[1];
      const name = hex ? Buffer.from(hex, 'hex').toString() : undefined;
      if (sql.includes('information_schema.')) assert.ok(sql.includes('TABLE_SCHEMA = DATABASE()'));
      if (sql.includes('AS recordKind')) {
        assert.equal(sql.match(/TABLE_SCHEMA = DATABASE\(\)/g)?.length, 3);
        assert.equal(sql.match(/CONVERT\(X'[a-f0-9]+' USING utf8mb4\)/g)?.length, 3);
        assert.match(sql, /ORDER BY recordKind, position, name LIMIT 1001$/);
        const table = fixtureTables.find((entry) => entry.name === name);
        return rowset(
          table
            ? [
                {
                  recordKind: 'column',
                  name: 'id',
                  type: 'bigint',
                  nullable: 'NO',
                  defaultValue: null,
                  columnKey: 'PRI',
                  extra: 'auto_increment',
                  position: 1,
                },
                {
                  recordKind: 'column',
                  name: 'label',
                  type: 'varchar(50)',
                  nullable: 'YES',
                  defaultValue: '',
                  columnKey: 'MUL',
                  extra: '',
                  position: 2,
                },
                {
                  recordKind: 'index',
                  name: 'PRIMARY',
                  nonUnique: '0',
                  columnName: 'id',
                  position: '1',
                  prefixLength: null,
                },
                {
                  recordKind: 'index',
                  name: 'by_label',
                  nonUnique: '1',
                  columnName: 'label',
                  position: '1',
                  prefixLength: '10',
                },
                {
                  recordKind: 'index',
                  name: 'by_label',
                  nonUnique: '1',
                  columnName: 'id',
                  position: '2',
                  prefixLength: null,
                },
                { recordKind: 'table', ...table },
              ]
            : [],
        );
      }
      if (sql.includes('information_schema.TABLES'))
        return rowset(name ? fixtureTables.filter((table) => table.name === name) : fixtureTables);
      if (sql.includes('information_schema.COLUMNS'))
        return rowset([
          {
            name: 'id',
            type: 'bigint',
            nullable: 'NO',
            defaultValue: null,
            columnKey: 'PRI',
            extra: 'auto_increment',
          },
          {
            name: 'label',
            type: 'varchar(50)',
            nullable: 'YES',
            defaultValue: '',
            columnKey: 'MUL',
            extra: '',
          },
        ]);
      if (sql.includes('information_schema.STATISTICS'))
        return rowset([
          { name: 'PRIMARY', nonUnique: '0', columnName: 'id', position: '1', prefixLength: null },
          {
            name: 'by_label',
            nonUnique: '1',
            columnName: 'label',
            position: '1',
            prefixLength: '10',
          },
          { name: 'by_label', nonUnique: '1', columnName: 'id', position: '2', prefixLength: null },
        ]);
      assert.match(sql, /^SELECT \* FROM `(?:[^`]|``)+` LIMIT 100;$/);
      return rowset(
        sql.includes('`empty`')
          ? []
          : Array.from({ length: 100 }, (_, id) => ({
              id: String(9007199254740993n + BigInt(id)),
              label: id === 0 ? null : '<script>untrusted</script>',
            })),
        ['id', 'label'],
      );
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => app.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const session = await fetch(origin + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  async function request(path, { method = 'GET', body, token, owner = true, status = 200 } = {}) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : owner ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    assert.ok(!JSON.stringify(result).includes('private-fixture-password'));
    return result;
  }
  const created = await request(base + '/resources', {
    method: 'POST',
    status: 201,
    body: { name: 'browser-test', kind: 'mysql', region: 'automatic' },
  });
  const path = `${base}/resources/${created.data.id}`;
  async function key(scopes, resourceIds) {
    return request(base + '/keys', {
      method: 'POST',
      status: 201,
      body: { name: 'browser-key', scopes, resourceIds, expiresInDays: 7 },
    });
  }
  return {
    request,
    path,
    id: created.data.id,
    key,
    calls,
    setFailure: (error) => {
      failure = error;
    },
  };
}

test('table reads return native metadata, ordered composite indexes and bounded precise rows', async (t) => {
  const f = await fixture(t);
  const key = await f.key(['queries:execute'], [f.id]);
  const auth = { token: key.secret };
  const list = await f.request(f.path + '/tables', auth);
  assert.equal(list.mode, 'live');
  assert.equal(list.truncated, false);
  assert.deepEqual(list.data, fixtureTables);
  const before = f.calls.length;
  const detail = await f.request(f.path + '/table?name=' + encodeURIComponent(strangeName), auth);
  assert.equal(f.calls.length - before, 1, 'one authorized native request for all metadata');
  assert.equal(detail.recordKind, undefined);
  assert.deepEqual(detail.columns[1], {
    name: 'label',
    type: 'varchar(50)',
    nullable: true,
    default: '',
    key: 'MUL',
    extra: '',
  });
  assert.equal(detail.columns[0].default, null);
  assert.equal(detail.columns[0].extra, 'auto_increment');
  assert.deepEqual(detail.indexes[1], {
    name: 'by_label',
    unique: false,
    columns: [
      { name: 'label', position: 1, prefixLength: 10 },
      { name: 'id', position: 2, prefixLength: null },
    ],
  });
  assert.equal(detail.query, tableQuery(strangeName));
  const rows = await f.request(
    f.path + '/table/rows?name=' + encodeURIComponent(strangeName),
    auth,
  );
  assert.equal(rows.rows.length, 100);
  assert.equal(rows.rows[0].id, '9007199254740993');
  assert.equal(rows.rows[0].label, null);
  const empty = await f.request(f.path + '/table/rows?name=empty', auth);
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.columns, ['id', 'label']);
  await f.request(f.path + '/table?name=missing', { ...auth, status: 404 });
  assert.ok(
    f.calls
      .filter((sql) => sql.includes('TABLE_SCHEMA'))
      .every((sql) => !sql.includes(strangeName)),
  );
  assert.equal(f.calls.filter((sql) => sql.startsWith('SELECT *')).length, 2);
});

test('all database browse operations enforce scope, resource, workspace and key lifecycle before SQL', async (t) => {
  const f = await fixture(t);
  const readOnly = await f.key(['resources:read'], [f.id]);
  const other = await f.key(['queries:execute'], ['db_memory']);
  const allowed = await f.key(['queries:execute'], [f.id]);
  await f.request(base + '/keys/' + allowed.data.id, { method: 'DELETE' });
  f.calls.length = 0;
  for (const suffix of ['/tables', '/table?name=empty', '/table/rows?name=empty']) {
    await f.request(f.path + suffix, { token: readOnly.secret, status: 403 });
    await f.request(f.path + suffix, { token: other.secret, status: 403 });
    await f.request(f.path + suffix, { token: allowed.secret, status: 401 });
    await f.request(f.path + suffix, { token: 'expired-token', status: 401 });
    await f.request(f.path + suffix, { owner: false, status: 401 });
    await f.request(f.path.replace('ws_agentlab', 'other-workspace') + suffix, { status: 404 });
    await f.request(`${base}/resources/fs_shared${suffix}`, { status: 404 });
    await f.request(`${base}/resources/db_expired${suffix}`, { status: 410 });
  }
  assert.deepEqual(f.calls, []);
});

test('invalid names fail before SQL; bounded read errors are returned without partial results', async (t) => {
  const f = await fixture(t);
  for (const name of ['', 'a'.repeat(65), 'a\0b', 'a\nb']) {
    for (const action of ['table', 'table/rows'])
      await f.request(`${f.path}/${action}?name=${encodeURIComponent(name)}`, { status: 400 });
  }
  assert.deepEqual(f.calls, []);
  f.setFailure(sqlError(422, 'RESULT_TOO_LARGE', 'Result exceeds 1 MiB. Select fewer columns.'));
  const result = await f.request(f.path + '/table?name=empty', { status: 422 });
  assert.equal(result.error.code, 'RESULT_TOO_LARGE');
  assert.equal(result.rows, undefined);
  f.setFailure(sqlError(504, 'SQL_TIMEOUT', 'Query exceeded 15 seconds.'));
  await f.request(f.path + '/table?name=empty', { status: 504 });
  f.setFailure(undefined);
  const demo = await f.request(`${base}/resources/db_memory/table?name=agent_events`);
  assert.equal(demo.mode, 'demo');
  const preview = await f.request(`${base}/resources/db_memory/table/rows?name=agent_events`);
  const query = await f.request(base + '/queries', {
    method: 'POST',
    body: { resourceId: 'db_memory', sql: tableQuery('agent_events') },
  });
  assert.deepEqual(query.rows, preview.rows);
});

test('listing truncation and empty listings are explicit; identifier quoting cannot change query structure', async () => {
  const resource = { status: 'active', provider: 'tidb-cloud-zero' };
  for (const count of [0, 500, 501]) {
    const result = await browseDatabase({
      resource,
      action: 'tables',
      execute: async (sql) => {
        assert.match(sql, /ORDER BY TABLE_NAME LIMIT 501$/);
        return rowset(
          Array.from({ length: count }, (_, i) => ({ name: `t${i}`, type: 'BASE TABLE' })),
        );
      },
    });
    assert.equal(result.data.length, Math.min(500, count));
    assert.equal(result.truncated, count > 500);
  }
  assert.equal(tableQuery('mysql.user'), 'SELECT * FROM `mysql.user` LIMIT 100;');
  assert.equal(tableQuery('a`b\\c'), 'SELECT * FROM `a``b\\c` LIMIT 100;');
  assert.throws(() => tableName('\ud800'), { code: 'INVALID_TABLE_NAME' });
  assert.equal(tableName('表'.repeat(64)), '表'.repeat(64));
});
