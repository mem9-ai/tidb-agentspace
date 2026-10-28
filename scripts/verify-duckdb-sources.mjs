import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

// Explicit loopback acceptance, using only the Workspace API and synthetic task-owned files.
const [origin, databaseId, fileSystemId, existingDirectory] = process.argv.slice(2);
if (
  !['localhost', '127.0.0.1'].includes(new URL(origin || 'http://invalid').hostname) ||
  !databaseId ||
  !fileSystemId
)
  throw Error(
    'Usage: node scripts/verify-duckdb-sources.mjs LOOPBACK_ORIGIN DUCKDB_ID FILESYSTEM_ID',
  );
const base = origin + '/api/v1/workspaces/ws_agentlab';
const session = await fetch(origin + '/api/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
});
const cookie = session.headers.get('set-cookie').split(';')[0];
async function call(path, method = 'GET', body, token) {
  const r = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: await r.json() };
}
const keys = [];
async function key(scopes, resourceIds) {
  const r = await call('/keys', 'POST', {
    name: 'file-query-verification',
    scopes,
    resourceIds,
    expiresInDays: 7,
  });
  assert.equal(r.status, 201);
  keys.push(r.body.data.id);
  return r.body;
}
if (existingDirectory && !/^\/duckdb-query-demo-[a-f0-9]{8}$/.test(existingDirectory))
  throw Error('Resume only a known task-owned verification directory.');
const directory = existingDirectory || '/duckdb-query-demo-' + randomBytes(4).toString('hex');
const files = new Map();
const rows = [
  { id: 1, region: 'APAC', amount: 10 },
  { id: 2, region: 'APAC', amount: 20 },
  { id: 3, region: 'EU', amount: 20 },
  { id: 4, region: 'EU', amount: null },
];
files.set('orders.csv', Buffer.from('id,region,amount\n1,APAC,10\n2,APAC,20\n3,EU,20\n4,EU,\n'));
files.set('orders.json', Buffer.from(JSON.stringify(rows)));
files.set('orders.ndjson', Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n')));
const temp = await mkdtemp(join(tmpdir(), 'duckdb-source-acceptance-'));
let engine, connection;
try {
  engine = await DuckDBInstance.create(':memory:');
  connection = await engine.connect();
  const parquet = join(temp, 'orders.parquet');
  await connection.run(
    `COPY (SELECT * FROM (VALUES (1,'APAC',10),(2,'APAC',20),(3,'EU',20),(4,'EU',NULL)) t(id,region,amount)) TO '${parquet}' (FORMAT PARQUET)`,
  );
  files.set('orders.parquet', await readFile(parquet));
} finally {
  connection?.closeSync();
  engine?.closeSync();
  await rm(temp, { recursive: true, force: true });
}
const sources = (suffix, name = 'orders') => [
  { name, resourceId: fileSystemId, path: directory + '/orders.' + suffix },
];
const query = (sources, sql, token) =>
  call('/queries', 'POST', { resourceId: databaseId, sql, sources }, token);
try {
  const full = await key(
    ['resources:read', 'queries:execute', 'files:read', 'files:analyze', 'files:write'],
    [databaseId, fileSystemId],
  );
  if (!existingDirectory)
    assert.equal(
      (
        await call(
          '/files',
          'PUT',
          { resourceId: fileSystemId, path: directory, type: 'directory' },
          full.secret,
        )
      ).status,
      200,
    );
  for (const [name, bytes] of files) {
    if (existingDirectory) {
      const r = await fetch(
        base +
          '/files/content?' +
          new URLSearchParams({ resourceId: fileSystemId, path: directory + '/' + name }),
        { headers: { Authorization: `Bearer ${full.secret}` } },
      );
      assert.equal(r.status, 200);
      files.set(name, Buffer.from(await r.arrayBuffer()));
      continue;
    }
    const r = await fetch(
      base +
        '/files/content?' +
        new URLSearchParams({ resourceId: fileSystemId, path: directory + '/' + name }),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${full.secret}`,
          'Content-Type': 'application/octet-stream',
          'If-None-Match': '*',
        },
        body: bytes,
      },
    );
    assert.equal(r.status, 200, name);
    await r.arrayBuffer();
  }
  console.log(
    (existingDirectory ? 'Reusing' : 'Created') +
      ' synthetic CSV, JSON, NDJSON and Parquet at ' +
      directory,
  );
  for (const suffix of ['csv', 'json', 'ndjson', 'parquet']) {
    const r = await query(
      sources(suffix),
      'SELECT region,SUM(amount)::INTEGER AS total,COUNT(amount)::INTEGER AS non_null FROM files.orders GROUP BY region ORDER BY region',
      full.secret,
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.rows, [
      { region: 'APAC', total: 30, non_null: 2 },
      { region: 'EU', total: 20, non_null: 1 },
    ]);
    console.log(
      suffix + ': real aggregate and NULL handling passed (' + r.body.durationMs + ' ms)',
    );
  }
  const joined = await query(
    [
      ...sources('csv', 'csv_orders'),
      ...sources('json', 'json_orders'),
      ...sources('parquet', 'parquet_orders'),
    ],
    'SELECT COUNT(*)::INTEGER AS matched FROM files.csv_orders c JOIN files.json_orders j USING(id) JOIN files.parquet_orders p USING(id)',
    full.secret,
  );
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.rows[0].matched, 4);
  console.log('CSV / JSON / Parquet join passed (' + joined.body.durationMs + ' ms)');
  for (const [scopes, ids] of [
    [
      ['queries:execute', 'files:read'],
      [databaseId, fileSystemId],
    ],
    [['queries:execute', 'files:read', 'files:analyze'], [databaseId]],
    [['queries:execute', 'files:read', 'files:analyze'], [fileSystemId]],
  ])
    assert.equal(
      (await query(sources('csv'), 'SELECT * FROM files.orders', (await key(scopes, ids)).secret))
        .status,
      403,
    );
  for (const sql of [
    "SELECT * FROM read_text('/etc/passwd')",
    'CREATE TABLE forbidden AS SELECT * FROM files.orders',
  ])
    assert.equal((await query(sources('csv'), sql, full.secret)).status, 403);
  assert.equal(
    (await query(sources('csv'), 'SELECT * FROM range(1001)', full.secret)).body.error.code,
    'RESULT_TOO_LARGE',
  );
  const readBack = await fetch(
    base +
      '/files/content?' +
      new URLSearchParams({ resourceId: fileSystemId, path: directory + '/orders.parquet' }),
    { headers: { Authorization: `Bearer ${full.secret}` } },
  );
  assert.equal(readBack.status, 200);
  assert.deepEqual(Buffer.from(await readBack.arrayBuffer()), files.get('orders.parquet'));
  await call('/keys/' + full.data.id, 'DELETE');
  assert.equal(
    (await query(sources('csv'), 'SELECT * FROM files.orders', full.secret)).status,
    401,
  );
  console.log(
    'Scopes, both resource grants, native read-only/host denial, output bound, original bytes and revocation passed.',
  );
  console.log('Verification files retained for Console inspection: ' + directory);
} finally {
  for (const id of keys) await call('/keys/' + id, 'DELETE');
}
