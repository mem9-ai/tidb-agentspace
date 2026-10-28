import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rename, mkdir } from 'node:fs/promises';
import {
  parseResultExport,
  serializeResult,
  databaseExportPlan,
  exportResult,
} from './result-exports.mjs';
import { exportFixture } from './test-support/export-fixture.mjs';
import { sqlError, sanitizeSqlError } from './providers/sql-common.mjs';
import { safeDuckdbError } from './providers/duckdb-engine.mjs';
import { postgresError } from './providers/postgres-driver.mjs';

const snapshot = {
  columns: ['name', 'n', 'empty', 'nested', 'formula', 'precise'],
  rows: [
    {
      name: '中文,"x"\nnext',
      n: 2,
      empty: null,
      nested: { a: [true, 2] },
      formula: '=1+1',
      precise: '9007199254740993',
    },
  ],
};
const input = (
  target = { kind: 'download', format: 'json' },
  result = snapshot,
  sourceResourceId = 'db_memory',
) => ({ sourceResourceId, result, target });
const file = (path = '/export.json', resourceId = 'fs_shared', format = 'json') => ({
  kind: 'filesystem',
  resourceId,
  path,
  format,
});
const database = (table = 'exported', resourceId = 'db_duck') => ({
  kind: 'database',
  resourceId,
  table,
});
async function fixture(t, options) {
  const f = await exportFixture(options);
  t.after(f.close);
  return f;
}
const send = (f, value, token, signal) =>
  f.request('/result-exports', 'POST', value, token, signal);
const code = (response, status, expected) => {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.error.code, expected);
  assert.ok(response.body.error.requestId);
};

test('formats preserve JSON values, ordered numeric names, precision strings and safe CSV escaping', () => {
  assert.deepEqual(JSON.parse(serializeResult(snapshot, 'json').content), snapshot.rows);
  assert.deepEqual(
    serializeResult(snapshot, 'jsonl').content.trim().split('\n').map(JSON.parse),
    snapshot.rows,
  );
  const csv = serializeResult(snapshot, 'csv');
  assert.equal(
    csv.content,
    '"name","n","empty","nested","formula","precise"\r\n"中文,""x""\nnext","2",,"{""a"":[true,2]}","\'=1+1","9007199254740993"\r\n',
  );
  assert.equal(csv.bytes, Buffer.byteLength(csv.content));
  const numeric = {
    columns: ['10', '2', '__proto__'],
    rows: [JSON.parse('{"2":2,"10":10,"__proto__":"safe"}')],
  };
  for (const format of ['json', 'jsonl'])
    assert.ok(
      serializeResult(parseResultExport(input(undefined, numeric)).result, format).content.includes(
        '"10":10,"2":2,"__proto__":"safe"',
      ),
    );
  for (const value of [' +1', '\tcmd', '-1', '@x', '\n=1'])
    assert.ok(
      serializeResult({ columns: ['a'], rows: [{ a: value }] }, 'csv').content.includes(
        '"\'' + value + '"',
      ),
    );
  assert.equal(serializeResult({ columns: ['a'], rows: [] }, 'json').content, '[]\n');
  assert.equal(serializeResult({ columns: ['a'], rows: [] }, 'jsonl').content, '');
});

test('invalid snapshots and oversized plans fail before provider effects', async () => {
  for (const result of [
    { columns: [], rows: [] },
    { columns: ['a', 'a'], rows: [] },
    { columns: ['a'], rows: [{ b: 1 }] },
    { columns: ['a'], rows: [{ a: Infinity }] },
    { columns: ['a'], rows: [{ a: '\ud800' }] },
    { columns: ['a'], rows: [{ a: undefined }] },
    { columns: ['a'], rows: [{ a: new Date() }] },
    { columns: ['a'], rows: Array.from({ length: 1001 }, () => ({ a: 1 })) },
    { columns: Array.from({ length: 101 }, (_, i) => String(i)), rows: [] },
    { columns: ['a'], rows: [{ a: Array.from({ length: 18 }).reduce((v) => [v], 1) }] },
  ])
    assert.throws(() => parseResultExport(input(undefined, result)), { code: 'INVALID_EXPORT' });
  assert.throws(
    () =>
      parseResultExport(input(undefined, { columns: ['a'], rows: [{ a: 'x'.repeat(1048576) }] })),
    { code: 'EXPORT_TOO_LARGE' },
  );
  for (const [result, table] of [
    [snapshot, '中'.repeat(22)],
    [snapshot, 'bad\nname'],
    [{ columns: ['A', 'a'], rows: [] }, 'okay'],
    [{ columns: ['a'], rows: [{ a: '\0' }] }, 'okay'],
  ])
    assert.throws(() => databaseExportPlan(result, table, 'duckdb'), { code: 'INVALID_EXPORT' });
  let io = 0;
  await assert.rejects(
    exportResult(input(database(), { columns: ['a'], rows: [{ a: 'x'.repeat(40000) }] }), {
      authorize: () => ({ kind: 'duckdb' }),
      execute: () => {
        io++;
      },
    }),
    { code: 'EXPORT_SQL_TOO_LARGE' },
  );
  assert.equal(io, 0);
});

test('native DuckDB creates exactly one new table and preserves hostile names, values and types', async (t) => {
  const f = await fixture(t);
  const table = 'x"; DROP TABLE sample;--';
  const result = {
    columns: ['a"b', 'bool', 'int', 'float', 'mixed', 'nulls', 'empty'],
    rows: [
      {
        'a"b': "中文'); DROP TABLE sample;--\\",
        bool: true,
        int: Number.MAX_SAFE_INTEGER,
        float: 1.5,
        mixed: { a: 2 },
        nulls: null,
        empty: '',
      },
      {
        'a"b': '9007199254740993',
        bool: null,
        int: -4,
        float: 2,
        mixed: 3,
        nulls: null,
        empty: ' ',
      },
    ],
  };
  const r = await send(f, input(database(table), result));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(
    r.body.columns.map((c) => c.type),
    ['VARCHAR', 'BOOLEAN', 'BIGINT', 'DOUBLE', 'VARCHAR', 'VARCHAR', 'VARCHAR'],
  );
  const readback = await f.native('SELECT * FROM "' + table.replaceAll('"', '""') + '"');
  assert.deepEqual(
    readback.rows,
    result.rows.map((row) => ({ ...row, int: String(row.int), mixed: JSON.stringify(row.mixed) })),
  );
  assert.equal(f.statements.length, 2);
  code(await send(f, input(database(table), result)), 409, 'SQL_TABLE_EXISTS');
  assert.equal((await f.native('SELECT * FROM sample')).rows.length, 1);
  assert.equal(
    (await f.native('SELECT * FROM "' + table.replaceAll('"', '""') + '"')).rows.length,
    2,
  );
  const empty = await send(f, input(database('empty_table'), { columns: ['a'], rows: [] }));
  assert.equal(empty.status, 200);
  assert.equal((await f.native('SELECT * FROM empty_table')).rows.length, 0);
  assert.equal(f.statements.filter((s) => /empty_table/.test(s.sql)).length, 1);
});

test('MySQL and PostgreSQL adapters receive quoted CREATE then one encoded INSERT', async (t) => {
  const f = await fixture(t);
  for (const [id, kind, quoted] of [
    ['db_mysql', 'mysql', '`x``y`'],
    ['db_pg', 'postgresql', '"x`y"'],
  ]) {
    const r = await send(f, input(database('x`y', id)));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const statements = f.statements.filter((s) => s.kind === kind).map((s) => s.sql);
    assert.equal(statements.length, 2);
    assert.ok(statements[0].startsWith('CREATE TABLE ' + quoted));
    assert.ok(statements[1].startsWith('INSERT INTO ' + quoted));
    assert.ok(!statements[1].includes(snapshot.rows[0].name));
    assert.ok(statements[1].includes(kind === 'mysql' ? "CONVERT(X'" : "convert_from(decode('"));
  }
  assert.equal(
    sanitizeSqlError({ code: 'ER_TABLE_EXISTS_ERROR', message: 'private' }).code,
    'SQL_TABLE_EXISTS',
  );
  assert.equal(postgresError({ code: '42P07', message: 'private' }).code, 'SQL_TABLE_EXISTS');
  assert.equal(
    safeDuckdbError({ message: 'Catalog Error: Table with name "private" already exists!' }).code,
    'SQL_TABLE_EXISTS',
  );
});

test('local and live files are conditional creates, survive restart and never rerun source SQL', async (t) => {
  const f = await fixture(t);
  for (const format of ['csv', 'json', 'jsonl']) {
    for (const resourceId of ['fs_shared', 'fs_live']) {
      const path = '/export.' + format;
      const r = await send(f, input(file(path, resourceId, format)));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const expected = serializeResult(snapshot, format).content;
      if (resourceId === 'fs_live') assert.equal(f.files.get(path).toString(), expected);
      else
        assert.equal(
          (await f.request('/files?resourceId=fs_shared')).body.data.find((v) => v.path === path)
            .content,
          expected,
        );
      code(await send(f, input(file(path, resourceId, format))), 409, 'EXPORT_TARGET_EXISTS');
    }
  }
  code(await send(f, input(file('/docs'))), 409, 'EXPORT_TARGET_EXISTS');
  code(await send(f, input(file('/missing/file.json'))), 404, 'PARENT_MISSING');
  code(await send(f, input(file('/missing/file.json', 'fs_live'))), 404, 'NOT_FOUND');
  code(await send(f, input(file('/bad\nfile.json'))), 400, 'INVALID_EXPORT');
  const large = { columns: ['a'], rows: [{ a: 'x'.repeat(270000) }] };
  code(await send(f, input(file('/large.json'), large)), 413, 'FILE_TOO_LARGE');
  f.hooks.uploadLimit = 10;
  const puts = f.io.filter((i) => i.method === 'PUT').length;
  code(await send(f, input(file('/large.json', 'fs_live'))), 413, 'FILE_TOO_LARGE');
  assert.equal(f.io.filter((i) => i.method === 'PUT').length, puts);
  await f.restart();
  const stored = (await f.request('/files?resourceId=fs_shared')).body.data;
  assert.equal(
    stored.find((v) => v.path === '/export.json').content,
    serializeResult(snapshot, 'json').content,
  );
  assert.equal(f.statements.length, 0);
  const audit = (await f.request('/events')).body;
  assert.ok(JSON.stringify(audit).includes('result.exported'));
  assert.ok(!JSON.stringify(audit).includes(snapshot.rows[0].precise));
});

test('all source/target scopes and grants, workspace and private resources are checked before I/O', async (t) => {
  const f = await fixture(t);
  for (const [scopes, grants, source, target, expected] of [
    [[], ['*'], 'db_memory', file(), 'INSUFFICIENT_SCOPE'],
    [['queries:execute'], ['*'], 'db_memory', file(), 'INSUFFICIENT_SCOPE'],
    [['files:write', 'files:read'], ['*'], 'fs_shared', file(), 'INSUFFICIENT_SCOPE'],
    [['files:write', 'files:analyze'], ['*'], 'fs_shared', file(), 'INSUFFICIENT_SCOPE'],
    [['files:read', 'files:analyze'], ['*'], 'fs_shared', database(), 'INSUFFICIENT_SCOPE'],
    [
      ['queries:execute', 'files:write'],
      ['db_memory'],
      'db_memory',
      file('/denied', 'fs_live'),
      'RESOURCE_ACCESS_DENIED',
    ],
    [
      ['queries:execute', 'files:write'],
      ['fs_live'],
      'db_memory',
      file('/denied', 'fs_live'),
      'RESOURCE_ACCESS_DENIED',
    ],
  ]) {
    // Keys require at least one scope; resources:read grants no export rights.
    const key = await f.key(scopes.length ? scopes : ['resources:read'], grants);
    code(await send(f, input(target, snapshot, source), key.secret), 403, expected);
  }
  for (const token of ['expired-fixture', 'revoked-fixture'])
    code(await send(f, input(file()), token), 401, 'INVALID_KEY');
  code(await send(f, input(database('x', 'hidden_storage'))), 404, 'NOT_FOUND');
  code(await send(f, input(file('/x', 'hidden_storage'))), 404, 'NOT_FOUND');
  code(await send(f, input(database('x', 'db_memory'))), 400, 'INVALID_EXPORT_TARGET');
  code(await send(f, input(file('/x', 'fs_unavailable'))), 409, 'EXPORT_TARGET_UNAVAILABLE');
  const sourceOnly = await f.key(['queries:execute'], ['db_memory']);
  code(await send(f, input(database()), sourceOnly.secret), 403, 'RESOURCE_ACCESS_DENIED');
  assert.equal(
    (await f.request('/api/v1/workspaces/other/result-exports', 'POST', input(file()))).status,
    404,
  );
  assert.equal(f.io.length, 0);
  assert.equal(f.statements.length, 0);
  const key = await f.key(['files:read', 'files:analyze'], ['fs_shared']);
  assert.equal((await send(f, input(undefined, snapshot, 'fs_shared'), key.secret)).status, 200);
});

test('revocation during live status prevents PUT, and after CREATE prevents INSERT', async (t) => {
  const f = await fixture(t);
  const filesKey = await f.key(['queries:execute', 'files:write'], ['db_memory', 'fs_live']);
  f.hooks.status = () => f.request('/keys/' + filesKey.data.id, 'DELETE');
  code(await send(f, input(file('/revoked', 'fs_live')), filesKey.secret), 401, 'INVALID_KEY');
  assert.equal(f.io.filter((i) => i.method === 'PUT').length, 0);
  const dbKey = await f.key(['queries:execute'], ['db_memory', 'db_duck']);
  f.hooks.afterSql = async (_, sql) => {
    if (sql.startsWith('CREATE')) await f.request('/keys/' + dbKey.data.id, 'DELETE');
  };
  code(await send(f, input(database('revoked_table')), dbKey.secret), 502, 'EXPORT_INCOMPLETE');
  assert.equal(f.statements.length, 1);
  assert.equal((await f.native('SELECT * FROM revoked_table')).rows.length, 0);
});

test('insert, uncertain CREATE, audit and disconnect failures do not retry or compensate', async (t) => {
  const f = await fixture(t);
  f.hooks.beforeSql = (_, sql) => {
    if (sql.startsWith('INSERT')) throw sqlError(504, 'SQL_TIMEOUT', 'private SQL and credentials');
  };
  const failed = await send(f, input(database('incomplete')));
  code(failed, 502, 'EXPORT_INCOMPLETE');
  assert.ok(failed.body.error.message.includes('Inspect the table'));
  assert.ok(!JSON.stringify(failed).includes('private SQL'));
  assert.equal((await f.native('SELECT * FROM incomplete')).rows.length, 0);
  code(await send(f, input(database('incomplete'))), 409, 'SQL_TABLE_EXISTS');
  assert.equal(f.statements.length, 3);
  f.hooks.beforeSql = () => {
    throw sqlError(504, 'SQL_TIMEOUT', 'A write may have completed; inspect before retrying.');
  };
  code(await send(f, input(database('unknown'))), 504, 'SQL_TIMEOUT');
  assert.equal(f.statements.length, 4);
  f.hooks.beforeSql = undefined;
  f.hooks.afterSql = async (_, sql) => {
    if (sql.startsWith('INSERT')) {
      await rename(f.dataFile, f.dataFile + '.backup');
      await mkdir(f.dataFile);
    }
  };
  code(await send(f, input(database('audit_failed'))), 500, 'EXPORT_RECORD_FAILED');
  assert.equal((await f.native('SELECT * FROM audit_failed')).rows.length, 1);
  assert.ok(!f.statements.some((s) => s.sql.startsWith('DROP')));
  assert.ok(!String(await readFile(f.dataFile + '.backup')).includes('9007199254740993'));
  const controller = new AbortController();
  const executed = [];
  await assert.rejects(
    exportResult(input(database()), {
      authorize: () => ({ kind: 'duckdb' }),
      signal: controller.signal,
      execute: (_, sql) => {
        executed.push(sql);
        controller.abort();
      },
    }),
    { code: 'EXPORT_INCOMPLETE' },
  );
  assert.equal(executed.length, 1);
});
