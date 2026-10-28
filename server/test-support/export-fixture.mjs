import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../index.mjs';
import { seed } from '../store.mjs';
import { openDuckdb } from '../providers/duckdb-engine.mjs';

// Isolated provider-boundary fixture. No cloud credentials or requests are used.
export async function exportFixture({ port = 0, hooks = {}, delay = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'result-export-'));
  const dataFile = join(dir, 'state.json');
  const dbPath = join(dir, 'database.duckdb');
  const artifact = join(dir, 'runtime');
  const state = seed();
  state.workspace.name = 'Export verification';
  state.resources.push({
    id: 'fs_unavailable',
    name: 'Unavailable fixture',
    kind: 'filesystem',
    status: 'suspended',
    region: 'aws-ap-southeast-1',
    createdAt: new Date().toISOString(),
  });
  state.resources.push(
    ...[
      ['db_duck', 'DuckDB test', 'duckdb', 'duckdb-drive9', 'aws-ap-southeast-1'],
      ['db_mysql', 'MySQL test', 'mysql', 'tidb-cloud-zero', 'automatic'],
      ['db_pg', 'PostgreSQL test', 'postgresql', 'db9-anonymous', 'automatic'],
      [
        'fs_live',
        'Live File System fixture',
        'filesystem',
        'drive9-anonymous',
        'aws-ap-southeast-1',
      ],
    ].map(([id, name, kind, provider, region]) => ({
      id,
      name,
      kind,
      provider,
      region,
      status: 'active',
      createdAt: new Date().toISOString(),
    })),
  );
  state.files.push({
    id: 'csv',
    resourceId: 'fs_shared',
    path: '/orders.csv',
    type: 'file',
    content: 'region,total\nAPAC,30\nEU,20\n',
    updatedAt: new Date().toISOString(),
  });
  for (const [id, fields] of [
    ['expired', { expiresAt: '2000-01-01' }],
    ['revoked', { revokedAt: new Date().toISOString() }],
  ])
    state.keys.push({
      id,
      digest: createHash('sha256')
        .update(id + '-fixture')
        .digest('hex'),
      resourceIds: ['*'],
      scopes: ['queries:execute', 'files:read', 'files:write', 'files:analyze'],
      expiresAt: '2099-01-01',
      ...fields,
    });
  await writeFile(dataFile, JSON.stringify(state));
  await writeFile(artifact, 'fixture-runtime');
  const privateFile = (suffix, bindings) =>
    writeFile(dataFile + suffix, JSON.stringify({ bindings }), { mode: 0o600 });
  await privateFile('.duckdb.json', { db_duck: { storageId: 'hidden_storage', state: 'ready' } });
  await privateFile('.providers.json', {
    hidden_storage: { apiKey: 'internal-database-fixture' },
    fs_live: { apiKey: 'internal-file-fixture' },
  });
  const connection = {
    kind: 'mysql',
    region: 'automatic',
    host: 'fixture.tidbcloud.com',
    port: 4000,
    user: 'fixture',
    password: 'private-fixture',
    database: 'workspace',
  };
  await privateFile('.databases.json', {
    db_mysql: { state: 'ready', expiresAt: '2099-01-01', connection },
  });
  await privateFile('.db9.json', {
    db_pg: {
      state: 'ready',
      connection: {
        ...connection,
        kind: 'postgresql',
        host: 'pg.db9.io',
        port: 5432,
        user: 'fixture.w123456789abc',
        database: 'postgres',
      },
    },
  });
  const io = [],
    statements = [],
    files = new Map();
  const native = async (sql, readOnly = false) => {
    const engine = await openDuckdb({ localPath: dbPath, readOnly });
    try {
      return await engine.query(sql);
    } finally {
      engine.close();
    }
  };
  await native("CREATE TABLE sample AS SELECT 1 AS id, 'APAC' AS region, 30 AS total");
  const execute = async (kind, sql) => {
    statements.push({ kind, sql });
    if (delay && /^CREATE|^INSERT/.test(sql))
      await new Promise((resolve) => setTimeout(resolve, delay));
    await hooks.beforeSql?.(kind, sql);
    const result =
      kind === 'duckdb'
        ? await native(sql)
        : { columns: [], rows: [], rowCount: 0, affectedRows: /^INSERT/.test(sql) ? 1 : 0 };
    await hooks.afterSql?.(kind, sql);
    return result;
  };
  const options = {
    dataFile,
    duckdbExtensionPath: artifact,
    duckdbExtensionSha256: createHash('sha256').update('fixture-runtime').digest('hex'),
    duckdbExecute: async ({ sql, probe }) => (probe ? {} : execute('duckdb', sql)),
    sqlExecute: async (_, sql) => execute('mysql', sql),
    postgresExecute: async (_, sql) => execute('postgresql', sql),
    drive9Transport: async (url, input) => {
      const pathname = decodeURIComponent(new URL(url).pathname);
      io.push({ path: pathname, method: input.method || 'GET' });
      assert.equal(input.headers.Authorization, 'Bearer internal-file-fixture');
      if (pathname === '/v1/status') {
        await hooks.status?.();
        return Response.json({
          status: 'active',
          max_upload_bytes: hooks.uploadLimit ?? 1048576,
          inline_threshold: 1048576,
        });
      }
      const path = pathname.slice('/v1/fs'.length);
      if (input.method === 'PUT') {
        assert.equal(input.headers['X-Dat9-Expected-Revision'], '0');
        if (files.has(path)) return new Response('', { status: 412 });
        if (path.startsWith('/missing/')) return new Response('', { status: 404 });
        files.set(path, Buffer.from(input.body));
        return new Response('', { status: 201 });
      }
      return files.has(path) ? new Response(files.get(path)) : new Response('', { status: 404 });
    },
  };
  let app, origin, cookie;
  async function start() {
    app = await createApp(options);
    await new Promise((resolve) => app.listen(port, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${app.address().port}`;
    const session = await fetch(origin + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    cookie = session.headers.get('set-cookie').split(';')[0];
  }
  await start();
  const request = async (path, method = 'GET', body, token, signal) => {
    const response = await fetch(
      origin + (path.startsWith('/api/') ? path : '/api/v1/workspaces/ws_agentlab' + path),
      {
        method,
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  return {
    dir,
    dataFile,
    origin,
    hooks,
    files,
    io,
    statements,
    native,
    request,
    key: async (scopes, resourceIds) => {
      const response = await request('/keys', 'POST', {
        name: 'export-verification',
        scopes,
        resourceIds,
        expiresInDays: 7,
      });
      assert.equal(response.status, 201);
      return response.body;
    },
    restart: async () => {
      await new Promise((resolve) => app.close(resolve));
      await start();
    },
    close: async () => {
      await new Promise((resolve) => app.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
