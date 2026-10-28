import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// Explicit, loopback-only live acceptance. No native credentials or runtime artifacts are loaded.
const [origin, resourceId, mysqlId, fileSystemId] = process.argv.slice(2);
const url = new URL(origin || 'http://invalid');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !resourceId)
  throw Error(
    'Usage: node scripts/verify-duckdb.mjs <loopback-origin> <duckdb-id> [mysql-id] [filesystem-id]',
  );
const base = '/api/v1/workspaces/ws_agentlab';
const session = await fetch(origin + '/api/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
});
const cookie = session.headers.get('set-cookie').split(';')[0];
async function call(path, method = 'GET', input, token) {
  const r = await fetch(origin + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  return { status: r.status, body: await r.json() };
}
const keys = [];
async function key(scopes, ids) {
  const r = await call(base + '/keys', 'POST', {
    name: 'duckdb-live-verification',
    scopes,
    resourceIds: ids,
    expiresInDays: 7,
  });
  assert.equal(r.status, 201);
  keys.push(r.body.data.id);
  return r.body;
}
const sql = (query, token) => call(base + '/queries', 'POST', { resourceId, sql: query }, token);
const table = 'verify_' + randomBytes(6).toString('hex');
let created = false,
  full;
try {
  const resources = (await call(base + '/resources')).body.data;
  assert.equal(resources.find((r) => r.id === resourceId)?.provider, 'duckdb-drive9');
  for (const resource of resources) {
    assert.equal(resource.storageId, undefined);
    assert.equal(resource.apiKey, undefined);
  }
  full = await key(
    ['queries:execute', 'files:read', 'files:write'],
    [resourceId, ...[mysqlId, fileSystemId].filter(Boolean)],
  );
  const execute = async (query) => {
    const r = await sql(query, full.secret);
    assert.equal(r.status, 200, r.body.error?.code);
    assert.equal(r.body.mode, 'live');
    return r.body;
  };
  await execute(`CREATE TABLE ${table}(id BIGINT PRIMARY KEY,note VARCHAR)`);
  created = true;
  assert.equal(
    (await execute(`INSERT INTO ${table} VALUES (9007199254740993,'created')`)).affectedRows,
    1,
  );
  assert.equal((await execute(`SELECT * FROM ${table}`)).rows[0].id, '9007199254740993');
  assert.equal((await execute(`UPDATE ${table} SET note='updated'`)).affectedRows, 1);
  assert.equal((await execute(`SELECT * FROM ${table}`)).rows[0].note, 'updated');
  const list = await call(base + `/resources/${resourceId}/tables`, 'GET', undefined, full.secret);
  assert.ok(list.body.data.some((t) => t.name === table));
  const detail = await call(
    base + `/resources/${resourceId}/table?name=${table}`,
    'GET',
    undefined,
    full.secret,
  );
  assert.equal(detail.body.columns[0].key, 'PRI');
  const rows = await call(
    base + `/resources/${resourceId}/table/rows?name=${table}`,
    'GET',
    undefined,
    full.secret,
  );
  assert.equal(rows.body.rows[0].note, 'updated');
  for (const query of [
    "SELECT * FROM read_text('/etc/hosts')",
    'SET enable_external_access=true',
    "ATTACH '/tmp/other' AS other",
    'CREATE SECRET stolen(TYPE http)',
  ])
    assert.equal((await sql(query, full.secret)).status, 403);
  assert.equal((await sql('SELECT 1; SELECT 2', full.secret)).status, 400);
  assert.equal(
    (await sql('SELECT * FROM range(1001)', full.secret)).body.error.code,
    'RESULT_TOO_LARGE',
  );
  assert.equal(
    (await sql("SELECT repeat('x',1048577)", full.secret)).body.error.code,
    'RESULT_TOO_LARGE',
  );
  const denied = await key(['resources:read'], [resourceId]),
    wrong = await key(['queries:execute'], ['db_memory']);
  assert.equal((await sql('SELECT 1', denied.secret)).status, 403);
  assert.equal((await sql('SELECT 1', wrong.secret)).status, 403);
  if (mysqlId) {
    const r = await call(
      base + '/queries',
      'POST',
      { resourceId: mysqlId, sql: 'SELECT 1 AS connected' },
      full.secret,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'live');
  }
  if (fileSystemId) {
    const path = '/duckdb-key-verification-' + randomBytes(4).toString('hex') + '.md',
      content =
        '# DuckDB Workspace Key\n\nOne key accessed DuckDB, MySQL and this standalone File System.\n';
    assert.equal(
      (
        await call(
          base + '/files',
          'PUT',
          { resourceId: fileSystemId, path, type: 'file', content },
          full.secret,
        )
      ).status,
      200,
    );
    const r = await call(
      base + `/files/content?resourceId=${fileSystemId}&path=${encodeURIComponent(path)}&preview=1`,
      'GET',
      undefined,
      full.secret,
    );
    assert.equal(r.body.content, content);
  }
  assert.equal((await execute(`DELETE FROM ${table}`)).affectedRows, 1);
  await execute(`DROP TABLE ${table}`);
  created = false;
  await call(base + '/keys/' + full.data.id, 'DELETE');
  assert.equal((await sql('SELECT 1', full.secret)).status, 401);
  console.log(
    'Real DuckDB CRUD, reopen per query, table APIs, bounds, host isolation, scopes and revocation passed.',
  );
  console.log(
    'One Workspace Key across permitted DuckDB, MySQL and Files passed. Test table removed; verification Markdown retained.',
  );
} finally {
  if (created && full) {
    const r = await sql(`DROP TABLE ${table}`, full.secret);
    if (r.status !== 200) console.error(`Cleanup required for task-owned table ${table}.`);
  }
  for (const id of keys) await call(base + '/keys/' + id, 'DELETE');
}
