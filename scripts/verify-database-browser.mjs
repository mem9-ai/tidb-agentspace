// Explicit live verification only; never runs in CI or provisions a cloud instance.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const [origin, resourceId] = process.argv.slice(2);
if (!origin || !resourceId || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
  throw new Error(
    'Usage: node scripts/verify-database-browser.mjs http://127.0.0.1:PORT RESOURCE_ID',
  );
const base = '/api/v1/workspaces/ws_agentlab';
const session = await fetch(origin + '/api/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
});
assert.equal(session.status, 200);
const cookie = session.headers.get('set-cookie').split(';')[0];
async function request(path, { method = 'GET', body, token, status = 200 } = {}) {
  const response = await fetch(origin + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(65000),
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(
    response.status,
    status,
    result.error?.code ?? `Unexpected HTTP status for ${method}`,
  );
  return result;
}
const resources = await request(base + '/resources');
assert.ok(
  resources.data.some(
    (resource) => resource.id === resourceId && resource.provider === 'tidb-cloud-zero',
  ),
);
const table = `browser_${randomBytes(5).toString('hex')} \`notes`;
const quoted = '`' + table.replaceAll('`', '``') + '`';
const keys = [];
let created = false;
console.log(`Temporary verification table: ${table}`);
async function key(scopes) {
  const result = await request(base + '/keys', {
    method: 'POST',
    status: 201,
    body: {
      name: 'database-browser-verification',
      scopes,
      resourceIds: [resourceId],
      expiresInDays: 7,
    },
  });
  keys.push(result.data.id);
  return result;
}
try {
  const access = await key(['queries:execute']);
  const token = access.secret;
  const query = (sql) =>
    request(base + '/queries', { method: 'POST', body: { resourceId, sql }, token });
  await query(
    `CREATE TABLE ${quoted} (id BIGINT PRIMARY KEY, label VARCHAR(40) NULL DEFAULT '', amount DECIMAL(20,4) NOT NULL DEFAULT 1.2500, payload LONGTEXT, INDEX by_label (label(10), id))`,
  );
  created = true;
  const path = `${base}/resources/${resourceId}`;
  const tablePath = path + '/tables/' + encodeURIComponent(table);
  const detail = await request(tablePath, { token });
  assert.equal(detail.name, table);
  assert.equal(detail.mode, 'live');
  assert.equal(detail.query, `SELECT * FROM ${quoted} LIMIT 100;`);
  assert.equal(detail.columns.find((column) => column.name === 'label').nullable, true);
  assert.equal(detail.columns.find((column) => column.name === 'label').default, '');
  assert.deepEqual(
    detail.indexes
      .find((index) => index.name === 'by_label')
      .columns.map((column) => [column.name, column.prefixLength]),
    [
      ['label', 10],
      ['id', null],
    ],
  );
  const empty = await request(tablePath + '/rows', { token });
  assert.equal(empty.rowCount, 0);
  assert.deepEqual(empty.columns, ['id', 'label', 'amount', 'payload']);
  const values = Array.from(
    { length: 101 },
    (_, index) => `(${9007199254740993n + BigInt(index)},${index === 0 ? 'NULL' : "'fixture'"})`,
  ).join(',');
  await query(`INSERT INTO ${quoted} (id, label) VALUES ${values}`);
  const rows = await request(tablePath + '/rows', { token });
  assert.equal(rows.rowCount, 100);
  assert.ok(rows.rows.every((row) => typeof row.id === 'string' && row.amount === '1.2500'));
  const list = await request(path + '/tables', { token });
  assert.ok(list.data.some((entry) => entry.name === table));
  const editor = await query(detail.query);
  assert.equal(editor.rowCount, 100);
  await query(`DELETE FROM ${quoted}`);
  await query(`INSERT INTO ${quoted} (id, payload) VALUES (1, REPEAT('x', 1048577))`);
  const oversize = await request(tablePath + '/rows', { token, status: 422 });
  assert.equal(oversize.error.code, 'RESULT_TOO_LARGE');
  const denied = await key(['resources:read']);
  await request(path + '/tables', { token: denied.secret, status: 403 });
  console.log(
    'PASS: real table/column/index reads, escaped table identity, empty and 100-row previews, exact BIGINT/DECIMAL values, editor query, 1 MiB limit and scope denial.',
  );
} finally {
  try {
    if (created) {
      await request(base + '/queries', {
        method: 'POST',
        body: { resourceId, sql: `DROP TABLE ${quoted}` },
      });
      console.log('Verification table removed.');
    }
  } finally {
    const revoked = await Promise.allSettled(
      keys.map((id) => request(base + '/keys/' + id, { method: 'DELETE' })),
    );
    if (revoked.some((result) => result.status === 'rejected')) {
      console.error(
        'Some verification keys could not be revoked. Revoke database-browser-verification keys in the Console.',
      );
      process.exitCode = 1;
    } else console.log('Temporary Workspace Keys revoked.');
  }
}
