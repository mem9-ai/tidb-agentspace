import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { createFileAnalysis } from './file-analysis.mjs';
import { createFileExports } from './file-exports.mjs';
import { fileExportLimits } from './file-export-contract.mjs';
import { analysisLimits } from './file-analysis-contract.mjs';
import { databaseExportPlan } from './result-exports.mjs';
import { mapImportFields } from './import-fields.mjs';
import { exportFixture } from './test-support/export-fixture.mjs';
const csv = 'id,amount,empty,flag\n001,9007199254740993,"",true\n002,2,,false\n';
const output = (text = csv, stream = 'stdout') => ({
  kind: 'output',
  resourceId: 'fs_shared',
  stream,
  text,
});
const original = (path = '/orders.csv') => ({ kind: 'original', resourceId: 'fs_shared', path });
const parsing = { format: 'csv', header: true, delimiter: ',' };
const file = (path = '/saved.txt', resourceId = 'fs_shared') => ({
  kind: 'filesystem',
  path,
  resourceId,
});
const database = (table = 'imported', resourceId = 'db_duck') => ({
  kind: 'database',
  table,
  resourceId,
});
const cleanPath = (path) => {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('..'))
    throw new Error('bad path');
  return path;
};
async function fixture(t, options) {
  const f = await exportFixture(options);
  t.after(f.close);
  return f;
}
const prepare = (f, source = output(), parser = parsing, token) =>
  f.request('/file-exports/prepare', 'POST', { source, parsing: parser }, token);
const send = (f, value, token, signal) => f.request('/file-exports', 'POST', value, token, signal);
const commit = (review, target = database(), fields = review.fields) => ({
  preparationId: review.preparationId,
  confirmed: true,
  fields,
  target,
});
const code = (response, status, expected) => {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.error.code, expected);
};

test('fixed import parsing preserves CSV strings/nulls and reviewed types preserve exact integers', async (t) => {
  const f = await fixture(t);
  const p = await prepare(f);
  assert.equal(p.status, 200);
  const review = p.body;
  assert.equal(review.rowCount, 2);
  assert.equal(review.rows[0].id, '001');
  assert.equal(review.rows[0].empty, '');
  assert.equal(review.rows[1].empty, null);
  assert.deepEqual(
    review.fields.map((field) => field.type),
    ['TEXT', 'BIGINT', 'TEXT', 'BOOLEAN'],
  );
  assert.equal(f.statements.length, 0);
  const result = await send(f, commit(review));
  assert.equal(result.status, 200);
  const read = await f.native('SELECT * FROM imported ORDER BY id');
  assert.equal(read.rows[0].id, '001');
  assert.equal(read.rows[0].amount, '9007199254740993');
  assert.equal(read.rows[0].empty, '');
  assert.equal(read.rows[1].empty, null);
  assert.equal(read.rows[1].flag, false);
  code(await send(f, commit(review, database('replayed'))), 409, 'IMPORT_ALREADY_COMMITTED');
  assert.equal(f.statements.length, 2);
  const counts = await f.native(
    "SELECT count(*) AS n FROM information_schema.tables WHERE table_name='replayed'",
  );
  assert.equal(counts.rows[0].n, '0');
});

test('headerless/separated CSV, multiline values and explicit text lines have reviewed semantics', async (t) => {
  const f = await fixture(t);
  const p = await prepare(f, output('001;"two\nlines"\n002;""\n'), {
    format: 'csv',
    header: false,
    delimiter: ';',
  });
  assert.equal(p.status, 200);
  assert.equal(p.body.fields.length, 2);
  assert.equal(Object.values(p.body.rows[0])[1], 'two\nlines');
  const lines = await prepare(f, output('INFO started\n\nERROR failed\n'), { format: 'lines' });
  assert.equal(lines.status, 200);
  assert.deepEqual(lines.body.rows, [
    { line: 'INFO started' },
    { line: '' },
    { line: 'ERROR failed' },
  ]);
  const empty = await prepare(f, output(''), { format: 'lines' });
  assert.equal(empty.body.rowCount, 0);
  assert.equal((await send(f, commit(empty.body, database('empty_lines')))).status, 200);
  const schema = await f.native('DESCRIBE empty_lines');
  assert.equal(schema.rows[0].column_type, 'VARCHAR');
});

test('raw stdout/stderr, empty output and originals round-trip without rerun or conversion', async (t) => {
  const f = await fixture(t);
  for (const text of ['', csv, 'ERROR\t失败\r\n\0']) {
    const result = await send(f, { source: output(text, 'stderr'), target: { kind: 'download' } });
    assert.equal(result.status, 200);
    assert.equal(result.body.content, text);
    assert.equal(result.body.bytes, Buffer.byteLength(text));
    assert.equal(result.body.filename, 'command-stderr.txt');
  }
  const saved = await send(f, { source: output(csv), target: file() });
  assert.equal(saved.status, 200);
  assert.equal(
    (await f.request('/files?resourceId=fs_shared')).body.data.find(
      (item) => item.path === '/saved.txt',
    ).content,
    csv,
  );
  assert.equal(
    (await send(f, { source: original(), target: file('/original.csv', 'fs_live') })).status,
    200,
  );
  assert.deepEqual(f.files.get('/original.csv'), Buffer.from('region,total\nAPAC,30\nEU,20\n'));
  code(
    await send(f, { source: output('replacement'), target: file() }),
    409,
    'EXPORT_TARGET_EXISTS',
  );
  assert.equal(f.statements.length, 0);
});

test('escaped output uses the new envelope without relaxing output or existing route budgets', async (t) => {
  const f = await fixture(t);
  const text = '\0'.repeat(fileExportLimits.outputBytes);
  const result = await send(f, { source: output(text), target: { kind: 'download' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.content, text);
  code(
    await send(f, { source: output(text + 'x'), target: { kind: 'download' } }),
    413,
    'EXPORT_TOO_LARGE',
  );
  code(
    await f.request('/files', 'PUT', {
      resourceId: 'fs_shared',
      path: '/too-large.txt',
      type: 'file',
      content: 'a'.repeat(1024 * 1024),
    }),
    413,
    'BODY_TOO_LARGE',
  );
  assert.equal(f.statements.length, 0);
  assert.equal(f.io.length, 0);
});

test('a known table conflict retains the reviewed snapshot for a new table name', async (t) => {
  const f = await fixture(t);
  const review = (await prepare(f)).body;
  code(await send(f, commit(review, database('sample'))), 409, 'SQL_TABLE_EXISTS');
  assert.equal((await send(f, commit(review, database('after_conflict')))).status, 200);
  assert.equal((await f.native('SELECT count(*) AS n FROM after_conflict')).rows[0].n, '2');
  assert.equal((await f.native('SELECT count(*) AS n FROM sample')).rows[0].n, '1');
});

test('import preparation shares preview admission and releases its worker slot on cancellation', async () => {
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const analysis = createFileAnalysis({
    snapshot: async () => ({ bytes: Buffer.from('a\n1\n') }),
    limits: { ...analysisLimits, concurrency: 1 },
    runner: async (_input, signal) => {
      if (++calls === 1) {
        entered();
        await new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      }
      return { columns: ['a'], columnTypes: ['VARCHAR'], rows: [{ a: '1' }] };
    },
  });
  const resource = { id: 'fs_shared' };
  const controller = new AbortController();
  const pending = analysis.parse(resource, { path: '/test.csv', parsing }, controller.signal);
  await ready;
  await assert.rejects(analysis.preview(resource, { path: '/test.csv' }), {
    code: 'ANALYSIS_BUSY',
  });
  controller.abort();
  await assert.rejects(pending, { code: 'ANALYSIS_CANCELED' });
  assert.equal((await analysis.parse(resource, { path: '/test.csv', parsing })).rows.length, 1);
});

test('mapping and all type/budget validation complete before any destination statement', async (t) => {
  const f = await fixture(t);
  const review = (await prepare(f)).body;
  const bad = review.fields.map((field) =>
    field.source === 'id' ? { ...field, type: 'BOOLEAN' } : field,
  );
  code(await send(f, commit(review, database(), bad)), 400, 'INVALID_IMPORT_FIELDS');
  assert.equal(f.statements.length, 0);
  const renamed = review.fields
    .filter((field) => ['id', 'amount'].includes(field.source))
    .map((field) => ({ ...field, name: field.source === 'id' ? 'account' : field.name }));
  assert.equal((await send(f, commit(review, database('selected'), renamed))).status, 200);
  assert.deepEqual((await f.native('SELECT * FROM selected')).columns, ['account', 'amount']);
  const plan = databaseExportPlan(
    { columns: ['big'], rows: [{ big: '9223372036854775807' }] },
    'safe',
    'mysql',
    ['BIGINT'],
  );
  assert.match(plan.insert, /9223372036854775807/);
  assert.throws(() =>
    databaseExportPlan(
      { columns: ['big'], rows: [{ big: '1); DROP TABLE safe; --' }] },
      'safe',
      'duckdb',
      ['BIGINT'],
    ),
  );
  assert.throws(() =>
    mapImportFields({ columns: ['a'], rows: [{ a: '9223372036854775808' }] }, [
      { source: 'a', name: 'a', type: 'BIGINT' },
    ]),
  );
  assert.throws(() =>
    mapImportFields({ columns: ['a', 'b'], rows: [] }, [
      { source: 'a', name: 'same', type: 'TEXT' },
      { source: 'b', name: 'SAME', type: 'TEXT' },
    ]),
  );
  const many = await prepare(
    f,
    output('id\n' + Array.from({ length: 1001 }, (_, i) => i).join('\n')),
  );
  code(many, 413, 'IMPORT_ROW_LIMIT');
  const wide = await prepare(
    f,
    output(
      Array.from({ length: 101 }, (_, i) => 'c' + i).join(',') +
        '\n' +
        Array(101).fill('1').join(','),
    ),
  );
  code(wide, 413, 'IMPORT_COLUMN_LIMIT');
  const malformed = await prepare(f, output('id,value\n1,"unclosed'));
  assert.equal(malformed.status, 422);
  assert.doesNotMatch(JSON.stringify(malformed.body), /workspace-analysis-|sourcePath|stack/);
});

test('original review is bound to saved bytes and output reviews are bound to the exact Key/session', async (t) => {
  const f = await fixture(t);
  const source = original();
  const p = await prepare(f, source);
  assert.equal(p.status, 200);
  await f.request('/files', 'PUT', {
    resourceId: 'fs_shared',
    path: '/orders.csv',
    type: 'file',
    content: 'region,total\nAPAC,99\n',
  });
  code(await send(f, commit(p.body)), 409, 'FILE_CHANGED');
  assert.equal(f.statements.length, 0);
  const keyA = await f.key(
    ['files:read', 'files:analyze', 'queries:execute'],
    ['fs_shared', 'db_duck'],
  );
  const keyB = await f.key(
    ['files:read', 'files:analyze', 'queries:execute'],
    ['fs_shared', 'db_duck'],
  );
  const review = (await prepare(f, output(), parsing, keyA.secret)).body;
  code(await send(f, commit(review), keyB.secret), 409, 'IMPORT_PREPARATION_UNAVAILABLE');
  await f.request('/keys/' + keyA.data.id, 'DELETE');
  code(await send(f, commit(review), keyA.secret), 401, 'INVALID_KEY');
  assert.equal(f.statements.length, 0);
});

test('new export routes retain source/target scopes and reject injected/hidden/cross-workspace access before I/O', async (t) => {
  const f = await fixture(t);
  const read = await f.key(['files:read', 'files:write'], ['fs_shared']);
  code(await prepare(f, output(), parsing, read.secret), 403, 'INSUFFICIENT_SCOPE');
  code(await send(f, { source: output(), target: file() }, read.secret), 403, 'INSUFFICIENT_SCOPE');
  assert.equal(
    (await send(f, { source: original(), target: file('/read-copy.csv') }, read.secret)).status,
    200,
  );
  const denied = await f.key(['files:read', 'files:analyze', 'files:write'], ['fs_shared']);
  code(
    await send(f, { source: output(), target: file('/no.txt', 'fs_live') }, denied.secret),
    403,
    'RESOURCE_ACCESS_DENIED',
  );
  code(
    await send(f, { source: { ...output(), script: 'cat /etc/passwd' }, target: file() }),
    400,
    'INVALID_FILE_EXPORT',
  );
  code(await prepare(f, output(), { ...parsing, sql: 'SELECT 1' }), 400, 'INVALID_FILE_EXPORT');
  code(await prepare(f, { ...original(), resourceId: 'hidden_storage' }), 404, 'NOT_FOUND');
  code(
    await f.request('/api/v1/workspaces/other/file-exports/prepare', 'POST', {
      source: output(),
      parsing,
    }),
    404,
    'NOT_FOUND',
  );
  for (const token of ['expired-fixture', 'revoked-fixture'])
    code(await prepare(f, output(), parsing, token), 401, 'INVALID_KEY');
  assert.equal(f.statements.length, 0);
  assert.equal(f.io.length, 0);
});

test('revocation before INSERT stops a reviewed write, with no retry or compensating drop', async (t) => {
  const hooks = {};
  const f = await fixture(t, { hooks });
  const key = await f.key(
    ['files:read', 'files:analyze', 'queries:execute'],
    ['fs_shared', 'db_duck'],
  );
  const review = (await prepare(f, output(), parsing, key.secret)).body;
  hooks.afterSql = async (_kind, sql) => {
    if (sql.startsWith('CREATE')) await f.request('/keys/' + key.data.id, 'DELETE');
  };
  code(
    await send(f, commit(review, database('revoked_import')), key.secret),
    502,
    'EXPORT_INCOMPLETE',
  );
  assert.equal(f.statements.length, 1);
  assert.match(f.statements[0].sql, /^CREATE/);
  assert.equal((await f.native('SELECT count(*) AS n FROM revoked_import')).rows[0].n, '0');
});

test('single-use concurrent commits and expiry/eviction bound preparation state', async () => {
  let time = 1000;
  let writes = 0;
  let release;
  const parsed = {
    columns: ['a'],
    columnTypes: ['VARCHAR'],
    rows: [{ a: '1' }],
    rowCount: 1,
    fileVersion: 'v',
    inputBytes: 1,
  };
  const service = createFileExports({
    analysis: { parse: async () => parsed },
    now: () => time,
    limits: { ...fileExportLimits, preparations: 2, preparationMs: 10 },
  });
  const context = {
    actor: 'one',
    cleanPath,
    authorize: () => ({ id: 'db', kind: 'duckdb' }),
    record: async () => {},
    execute: async () => {
      writes++;
      if (writes === 1)
        await new Promise((resolve) => {
          release = resolve;
        });
    },
  };
  const p = () => service.prepare({ source: output('a\n1'), parsing }, context);
  const first = await p();
  time = 1011;
  await assert.rejects(service.export(commit(first), context), {
    code: 'IMPORT_PREPARATION_UNAVAILABLE',
  });
  const evicted = await p();
  await p();
  await p();
  await assert.rejects(service.export(commit(evicted), context), {
    code: 'IMPORT_PREPARATION_UNAVAILABLE',
  });
  const current = await p();
  const pending = service.export(commit(current), context);
  await Promise.resolve();
  await assert.rejects(service.export(commit(current), context), {
    code: 'IMPORT_ALREADY_COMMITTED',
  });
  release();
  await pending;
  assert.equal(writes, 2);
  service.close();
});

test('binary original copies preserve bytes on live targets and reject lossy local decoding', async () => {
  const bytes = Buffer.from([0, 255, 128, 10]);
  const resource = { id: 'fs', kind: 'filesystem', status: 'active' };
  const analysis = createFileAnalysis({ snapshot: async () => ({ bytes, size: bytes.length }) });
  const service = createFileExports({ analysis });
  let artifact;
  const context = {
    actor: 'one',
    cleanPath,
    authorize: ({ target }) =>
      target.kind === 'download'
        ? resource
        : {
            id: target.resourceId,
            provider: target.resourceId === 'live' ? 'drive9-anonymous' : 'local',
          },
    record: async () => {},
    createFile: async ({ artifact: value }) => {
      artifact = value;
    },
  };
  const source = { kind: 'original', resourceId: 'fs', path: '/binary.parquet' };
  await service.export({ source, target: file('/copy.parquet', 'live') }, context);
  assert.deepEqual(artifact.content, bytes);
  await assert.rejects(
    service.export({ source, target: file('/copy.parquet', 'local') }, context),
    { code: 'LOCAL_BINARY_UNSUPPORTED' },
  );
});

test('Parquet original import uses full bounded schema/data rather than its preview sample', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'import-parquet-'));
  const db = await DuckDBInstance.create(':memory:');
  const connection = await db.connect();
  try {
    const path = join(directory, 'data.parquet');
    await connection.run(
      `COPY (SELECT i::BIGINT AS id, 'row' AS text FROM range(25) t(i)) TO '${path}' (FORMAT PARQUET)`,
    );
    const bytes = await readFile(path);
    const service = createFileExports({
      analysis: createFileAnalysis({ snapshot: async () => ({ bytes, size: bytes.length }) }),
    });
    const review = await service.prepare(
      { source: original('/data.parquet'), parsing: { format: 'parquet' } },
      { actor: 'one', cleanPath, authorize: () => ({ id: 'fs_shared' }) },
    );
    assert.equal(review.rowCount, 25);
    assert.equal(review.rows.length, 20);
    assert.deepEqual(
      review.fields.map((field) => field.type),
      ['BIGINT', 'TEXT'],
    );
    service.close();
  } finally {
    connection.closeSync();
    db.closeSync();
    await rm(directory, { recursive: true, force: true });
  }
});
