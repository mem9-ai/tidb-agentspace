import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { DuckDBInstance } from '@duckdb/node-api';
import { exportFixture } from './test-support/export-fixture.mjs';
import { sqlError } from './providers/sql-common.mjs';
import { createFileExports } from './file-exports.mjs';
import { uploadImportInput } from './database-import-contract.mjs';

const base = '/api/v1/workspaces/ws_agentlab';
const parsing = { format: 'csv', header: true, delimiter: ',' };
const csv = Buffer.from('id,amount,flag\n001,9007199254740993,true\n002,2,false\n');
async function fixture(t, options) {
  const f = await exportFixture(options);
  t.after(f.close);
  return f;
}
async function upload(f, bytes = csv, token, options = {}) {
  let cookie;
  if (!token) {
    const session = await fetch(f.origin + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    cookie = session.headers.get('set-cookie').split(';')[0];
  }
  const query = new URLSearchParams({
    resourceId: 'db_duck',
    filename: 'orders.csv',
    format: 'csv',
    header: 'true',
    delimiter: ',',
    ...options,
  });
  const response = await fetch(f.origin + base + '/database-imports/prepare-upload?' + query, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }),
    },
    body: bytes,
  });
  return { status: response.status, body: await response.json(), cookie };
}
async function ownerCommit(f, prepared, table = 'imported', resourceId = 'db_duck', token) {
  const body = {
    resourceId,
    preparationId: prepared.body.preparationId,
    confirmed: true,
    table,
    fields: prepared.body.fields,
  };
  if (token) return f.request('/database-imports', 'POST', body, token);
  // Local owner preparations are session-bound, not transferable to the fixture's other owner session.
  if (prepared.cookie) {
    const response = await fetch(f.origin + base + '/database-imports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: prepared.cookie },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  return f.request('/database-imports', 'POST', body);
}
const prepareFile = (
  f,
  resourceId = 'db_duck',
  source = { resourceId: 'fs_shared', path: '/orders.csv' },
  token,
) => f.request('/database-imports/prepare', 'POST', { resourceId, source, parsing }, token);
const error = (r, status, code) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  if (code) assert.equal(r.body.error.code, code);
};

test('destination-only Key imports exact local CSV values without File System writes or resources', async (t) => {
  const f = await fixture(t);
  const key = await f.key(['queries:execute'], ['db_duck']);
  const before = await f.request('/bootstrap');
  const ioBefore = f.io.length;
  const prepared = await upload(f, csv, key.secret);
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.rows[0].id, '001');
  assert.equal(prepared.body.rows[0].amount, '9007199254740993');
  assert.equal(f.statements.length, 0);
  assert.equal(f.io.length, ioBefore);
  const imported = await ownerCommit(f, prepared, 'local_import', 'db_duck', key.secret);
  assert.equal(imported.status, 200);
  const read = await f.native('SELECT * FROM local_import ORDER BY id');
  assert.equal(read.rows[0].id, '001');
  assert.equal(read.rows[0].amount, '9007199254740993');
  assert.equal(read.rows[0].flag, true);
  const after = await f.request('/bootstrap');
  assert.deepEqual(after.body.resources, before.body.resources);
  assert.deepEqual(after.body.files, before.body.files);
  error(
    await ownerCommit(f, prepared, 'replayed', 'db_duck', key.secret),
    409,
    'IMPORT_ALREADY_COMMITTED',
  );
  assert.equal(f.statements.length, 2);
});
test('local Parquet retains its schema, complete row count and exact integers', async (t) => {
  const f = await fixture(t);
  const path = f.dir + '/input.parquet';
  const db = await DuckDBInstance.create(':memory:');
  const connection = await db.connect();
  try {
    await connection.run(
      `COPY (SELECT range AS id, '测试' AS label FROM range(25)) TO '${path}' (FORMAT PARQUET)`,
    );
  } finally {
    connection.closeSync();
    db.closeSync();
  }
  const prepared = await upload(f, await readFile(path), undefined, {
    filename: 'input.parquet',
    format: 'parquet',
    header: undefined,
    delimiter: undefined,
  });
  // URLSearchParams cannot omit undefined properties; issue the explicitly valid Parquet request below.
  error(prepared, 400, 'INVALID_IMPORT');
  const session = await fetch(f.origin + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const response = await fetch(
    f.origin +
      base +
      '/database-imports/prepare-upload?' +
      new URLSearchParams({ resourceId: 'db_duck', filename: 'input.parquet', format: 'parquet' }),
    {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
      body: await readFile(path),
    },
  );
  const review = { status: response.status, body: await response.json(), cookie };
  assert.equal(review.status, 200);
  assert.equal(review.body.rowCount, 25);
  assert.equal(review.body.rows.length, 20);
  assert.equal(review.body.fields[0].type, 'BIGINT');
  assert.equal((await ownerCommit(f, review, 'parquet_import')).status, 200);
  assert.equal((await f.native('SELECT count(*) AS n FROM parquet_import')).rows[0].n, '25');
});
test('Workspace files prepare and write through MySQL, PostgreSQL and DuckDB plans', async (t) => {
  const f = await fixture(t);
  for (const [id, kind, type] of [
    ['db_mysql', 'mysql', 'LONGTEXT'],
    ['db_pg', 'postgresql', 'TEXT'],
    ['db_duck', 'duckdb', 'VARCHAR'],
  ]) {
    const prepared = await prepareFile(f, id);
    assert.equal(prepared.status, 200);
    const saved = await ownerCommit(f, prepared, `${kind}_import`, id);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.columns[0].type, type);
    assert.equal(saved.body.rowCount, 2);
  }
  assert.equal(f.statements.length, 6);
});
test('missing source/target actions and grants, invalid Keys and wrong Workspaces deny before effects', async (t) => {
  const f = await fixture(t);
  const cases = [
    [[], ['db_duck'], 'raw'],
    [['queries:execute'], ['db_pg'], 'raw'],
    [['queries:execute'], ['db_duck', 'fs_live'], 'file'],
    [['queries:execute', 'files:read'], ['db_duck', 'fs_live'], 'file'],
    [['queries:execute', 'files:read', 'files:analyze'], ['db_duck'], 'file'],
    [['queries:execute', 'files:read', 'files:analyze'], ['fs_live'], 'file'],
  ];
  for (const [scopes, ids, mode] of cases) {
    const key = await f.key(scopes.length ? scopes : ['resources:read'], ids);
    const r =
      mode === 'raw'
        ? await upload(f, Buffer.from('malformed'), key.secret)
        : await prepareFile(f, 'db_duck', { resourceId: 'fs_live', path: '/live.csv' }, key.secret);
    error(r, 403);
  }
  for (const token of ['invalid', 'expired-fixture', 'revoked-fixture'])
    error(await upload(f, csv, token), 401);
  error(
    await f.request('/api/v1/workspaces/other/database-imports/prepare', 'POST', {
      resourceId: 'db_duck',
      source: { resourceId: 'fs_live', path: '/live.csv' },
      parsing,
    }),
    404,
  );
  assert.equal(f.io.length, 0);
  assert.equal(f.statements.length, 0);
});
test('tickets reject another principal, destination and legacy endpoint bypass; old tickets cannot become imports', async (t) => {
  const f = await fixture(t);
  const first = await f.key(['queries:execute'], ['db_duck', 'db_mysql']);
  const second = await f.key(['queries:execute'], ['db_duck']);
  const p = await upload(f, csv, first.secret);
  error(
    await ownerCommit(f, p, 'wrong_actor', 'db_duck', second.secret),
    409,
    'IMPORT_PREPARATION_UNAVAILABLE',
  );
  error(
    await ownerCommit(f, p, 'wrong_target', 'db_mysql', first.secret),
    409,
    'IMPORT_TARGET_MISMATCH',
  );
  error(
    await f.request(
      '/file-exports',
      'POST',
      {
        preparationId: p.body.preparationId,
        confirmed: true,
        fields: p.body.fields,
        target: { kind: 'database', resourceId: 'db_mysql', table: 'bypass' },
      },
      first.secret,
    ),
    409,
    'IMPORT_TARGET_MISMATCH',
  );
  const old = await f.request('/file-exports/prepare', 'POST', {
    source: { kind: 'original', resourceId: 'fs_shared', path: '/orders.csv' },
    parsing,
  });
  error(await ownerCommit(f, old), 409, 'IMPORT_TARGET_MISMATCH');
  assert.equal(f.statements.length, 0);
  assert.equal((await ownerCommit(f, p, 'correct_target', 'db_duck', first.secret)).status, 200);
});
test('changed sources, revoked Keys, forged confirmations and restart invalidate uncommitted reviews', async (t) => {
  const f = await fixture(t);
  const key = await f.key(['queries:execute'], ['db_duck']);
  const local = await upload(f, csv, key.secret);
  await f.request('/keys/' + key.data.id, 'DELETE');
  error(await ownerCommit(f, local, 'revoked', 'db_duck', key.secret), 401);
  const p = await prepareFile(f);
  await f.request('/files', 'PUT', {
    resourceId: 'fs_shared',
    path: '/orders.csv',
    type: 'file',
    content: 'x\nchanged\n',
  });
  error(await ownerCommit(f, p), 409, 'FILE_CHANGED');
  const fresh = await prepareFile(f);
  error(
    await f.request('/database-imports', 'POST', {
      resourceId: 'db_duck',
      preparationId: fresh.body.preparationId,
      confirmed: false,
      table: 'bad',
      fields: fresh.body.fields,
    }),
    400,
  );
  await f.restart();
  error(await ownerCommit(f, fresh), 409, 'IMPORT_PREPARATION_UNAVAILABLE');
  assert.equal(f.statements.length, 0);
});
test('concurrent commit claims a review once and never repeats its CREATE/INSERT', async (t) => {
  const f = await fixture(t, { delay: 30 });
  const p = await prepareFile(f);
  const results = await Promise.all([ownerCommit(f, p, 'raced'), ownerCommit(f, p, 'raced')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(f.statements.length, 2);
});
test('table collisions retain review; failed INSERT reports partial write and never retries or drops', async (t) => {
  const f = await fixture(t);
  let collision = true;
  f.hooks.beforeSql = async (_, sql) => {
    if (collision && sql.startsWith('CREATE')) {
      collision = false;
      throw sqlError(409, 'SQL_TABLE_EXISTS', 'Exists');
    }
  };
  const p = await prepareFile(f);
  error(await ownerCommit(f, p, 'exists'), 409, 'SQL_TABLE_EXISTS');
  assert.equal((await ownerCommit(f, p, 'renamed')).status, 200);
  const partial = await prepareFile(f);
  f.hooks.beforeSql = async (_, sql) => {
    if (sql.startsWith('INSERT')) throw new Error('injected failure');
  };
  error(await ownerCommit(f, partial, 'partial'), 502, 'EXPORT_INCOMPLETE');
  error(await ownerCommit(f, partial, 'again'), 409, 'IMPORT_ALREADY_COMMITTED');
  assert.ok(f.statements.every((s) => !s.sql.startsWith('DROP')));
  assert.equal((await f.native('SELECT count(*) AS n FROM partial')).rows[0].n, '0');
});
test('bad parsing, filenames, fields and upload/row budgets reject before database writes', async (t) => {
  const f = await fixture(t);
  for (const options of [
    { filename: '../bad.csv' },
    { format: 'json' },
    { header: 'yes' },
    { extra: 'field' },
  ])
    error(await upload(f, csv, undefined, options), 400, 'INVALID_IMPORT');
  error(await upload(f, Buffer.alloc(1024 * 1024 + 1)), 413);
  error(
    await upload(f, Buffer.from('id\n' + Array.from({ length: 1001 }, (_, i) => i).join('\n'))),
    413,
  );
  const p = await prepareFile(f);
  error(
    await f.request('/database-imports', 'POST', {
      resourceId: 'db_duck',
      preparationId: p.body.preparationId,
      confirmed: true,
      table: 'bad_fields',
      fields: p.body.fields.map((field) => ({ ...field, name: 'duplicate' })),
    }),
    400,
    'INVALID_IMPORT_FIELDS',
  );
  assert.equal(f.statements.length, 0);
});
test('revocation after CREATE reports an incomplete import and never runs INSERT', async (t) => {
  const f = await fixture(t);
  const key = await f.key(['queries:execute'], ['db_duck']);
  const p = await upload(f, csv, key.secret);
  f.hooks.afterSql = async (_, sql) => {
    if (sql.startsWith('CREATE')) await f.request('/keys/' + key.data.id, 'DELETE');
  };
  error(
    await ownerCommit(f, p, 'revoked_after_create', 'db_duck', key.secret),
    502,
    'EXPORT_INCOMPLETE',
  );
  assert.equal(f.statements.length, 1);
  assert.equal((await f.native('SELECT count(*) AS n FROM revoked_after_create')).rows[0].n, '0');
});
test('target-bound preparations expire and are evicted with the shared bounded cache', async () => {
  let now = 1;
  const service = createFileExports({
    now: () => now,
    limits: { preparations: 1, preparationMs: 10 },
    analysis: {
      parse: async () => ({
        columns: ['id'],
        rows: [{ id: '1' }],
        columnTypes: ['VARCHAR'],
        fileVersion: 'version',
        inputBytes: 4,
      }),
    },
  });
  const context = {
    actor: 'principal',
    authorize: () => ({ id: 'db', kind: 'mysql' }),
    cleanPath: (p) => p,
  };
  const input = uploadImportInput({
    resourceId: 'db',
    filename: 'x.csv',
    format: 'csv',
    header: 'true',
    delimiter: ',',
  });
  const p = await service.prepareImport(
    { resourceId: 'db', filename: 'x.csv', format: 'csv', header: 'true', delimiter: ',' },
    context,
    Buffer.from('id\n1'),
  );
  now = 12;
  await assert.rejects(
    () =>
      service.commitImport(
        {
          resourceId: input.resourceId,
          preparationId: p.preparationId,
          confirmed: true,
          table: 'expired',
          fields: p.fields,
        },
        context,
      ),
    { code: 'IMPORT_PREPARATION_UNAVAILABLE' },
  );
  const options = {
    resourceId: 'db',
    filename: 'x.csv',
    format: 'csv',
    header: 'true',
    delimiter: ',',
  };
  const evicted = await service.prepareImport(options, context, Buffer.from('id\n1'));
  await service.prepareImport(options, context, Buffer.from('id\n2'));
  await assert.rejects(
    () =>
      service.commitImport(
        {
          resourceId: 'db',
          preparationId: evicted.preparationId,
          confirmed: true,
          table: 'evicted',
          fields: evicted.fields,
        },
        context,
      ),
    { code: 'IMPORT_PREPARATION_UNAVAILABLE' },
  );
});
