import { authorizationCases } from './product-api-authorization-cases.mjs';
import { fileCases } from './product-api-file-cases.mjs';
import { exportCases } from './product-api-export-cases.mjs';
import { importCases } from './product-api-import-cases.mjs';
import assert from 'node:assert/strict';
import { nativeSecret } from './provider-fixture.mjs';
import { productApiFixture } from './product-api-fixture.mjs';
import { revokeAndConfirmRegion } from './revoke-confirm.mjs';

const scopes = [
  'resources:read',
  'resources:write',
  'files:read',
  'files:write',
  'files:analyze',
  'queries:execute',
  'usage:read',
];
const resources = ['fs_shared', 'fs_live', 'db_live', 'db_pg'];
const parsing = { format: 'csv', header: true, delimiter: ',' };
const rowset = (rows) => ({
  columns: ['id', 'decimal', 'nullable', 'enabled', 'binary'],
  rows,
  rowCount: rows.length,
  affectedRows: 0,
});
const row = {
  id: '9007199254740993',
  decimal: '12345678901234567890.012300',
  nullable: null,
  enabled: true,
  binary: 'AP8NCg==',
};

export async function productApiCases(t, transport) {
  const stored = new Map();
  const faults = {};
  const f = await productApiFixture(t, transport, async ({ binding, sql }) => {
    assert.equal(binding.password, nativeSecret);
    if (faults.afterCreate && sql.startsWith('CREATE TABLE')) await faults.afterCreate();
    if (faults.sql) {
      const response = faults.sql(sql);
      if (response) return response;
    }
    if (sql === 'INSERT INTO coverage_roundtrip VALUES (1)') {
      stored.set(binding.kind, structuredClone(row));
      return { body: { columns: [], rows: [], rowCount: 0, affectedRows: 1 } };
    }
    if (sql === 'UPDATE coverage_roundtrip SET enabled = false') {
      stored.get(binding.kind).enabled = false;
      return { body: { columns: [], rows: [], rowCount: 0, affectedRows: 1 } };
    }
    if (sql === 'DELETE FROM coverage_roundtrip') {
      stored.delete(binding.kind);
      return { body: { columns: [], rows: [], rowCount: 0, affectedRows: 1 } };
    }
    if (sql === 'SELECT * FROM coverage_roundtrip')
      return { body: rowset(stored.has(binding.kind) ? [stored.get(binding.kind)] : []) };
  });
  const { provider } = f;
  async function request(
    path,
    options,
    status = options?.method === 'POST' && path.split('?')[0].endsWith('-preparations') ? 201 : 200,
    code,
    workspace = 0,
  ) {
    const response = await f.request(path, options, workspace);
    assert.equal(
      response.status,
      status,
      `${options?.method ?? 'GET'} ${path}: ${JSON.stringify(response.body)}`,
    );
    if (code) {
      assert.equal(response.body.error.code, code);
      assert.equal(typeof response.body.error.message, 'string');
      assert.equal(typeof response.body.error.requestId, 'string');
    }
    assert.equal(JSON.stringify(response.body).includes(nativeSecret), false);
    return response;
  }
  async function key(name, grants = resources, actions = scopes, workspace = 0) {
    const result = await f.issueKey(
      { name, scopes: actions, resourceIds: grants, expiresInDays: 7 },
      workspace,
    );
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  }
  const full = await key('coverage-all');
  const token = full.secret;
  const query = (resourceId, sql, access = token) =>
    request('/queries', { method: 'POST', token: access, body: { resourceId, sql } });
  const upload = (
    resourceId = 'db_live',
    access = token,
    text = 'id,value\n001,9007199254740993\n',
  ) =>
    request(
      '/database-import-preparations?' +
        new URLSearchParams({ resourceId, filename: 'source.csv', ...parsing }),
      {
        method: 'POST',
        token: access,
        raw: Buffer.from(text),
        headers: { 'Content-Type': 'application/octet-stream' },
      },
    );
  const commit = (review, table, resourceId = 'db_live') => ({
    resourceId,
    preparationId: review.id,
    confirmed: true,
    table,
    fields: review.fields,
  });

  const context = {
    request,
    key,
    token,
    resources,
    scopes,
    parsing,
    provider,
    upload,
    commit,
    f,
    faults,
  };
  await authorizationCases(t, context);
  await fileCases(t, context);
  await t.test('PostgreSQL writes, reads and unknown outcomes are not retried', async () => {
    for (const id of ['db_live', 'db_pg']) {
      const before = provider.statements.length;
      const written = await query(id, 'INSERT INTO coverage_roundtrip VALUES (1)');
      assert.deepEqual(written.body.columns, []);
      assert.deepEqual(written.body.rows, []);
      assert.equal(written.body.affectedRows, 1);
      assert.equal(written.body.mode, 'live');
      assert.deepEqual((await query(id, 'SELECT * FROM coverage_roundtrip')).body.rows, [row]);
      await query(id, 'UPDATE coverage_roundtrip SET enabled = false');
      assert.deepEqual((await query(id, 'SELECT * FROM coverage_roundtrip')).body.rows, [
        { ...row, enabled: false },
      ]);
      await query(id, 'DELETE FROM coverage_roundtrip');
      const empty = await query(id, 'SELECT * FROM coverage_roundtrip');
      assert.deepEqual(empty.body.rows, []);
      assert.equal(empty.body.rowCount, 0);
      assert.equal(provider.statements.length - before, 6);
      let applied = 0;
      faults.sql = (sql) =>
        sql === 'INSERT INTO coverage_unknown VALUES (1)'
          ? (applied++, { disconnect: true })
          : undefined;
      const calls = provider.statements.length;
      await request(
        '/queries',
        {
          method: 'POST',
          token,
          body: { resourceId: id, sql: 'INSERT INTO coverage_unknown VALUES (1)' },
        },
        502,
        'SQL_EXECUTION_FAILED',
      );
      assert.equal(applied, 1);
      assert.equal(provider.statements.length, calls + 1);
      faults.sql = undefined;
    }
  });

  await exportCases(t, context);
  await importCases(t, context);
  await t.test(
    'API and Meta restart retain data and revocation while invalidating ephemeral reviews',
    async () => {
      await request('/files', {
        method: 'PUT',
        token,
        body: {
          resourceId: 'fs_shared',
          path: '/durable.txt',
          type: 'file',
          content: 'durable 😀\r\n',
        },
      });
      const bytes = Buffer.from([0, 255, 1, 13, 10]);
      const filePath = '/files/content?resourceId=fs_live&path=/durable.bin';
      await request(filePath, {
        method: 'PUT',
        token,
        raw: bytes,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      await query('db_live', 'INSERT INTO coverage_roundtrip VALUES (1)');
      const revoked = await key('coverage-revoked-before-restart');
      await revokeAndConfirmRegion(f, revoked.data);
      await request(
        '/files?resourceId=fs_live',
        { token: revoked.secret },
        401,
        'INVALID_CREDENTIAL',
      );
      const review = (await upload()).body;
      const creates = { ...provider.nativeCreates, files: provider.creates };
      await f.restart();
      assert.equal(
        (await request('/files?resourceId=fs_shared', { token })).body.data.find(
          (file) => file.path === '/durable.txt',
        ).content,
        'durable 😀\r\n',
      );
      assert.deepEqual((await request(filePath, { token })).body, bytes);
      assert.deepEqual((await query('db_live', 'SELECT * FROM coverage_roundtrip')).body.rows, [
        row,
      ]);
      const before = provider.calls;
      await request(
        '/files?resourceId=fs_live',
        { token: revoked.secret },
        401,
        'INVALID_CREDENTIAL',
      );
      await request(
        '/files?resourceId=fs_live',
        { token: 'expired-coverage-key' },
        401,
        'INVALID_CREDENTIAL',
      );
      await request('/files?resourceId=fs_live', { token }, 401, 'INVALID_CREDENTIAL', 1);
      await request(
        '/database-imports',
        { method: 'POST', token, body: commit(review, 'lost_review') },
        409,
        'IMPORT_PREPARATION_UNAVAILABLE',
      );
      assert.equal(provider.calls, before);
      const fresh = (await upload()).body;
      await request('/database-imports', {
        method: 'POST',
        token,
        body: commit(fresh, 'new_review'),
      });
      assert.deepEqual({ ...provider.nativeCreates, files: provider.creates }, creates);
    },
  );
  await t.test(
    'acknowledged files and Workspace keys survive abrupt process loss with explicit writer recovery',
    async () => {
      const other = await key('coverage-other-crash-key', ['fs_shared'], ['files:read'], 1);
      await request('/files', {
        method: 'PUT',
        token,
        body: {
          resourceId: 'fs_shared',
          path: '/crash-ack.txt',
          type: 'file',
          content: 'acknowledged before SIGKILL 😀',
        },
      });
      const creates = { ...provider.nativeCreates, files: provider.creates };
      await f.restart({ crash: true });
      assert.equal(
        (await request('/files?resourceId=fs_shared', { token })).body.data.find(
          (file) => file.path === '/crash-ack.txt',
        ).content,
        'acknowledged before SIGKILL 😀',
      );
      assert.equal(
        (await request('/files?resourceId=fs_shared', { token: other.secret }, 200, undefined, 1))
          .body.data[0].content,
        'ws_other',
      );
      assert.deepEqual((await query('db_live', 'SELECT * FROM coverage_roundtrip')).body.rows, [
        row,
      ]);
      assert.deepEqual({ ...provider.nativeCreates, files: provider.creates }, creates);
    },
  );
}
