import test from 'node:test';
import assert from 'node:assert/strict';
import { browsePostgres, postgresTableQuery } from './postgres-browser.mjs';
const resource = { kind: 'postgresql', provider: 'db9-anonymous', status: 'active' };
test('PostgreSQL browser: workspace-only exact names, columns/defaults and ordered composite indexes', async () => {
  const name = 'notes \'"\\ %中',
    sql = [];
  const execute = async (text) => {
    sql.push(text);
    assert.ok(text.includes('workspace'));
    if (text.includes('information_schema.tables')) return { rows: [{ name, type: 'BASE TABLE' }] };
    if (text.includes('information_schema.columns'))
      return {
        rows: [
          { name: 'id', type: 'bigint', nullable: 'NO', defaultValue: '42', position: 1 },
          { name: 'note', type: 'text', nullable: 'YES', defaultValue: null, position: 2 },
        ],
      };
    return {
      rows: [
        { name: 'pk', uniqueValue: true, primaryValue: true, positionKeys: '1' },
        { name: 'pair', uniqueValue: true, primaryValue: false, positionKeys: '2 1' },
      ],
    };
  };
  const detail = await browsePostgres({ resource, action: 'table', name, execute });
  assert.equal(detail.columns[0].key, 'PRI');
  assert.equal(detail.columns[1].nullable, true);
  assert.equal(detail.columns[0].default, '42');
  assert.deepEqual(
    detail.indexes[1].columns.map((c) => c.name),
    ['note', 'id'],
  );
  assert.ok(sql[0].includes("E'notes \\'\"\\\\ %中'"));
  assert.equal(detail.query, 'SELECT * FROM "workspace"."notes \'""\\ %中" LIMIT 100;');
  assert.equal(
    postgresTableQuery('x"; DROP SCHEMA workspace;--'),
    'SELECT * FROM "workspace"."x""; DROP SCHEMA workspace;--" LIMIT 100;',
  );
});
test('PostgreSQL browser: bounded lists/previews and invalid/missing/not-ready resources', async () => {
  const list = await browsePostgres({
    resource,
    action: 'tables',
    execute: async () => ({
      rows: Array.from({ length: 501 }, (_, i) => ({ name: 'table' + i, type: 'BASE TABLE' })),
    }),
  });
  assert.equal(list.data.length, 500);
  assert.equal(list.truncated, true);
  const calls = [];
  const data = { columns: ['id'], rows: [], rowCount: 0, mode: 'live' };
  const rows = await browsePostgres({
    resource,
    action: 'rows',
    name: 'empty',
    execute: async (sql) => {
      calls.push(sql);
      return calls.length === 1 ? { rows: [{ name: 'empty' }] } : data;
    },
  });
  assert.equal(rows, data);
  assert.match(calls[1], /LIMIT 100/);
  await assert.rejects(
    browsePostgres({
      resource,
      action: 'table',
      name: 'missing',
      execute: async () => ({ rows: [] }),
    }),
    { code: 'TABLE_NOT_FOUND' },
  );
  await assert.rejects(
    browsePostgres({
      resource,
      action: 'table',
      name: 'bad\0name',
      execute: async () => {
        throw new Error('must not query');
      },
    }),
    { code: 'INVALID_TABLE_NAME' },
  );
  await assert.rejects(
    browsePostgres({
      resource: { ...resource, status: 'failed' },
      action: 'tables',
      execute: async () => {
        throw new Error('must not query');
      },
    }),
    { code: 'DATABASE_UNAVAILABLE' },
  );
});
