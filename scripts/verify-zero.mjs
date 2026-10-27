import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// Explicit operator invocation only. Never provisions instances, loads native passwords, or runs in CI.
const [origin, resourceId, fileSystemId] = process.argv.slice(2);
const url = new URL(origin || 'http://invalid');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !resourceId)
  throw new Error(
    'Usage: node scripts/verify-zero.mjs <loopback-origin> <zero-resource-id> [live-filesystem-id]',
  );
const base = '/api/v1/workspaces/ws_agentlab';
const session = await fetch(origin + '/api/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
});
const cookie = session.headers.get('set-cookie').split(';')[0];
const keys = [];
async function call(path, method = 'GET', input, token) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }),
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
async function key(scopes, resourceIds) {
  const result = await call(base + '/keys', 'POST', {
    name: 'zero-verification',
    scopes,
    resourceIds,
    expiresInDays: 7,
  });
  assert.equal(result.status, 201);
  keys.push(result.body.data.id);
  return result.body;
}
const sql = (text, token) => call(base + '/queries', 'POST', { resourceId, sql: text }, token);
const table = `verify_${randomBytes(6).toString('hex')}`;
let created = false,
  full;
try {
  const resources = (await call(base + '/resources')).body.data;
  assert.equal(resources.find((r) => r.id === resourceId)?.provider, 'tidb-cloud-zero');
  assert.ok(!resources.some((r) => r.kind === 'postgresql'));
  full = await key(
    ['queries:execute', 'files:read', 'files:write'],
    [resourceId, ...(fileSystemId ? [fileSystemId] : [])],
  );
  const execute = async (query) => {
    const result = await sql(query, full.secret);
    assert.equal(result.status, 200, result.body.error?.code);
    assert.equal(result.body.mode, 'live');
    return result.body;
  };
  await execute(`CREATE TABLE ${table} (id INT PRIMARY KEY, note VARCHAR(200))`);
  created = true;
  assert.equal(
    (await execute(`INSERT INTO ${table} VALUES (1, 'Created through a Workspace Key')`))
      .affectedRows,
    1,
  );
  assert.equal(
    (await execute(`SELECT * FROM ${table}`)).rows[0].note,
    'Created through a Workspace Key',
  );
  assert.equal(
    (await execute(`UPDATE ${table} SET note = 'Updated through real SQL' WHERE id = 1`))
      .affectedRows,
    1,
  );
  assert.equal(
    (await execute(`SELECT note FROM ${table} WHERE id = 1`)).rows[0].note,
    'Updated through real SQL',
  );
  assert.equal((await execute(`DELETE FROM ${table} WHERE id = 1`)).affectedRows, 1);
  assert.equal((await execute(`SELECT * FROM ${table}`)).rowCount, 0);
  assert.equal((await sql('SELECT * FROM mysql.user', full.secret)).status, 403);
  assert.equal((await sql('CREATE DATABASE workspace_escape', full.secret)).status, 403);
  assert.equal((await sql('BROKEN SQL', full.secret)).body.error.code, 'SQL_SYNTAX_ERROR');
  assert.equal((await sql('SELECT 1; SELECT 2', full.secret)).status, 422);
  assert.equal(
    (await sql("SELECT REPEAT('x', 1048577) AS oversized", full.secret)).body.error.code,
    'RESULT_TOO_LARGE',
  );
  assert.equal((await sql('SELECT SLEEP(20)', full.secret)).body.error.code, 'SQL_TIMEOUT');
  const denied = await key(['resources:read'], [resourceId]);
  assert.equal((await sql('SELECT 1', denied.secret)).status, 403);
  const other = resources.find((r) => r.id !== resourceId);
  const wrong = await key(['queries:execute'], [other.id]);
  assert.equal((await sql('SELECT 1', wrong.secret)).status, 403);
  if (fileSystemId) {
    const path = `/zero-sql-verification-${randomBytes(4).toString('hex')}.md`;
    const content =
      '# Workspace Key verification\n\nThe same scoped key executed real MySQL SQL and wrote this file.\n';
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
    const preview = await call(
      base + `/files/content?resourceId=${fileSystemId}&path=${encodeURIComponent(path)}&preview=1`,
      'GET',
      undefined,
      full.secret,
    );
    assert.equal(preview.body.content, content);
    console.log('One Workspace Key: live MySQL and File System read/write passed.');
  }
  await execute(`DROP TABLE ${table}`);
  created = false;
  await call(base + '/keys/' + full.data.id, 'DELETE');
  assert.equal((await sql('SELECT 1', full.secret)).status, 401);
  console.log(
    'Zero CRUD/DDL, isolation, syntax, limits, timeout, scopes and revocation passed. Test table removed.',
  );
} finally {
  if (created && full) {
    const cleanup = await sql(`DROP TABLE ${table}`, full.secret);
    if (cleanup.status !== 200) console.error(`Cleanup needed for task-owned table ${table}.`);
  }
  for (const id of keys) await call(base + '/keys/' + id, 'DELETE');
}
