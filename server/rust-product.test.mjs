import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import Ajv2020 from 'ajv/dist/2020.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './index.mjs';
import { seed } from './store.mjs';
import { metaFixture, port, until } from './test-support/meta-fixture.mjs';
import { migrateLegacy } from './meta/migrate.mjs';
import { documentScope, decodeDocument } from './meta/document-store.mjs';
const contract = JSON.parse(
  await readFile(new URL('../public/openapi.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
const operations = Object.entries(contract.paths).flatMap(([path, entry]) => {
  const root = entry.servers?.[0].url || contract.servers[0].url;
  const full = root.replace(/\/$/, '') + path;
  return Object.entries(entry)
    .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
    .map(([method, op]) => ({
      method: method.toUpperCase(),
      pattern: new RegExp('^' + full.replace(/\{[^}]+\}/g, '[^/]+') + '$'),
      op,
    }));
});
function validateResponse(path, method, status, body) {
  const entry = operations.find((e) => e.method === method && e.pattern.test(path.split('?')[0]));
  const schema = (entry?.op.responses[status] || entry?.op.responses.default)?.content?.[
    'application/json'
  ]?.schema;
  if (!schema) return;
  const validate = ajv.compile({ ...schema, components: contract.components });
  assert.ok(validate(body), `${method} ${path}: ${ajv.errorsText(validate.errors)}`);
}
const base = '/api/v1/workspaces/ws_agentlab';
const secret = 'retained-public-workspace-key';
const nativeSecret = 'private-native-token-not-for-public-output';
const suffixes = ['', '.providers.json', '.databases.json', '.duckdb.json', '.db9.json'];
const privateWrite = (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
async function providerFixture() {
  const files = new Map();
  let statements = [];
  let creates = 0;
  let calls = 0;
  let lost = false;
  const databases = [];
  let nativeCreates = { zero: 0, db9: 0, account: 0 };
  const reset = () => {
    files.clear();
    files.set('/live.csv', Buffer.from('name,n\nalice,1\nbob,2\n'));
    files.set('/binary.bin', Buffer.from([0, 255, 13, 10]));
    statements = [];
    creates = 0;
    calls = 0;
  };
  reset();
  const sql = (binding, statement) => {
    statements.push(statement);
    if (/FROM pg_roles/i.test(statement))
      return {
        columns: ['rolsuper', 'rolcreatedb', 'rolcreaterole'],
        rows: [{ rolsuper: false, rolcreatedb: false, rolcreaterole: false }],
        rowCount: 1,
        affectedRows: 0,
      };
    if (statement.includes('AS owned'))
      return { columns: ['owned'], rows: [{ owned: true }], rowCount: 1, affectedRows: 0 };
    if (statement.includes('AS recordKind')) {
      assert.equal(statement.match(/TABLE_SCHEMA = DATABASE\(\)/g)?.length, 3);
      return {
        columns: ['recordKind', 'name', 'type'],
        rows: [
          {
            recordKind: 'column',
            name: 'id',
            type: 'integer',
            nullable: 'NO',
            defaultValue: null,
            columnKey: 'PRI',
            extra: '',
            position: 1,
          },
          {
            recordKind: 'index',
            name: 'PRIMARY',
            nonUnique: 0,
            columnName: 'id',
            position: 1,
            prefixLength: null,
          },
          { recordKind: 'table', name: 'demo_table', type: 'BASE TABLE' },
        ],
        rowCount: 3,
        affectedRows: 0,
      };
    }
    if (/information_schema\.(TABLES|tables)/.test(statement))
      return {
        columns: ['name', 'type'],
        rows: [{ name: 'demo_table', type: 'BASE TABLE' }],
        rowCount: 1,
        affectedRows: 0,
      };
    if (/information_schema\.(COLUMNS|columns)/.test(statement))
      return {
        columns: ['name', 'type', 'nullable', 'defaultValue', 'columnKey', 'extra', 'position'],
        rows: [
          {
            name: 'id',
            type: 'integer',
            nullable: 'NO',
            defaultValue: null,
            columnKey: 'PRI',
            extra: '',
            position: 1,
          },
        ],
        rowCount: 1,
        affectedRows: 0,
      };
    if (statement.includes('information_schema.STATISTICS'))
      return {
        columns: ['name', 'nonUnique', 'columnName', 'position', 'prefixLength'],
        rows: [
          { name: 'PRIMARY', nonUnique: 0, columnName: 'id', position: 1, prefixLength: null },
        ],
        rowCount: 1,
        affectedRows: 0,
      };
    if (statement.includes('pg_catalog.pg_index'))
      return {
        columns: ['name', 'uniqueValue', 'primaryValue', 'positionKeys'],
        rows: [{ name: 'demo_pkey', uniqueValue: true, primaryValue: true, positionKeys: '1' }],
        rowCount: 1,
        affectedRows: 0,
      };
    if (/^\s*SELECT\s+1/i.test(statement)) {
      const alias = /\bAS\s+([a-z_]+)/i.exec(statement)?.[1] || '?column?';
      return { columns: [alias], rows: [{ [alias]: 1 }], rowCount: 1, affectedRows: 0 };
    }
    if (/^\s*SELECT\s+\*/i.test(statement))
      return { columns: ['id'], rows: [{ id: 1 }], rowCount: 1, affectedRows: 0 };
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: /^\s*INSERT/i.test(statement) ? 1 : 0,
    };
  };
  const server = http.createServer(async (req, res) => {
    calls++;
    const url = new URL(req.url, 'http://localhost');
    const respond = (status, value, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    };
    try {
      if (url.pathname === '/zero') {
        nativeCreates.zero++;
        if (lost) return req.socket.destroy();
        return respond(200, {
          instance: {
            id: 'mysql-created',
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
            connection: {
              host: 'created.tidbcloud.com',
              port: 4000,
              username: 'prefix.root',
              password: nativeSecret,
            },
          },
        });
      }
      if (url.pathname === '/customer/anonymous-register') {
        nativeCreates.account++;
        return respond(200, {
          anonymous_id: 'account',
          anonymous_secret: nativeSecret,
          token: 'account-token',
          expires_at: new Date(Date.now() + 86400000).toISOString(),
        });
      }
      if (url.pathname === '/customer/databases' && req.method === 'POST') {
        nativeCreates.db9++;
        let chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks));
        const id = 'pg' + databases.length;
        databases.push({
          id,
          name: body.name,
          connection_string: `postgresql://${id}.admin@pg.db9.io:5432/postgres`,
          admin_password: body.admin_password,
        });
        if (lost) return req.socket.destroy();
        return respond(200, databases.at(-1));
      }
      if (url.pathname === '/customer/databases') return respond(200, databases);
      if (url.pathname.startsWith('/customer/databases/'))
        return respond(
          200,
          databases.find((d) => d.id === url.pathname.split('/').at(-1)),
        );
      if (url.pathname === '/sql') {
        let chunks = [];
        for await (const c of req) chunks.push(c);
        const input = JSON.parse(Buffer.concat(chunks));
        return respond(200, sql(input.binding, input.sql));
      }
      if (url.pathname === '/v1/status')
        return respond(200, {
          status: 'active',
          max_upload_bytes: 1048576,
          inline_threshold: 1048576,
        });
      if (url.pathname === '/v1/provision') {
        creates++;
        if (lost) return req.socket.destroy();
        return respond(200, { api_key: nativeSecret, tenant_id: 'created-tenant' });
      }
      if (url.pathname.startsWith('/v1/fs')) {
        const path = decodeURIComponent(url.pathname.slice(6)) || '/';
        if (url.searchParams.get('list') === '1') {
          return respond(200, {
            entries: [...files]
              .filter(([p]) => (p.slice(0, p.lastIndexOf('/')) || '/') === path)
              .map(([p, b]) => ({
                name: p.split('/').pop(),
                size: b.length,
                isDir: false,
                mtime: 1770000000,
              })),
          });
        }
        if (req.method === 'PUT') {
          let chunks = [];
          for await (const c of req) chunks.push(c);
          if (req.headers['x-dat9-expected-revision'] === '0' && files.has(path))
            return respond(409, { error: 'exists' });
          files.set(path, Buffer.concat(chunks));
          return respond(200, {});
        }
        if (req.method === 'DELETE') {
          if (!files.has(path)) return respond(404, {});
          files.delete(path);
          return respond(200, {});
        }
        const b = files.get(path);
        if (!b) return respond(404, {});
        const revision = '"' + createHash('sha256').update(b).digest('hex') + '"';
        if (req.headers['if-match'] && req.headers['if-match'] !== revision)
          return respond(412, {});
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': b.length,
          'X-Dat9-IsDir': 'false',
          ETag: revision,
        });
        return res.end(req.method === 'HEAD' ? undefined : b);
      }
      return respond(404, {});
    } catch {
      respond(500, {});
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    reset,
    set lost(value) {
      lost = value;
    },
    get nativeCreates() {
      return nativeCreates;
    },
    get statements() {
      return statements;
    },
    get creates() {
      return creates;
    },
    get calls() {
      return calls;
    },
    transport: (url, options) =>
      fetch(origin + new URL(url).pathname + new URL(url).search, options),
    execute: async (binding, statement) => sql(binding, statement),
    close: () => new Promise((r) => server.close(r)),
  };
}
async function connect(origin) {
  const session = await fetch(origin + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  return async (path, { method = 'GET', body, token, headers = {}, binary = false } = {}) => {
    const r = await fetch(origin + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
    });
    const responseBody =
      binary && method === 'GET' ? Buffer.from(await r.arrayBuffer()) : await r.json();
    if (!binary) validateResponse(path, method, r.status, responseBody);
    return {
      status: r.status,
      body: responseBody,
      headers: r.headers,
    };
  };
}
async function scenarios(request, provider) {
  let trace = [];
  async function run(path, options, expected = 200) {
    const r = await request(path, options);
    assert.equal(r.status, expected, JSON.stringify({ path, status: r.status, body: r.body }));
    trace.push([path.replace(/preparation[^/]*/g, 'preparation'), r.status, r.body.error?.code]);
    return r;
  }
  const boot = await run(base + '/bootstrap');
  assert.equal(boot.body.resources.length, 6);
  assert.equal(boot.body.mode, 'hybrid');
  assert.equal(JSON.stringify(boot.body).includes(nativeSecret), false);
  const resources = await run(base + '/resources', { token: secret });
  assert.equal(resources.body.data.length, 6);
  await run(base + '/queries', {
    method: 'POST',
    token: secret,
    body: { resourceId: 'db_memory', sql: 'SELECT 1 AS connected' },
  });
  for (const id of ['db_live', 'db_pg']) {
    const q = await run(base + '/queries', {
      method: 'POST',
      token: secret,
      body: { resourceId: id, sql: 'SELECT 1 AS checked' },
    });
    assert.deepEqual(q.body.rows, [{ checked: 1 }]);
    assert.equal(q.body.mode, 'live');
    await run(base + `/resources/${id}/tables`);
    const beforeMetadata = provider.statements.length;
    const table = await run(base + `/resources/${id}/table?name=demo_table`);
    if (id === 'db_live') assert.equal(provider.statements.length - beforeMetadata, 1);
    assert.equal(table.body.columns[0].key, 'PRI');
    assert.equal(table.body.indexes[0].columns[0].name, 'id');
    assert.equal(table.body.recordKind, undefined);
    await run(base + `/resources/${id}/table/rows?name=demo_table`);
  }
  const file = {
    resourceId: 'fs_shared',
    path: '/orders.csv',
    type: 'file',
    content: 'name,n\nalice,1\nbob,2\n',
  };
  await run(base + '/files', { method: 'PUT', body: file });
  await run(base + '/files?resourceId=fs_shared');
  const preview = await run(base + '/files/tabular-preview?resourceId=fs_shared&path=/orders.csv');
  assert.equal(preview.body.rowCount, 2);
  assert.equal(preview.body.totalRows, null);
  assert.deepEqual(preview.body.columns, ['name', 'n']);
  const cap = await run(base + '/file-analyses/capabilities?resourceId=fs_shared&path=/orders.csv');
  assert.equal(cap.body.available, true);
  assert.deepEqual(
    cap.body.engines.map((e) => e.engine),
    ['duckdb', 'bash'],
  );
  const analyzed = await run(base + '/file-analyses', {
    method: 'POST',
    body: {
      resourceId: 'fs_shared',
      path: '/orders.csv',
      engine: 'duckdb',
      sql: 'SELECT count(*) AS n FROM file',
    },
  });
  assert.deepEqual(analyzed.body.rows, [{ n: '2' }]);
  for (const command of [
    'cat "$FILE"',
    'grep alice "$FILE" | wc -l',
    'printf changed > "$FILE"',
    'cat /etc/passwd',
  ]) {
    const result = await run(
      base + '/file-analyses',
      {
        method: 'POST',
        body: { resourceId: 'fs_shared', path: '/orders.csv', engine: 'bash', command },
      },
      command.includes('>') ? 422 : 200,
    );
    if (command === 'cat "$FILE"') assert.equal(result.body.stdout, file.content);
    else if (command.includes('wc -l')) assert.equal(result.body.stdout.trim(), '1');
    else if (!command.includes('>')) assert.notEqual(result.body.exitCode, 0);
  }
  await run(base + '/files?resourceId=fs_live');
  await run(base + '/files/content?resourceId=fs_live&path=/upload.txt', {
    method: 'PUT',
    body: Buffer.from('uploaded text\n'),
    binary: true,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  const nativePreview = await run(
    base + '/files/content?resourceId=fs_live&path=/upload.txt&preview=1',
  );
  assert.equal(nativePreview.body.content, 'uploaded text\n');
  const download = await request(base + '/files/content?resourceId=fs_live&path=/binary.bin', {
    binary: true,
  });
  assert.equal(download.status, 200);
  assert.deepEqual(download.body, Buffer.from([0, 255, 13, 10]));
  trace.push(['binary-download', download.status]);
  await run(base + '/file-exports', {
    method: 'POST',
    body: {
      source: { kind: 'original', resourceId: 'fs_shared', path: '/orders.csv' },
      target: { kind: 'filesystem', resourceId: 'fs_shared', path: '/copied.csv' },
    },
  });
  await run(
    base + '/file-exports',
    {
      method: 'POST',
      body: {
        source: { kind: 'original', resourceId: 'fs_shared', path: '/orders.csv' },
        target: { kind: 'filesystem', resourceId: 'fs_shared', path: '/copied.csv' },
      },
    },
    409,
  );
  for (const format of ['csv', 'json', 'jsonl']) {
    const r = await run(base + '/result-exports', {
      method: 'POST',
      body: {
        sourceResourceId: 'db_live',
        result: {
          columns: ['value', 'n'],
          rows: [
            { value: '=SUM(A1)', n: 1 },
            { value: 'quote"\nline', n: null },
            { value: '\ufeff=1', n: 3 },
          ],
        },
        target: { kind: 'download', format },
      },
    });
    assert.equal(r.body.format, format);
    assert.equal(r.body.rowCount, 3);
    trace.push([format, r.body.content, r.body.bytes, r.body.filename, r.body.mimeType]);
    if (format === 'csv') assert.match(r.body.content, /'=SUM/);
  }
  await run(base + '/result-exports', {
    method: 'POST',
    body: {
      sourceResourceId: 'db_live',
      result: { columns: ['name', 'n'], rows: [{ name: "O'Reilly", n: 42 }] },
      target: { kind: 'filesystem', resourceId: 'fs_live', path: '/result.csv', format: 'csv' },
    },
  });
  await run(base + '/result-exports', {
    method: 'POST',
    body: {
      sourceResourceId: 'db_live',
      result: { columns: ['name', 'n'], rows: [{ name: "O'Reilly", n: 42 }] },
      target: { kind: 'database', resourceId: 'db_live', table: 'export_probe' },
    },
  });
  const preparation = await run(base + '/file-exports/prepare', {
    method: 'POST',
    body: {
      source: { kind: 'original', resourceId: 'fs_shared', path: '/orders.csv' },
      parsing: { format: 'csv', header: true, delimiter: ',' },
    },
  });
  assert.equal(preparation.body.rowCount, 2);
  assert.deepEqual(
    preparation.body.fields.map((f) => f.type),
    ['TEXT', 'BIGINT'],
  );
  const commit = {
    preparationId: preparation.body.preparationId,
    confirmed: true,
    fields: preparation.body.fields,
    target: { kind: 'database', resourceId: 'db_pg', table: 'import_probe' },
  };
  await run(
    base + '/file-exports',
    { method: 'POST', body: { ...commit, target: { ...commit.target, table: '' } } },
    400,
  );
  await run(base + '/file-exports', { method: 'POST', body: commit });
  await run(base + '/file-exports', { method: 'POST', body: commit }, 409);
  await run(base + '/file-exports', {
    method: 'POST',
    body: {
      source: { kind: 'original', resourceId: 'fs_live', path: '/binary.bin' },
      target: { kind: 'filesystem', resourceId: 'fs_live', path: '/binary-copy.bin' },
    },
  });
  const binaryCopy = await request(
    base + '/files/content?resourceId=fs_live&path=/binary-copy.bin',
    { binary: true },
  );
  assert.equal(binaryCopy.status, 200);
  assert.deepEqual(binaryCopy.body, Buffer.from([0, 255, 13, 10]));
  const before = provider.calls;
  await run(base + '/files?resourceId=fs_live', { token: 'invalid' }, 401);
  await run('/api/v1/workspaces/other/resources', { token: secret }, 404);
  assert.equal(provider.calls, before);
  const key = await run(
    base + '/keys',
    {
      method: 'POST',
      body: {
        name: 'read-only',
        scopes: ['files:read'],
        resourceIds: ['fs_shared'],
        expiresInDays: 7,
      },
    },
    201,
  );
  await run(
    base + '/file-analyses',
    {
      method: 'POST',
      token: key.body.secret,
      body: {
        resourceId: 'fs_shared',
        path: '/orders.csv',
        engine: 'bash',
        command: 'cat "$FILE"',
      },
    },
    403,
  );
  await run(base + '/files', {
    method: 'DELETE',
    body: { resourceId: 'fs_shared', path: '/copied.csv' },
  });
  await run(base + '/usage');
  return trace;
}
for (const transport of ['remote', 'inProcess']) {
  test(
    `complete Rust API preserves Node data/analysis/export and credentials through ${transport} metadata`,
    { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
    async (t) => {
      const f = await metaFixture();
      const provider = await providerFixture();
      let child;
      let node;
      t.after(async () => {
        if (child && child.exitCode === null) {
          child.kill('SIGTERM');
          await new Promise((r) => child.once('exit', r));
        }
        if (node?.listening) await new Promise((r) => node.close(r));
        await provider.close();
        await f.close();
      });
      const state = seed();
      state.opaque = { preserve: 'original data' };
      state.resources.push(
        {
          id: 'fs_live',
          kind: 'filesystem',
          name: 'live-files',
          status: 'active',
          region: 'aws-ap-southeast-1',
          provider: 'drive9-anonymous',
          createdAt: state.workspace.createdAt,
        },
        {
          id: 'db_live',
          kind: 'mysql',
          name: 'live-mysql',
          status: 'active',
          region: 'automatic',
          provider: 'tidb-cloud-zero',
          createdAt: state.workspace.createdAt,
        },
        {
          id: 'db_pg',
          kind: 'postgresql',
          name: 'live-postgres',
          status: 'active',
          region: 'automatic',
          provider: 'db9-anonymous',
          createdAt: state.workspace.createdAt,
        },
        {
          id: 'db_duck',
          kind: 'duckdb',
          name: 'live-duckdb',
          status: 'active',
          region: 'aws-ap-southeast-1',
          provider: 'duckdb-drive9',
          createdAt: state.workspace.createdAt,
        },
      );
      state.keys = [
        {
          id: 'original-key',
          name: 'original',
          prefix: 'original',
          createdAt: state.workspace.createdAt,
          lastUsedAt: null,
          digest: createHash('sha256').update(secret).digest('hex'),
          scopes: [
            'resources:read',
            'resources:write',
            'files:read',
            'files:write',
            'files:analyze',
            'queries:execute',
            'usage:read',
          ],
          resourceIds: ['*'],
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          revokedAt: null,
        },
      ];
      const raw = [
        state,
        {
          bindings: {
            fs_live: { state: 'bound', apiKey: nativeSecret, tenantId: 'original' },
            private_duck: { state: 'bound', apiKey: nativeSecret, tenantId: 'original-private' },
          },
        },
        {
          bindings: {
            db_live: {
              state: 'ready',
              instanceId: 'original-mysql',
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
              connection: {
                kind: 'mysql',
                region: 'automatic',
                host: 'unit.fixture.tidbcloud.com',
                port: 4000,
                user: 'w_original',
                password: nativeSecret,
                database: 'workspace',
              },
            },
          },
        },
        { bindings: { db_duck: { state: 'ready', storageId: 'private_duck' } } },
        {
          bindings: {
            db_pg: {
              state: 'ready',
              instanceId: 'original-postgres',
              connection: {
                kind: 'postgresql',
                region: 'automatic',
                host: 'pg.db9.io',
                port: 5432,
                user: 'tenant.wabcdef123456',
                password: nativeSecret,
                database: 'postgres',
              },
            },
          },
        },
      ];
      const original = resolve(f.directory, 'workspace.json');
      const baseline = resolve(f.directory, 'baseline', 'workspace.json');
      await mkdir(resolve(f.directory, 'baseline'), { mode: 0o700 });
      for (let i = 0; i < raw.length; i++) {
        await privateWrite(original + suffixes[i], raw[i]);
        await privateWrite(baseline + suffixes[i], raw[i]);
      }
      node = await createApp({
        dataFile: baseline,
        filesProvider: 'drive9-anonymous',
        mysqlProvider: 'tidb-cloud-zero',
        postgresProvider: 'db9-anonymous',
        drive9Transport: provider.transport,
        zeroTransport: provider.transport,
        db9Transport: provider.transport,
        sqlExecute: provider.execute,
        postgresExecute: provider.execute,
      });
      await new Promise((r) => node.listen(0, '127.0.0.1', r));
      const expected = await scenarios(
        await connect(`http://127.0.0.1:${node.address().port}`),
        provider,
      );
      await new Promise((r) => node.close(r));
      const expectedResources = JSON.parse(await readFile(baseline)).resources;
      provider.reset();
      const global = await f.service('global');
      const region = await f.service('complete');
      const bridge = resolve(f.directory, 'bridge.json');
      await privateWrite(bridge, {
        format: 1,
        importId: 'complete-import',
        workspaceId: 'ws_agentlab',
        global: global.clientConfig,
        region: region.clientConfig,
        regionStorage: { engine: 'slatedb', bucket: region.server.s3.bucket, prefix: 'metadata' },
      });
      await migrateLegacy({
        sourceFile: original,
        configFile: bridge,
        backupDirectory: resolve(f.directory, 'backup'),
        sourceFrozen: true,
      });
      await global.stop();
      if (transport === 'inProcess') await region.stop();
      const regionConfig = resolve(f.directory, 'embedded-region.json');
      await privateWrite(regionConfig, region.server);
      const bind = await port();
      const config = resolve(f.directory, 'workspace-rust.json');
      await privateWrite(config, {
        bind: `127.0.0.1:${bind}`,
        workspaceId: 'ws_agentlab',
        authorityId: region.server.authorityId,
        importId: 'complete-import',
        insecureLoopback: true,
        consoleOrigins: ['http://127.0.0.1:5173'],
        metadata:
          transport === 'remote'
            ? { transport, client: region.clientConfig }
            : { transport, authorityId: region.server.authorityId },
        product: {
          providers: {
            filesProvider: 'drive9-anonymous',
            mysqlProvider: 'tidb-cloud-zero',
            postgresProvider: 'db9-anonymous',
            testMode: true,
            drive9Endpoint: provider.origin,
            sqlFixture: provider.origin + '/sql',
          },
        },
      });
      const deployment = resolve(f.directory, 'deployment.json');
      await privateWrite(deployment, {
        format: 1,
        services: [
          ...(transport === 'inProcess' ? [{ kind: 'metadata', configFile: regionConfig }] : []),
          { kind: 'workspace', configFile: config },
        ],
      });
      const log = createWriteStream(resolve(f.directory, 'backend.log'), { mode: 0o600 });
      child = spawn(
        resolve('meta-service/target/debug/workspace-backend'),
        ['serve', '--config', deployment],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child.stdout.pipe(log);
      child.stderr.pipe(log);
      const request = await until(() => connect(`http://127.0.0.1:${bind}`));
      const actual = await scenarios(request, provider);
      assert.deepEqual(actual, expected);
      assert.equal(provider.creates, 0);
      const schema = await fetch(`http://127.0.0.1:${bind}/openapi.json`);
      assert.equal(schema.status, 200);
      assert.deepEqual(await schema.json(), JSON.parse(await readFile('public/openapi.json')));
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
      const verifier =
        transport === 'inProcess' ? await f.service('verify', { previous: region }) : region;
      for (let i = 1; i < raw.length; i++) {
        const snap = await verifier.client.call({
          op: 'snapshot',
          scope: documentScope(
            region.server.authorityId,
            'ws_agentlab',
            ['workspace', 'drive9', 'zero', 'duckdb', 'db9'][i],
          ),
        });
        assert.deepEqual(JSON.parse(decodeDocument(snap)), raw[i]);
      }
      const final = JSON.parse(
        decodeDocument(
          await verifier.client.call({
            op: 'snapshot',
            scope: documentScope(verifier.server.authorityId, 'ws_agentlab', 'workspace'),
          }),
        ),
      );
      assert.deepEqual(final.opaque, state.opaque);
      assert.deepEqual(final.resources, expectedResources);
      assert.deepEqual(final.keys[0].resourceIds, ['*']);
      assert.equal(final.keys[0].digest, state.keys[0].digest);
    },
  );
}

test(
  'Rust provider lifecycle retains one creation intent across retries, unknown responses and restart',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const f = await metaFixture();
    const provider = await providerFixture();
    let child;
    t.after(async () => {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((r) => child.once('exit', r));
      }
      await provider.close();
      await f.close();
    });
    const source = resolve(f.directory, 'workspace.json');
    const state = seed();
    state.resources = [];
    state.files = [];
    for (let i = 0; i < suffixes.length; i++)
      await privateWrite(source + suffixes[i], i === 0 ? state : { bindings: {} });
    const global = await f.service('global');
    const region = await f.service('lifecycle');
    const bridge = resolve(f.directory, 'bridge.json');
    await privateWrite(bridge, {
      format: 1,
      importId: 'lifecycle',
      workspaceId: 'ws_agentlab',
      global: global.clientConfig,
      region: region.clientConfig,
      regionStorage: { engine: 'slatedb', bucket: region.server.s3.bucket, prefix: 'metadata' },
    });
    await migrateLegacy({
      sourceFile: source,
      configFile: bridge,
      backupDirectory: resolve(f.directory, 'backup'),
      sourceFrozen: true,
    });
    await global.stop();
    const bind = await port();
    const config = resolve(f.directory, 'rust.json');
    await privateWrite(config, {
      bind: `127.0.0.1:${bind}`,
      workspaceId: 'ws_agentlab',
      authorityId: region.server.authorityId,
      importId: 'lifecycle',
      insecureLoopback: true,
      consoleOrigins: ['http://127.0.0.1:5173'],
      metadata: { transport: 'remote', client: region.clientConfig },
      product: {
        providers: {
          filesProvider: 'drive9-anonymous',
          mysqlProvider: 'tidb-cloud-zero',
          postgresProvider: 'db9-anonymous',
          testMode: true,
          drive9Endpoint: provider.origin,
          zeroEndpoint: provider.origin + '/zero',
          db9Endpoint: provider.origin + '/customer',
          sqlFixture: provider.origin + '/sql',
        },
      },
    });
    const plan = resolve(f.directory, 'plan.json');
    await privateWrite(plan, { format: 1, services: [{ kind: 'workspace', configFile: config }] });
    async function start() {
      child = spawn(
        resolve('meta-service/target/debug/workspace-backend'),
        ['serve', '--config', plan],
        { stdio: 'ignore' },
      );
      return until(() => connect(`http://127.0.0.1:${bind}`));
    }
    let request = await start();
    const create = (kind, name, key) =>
      request(base + '/resources', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: { kind, name, region: kind === 'filesystem' ? 'aws-ap-southeast-1' : 'automatic' },
      });
    const pg = await create('postgresql', 'known-postgres', 'pg');
    assert.equal(pg.status, 201);
    assert.equal(pg.body.data.status, 'active');
    const mysql = await create('mysql', 'known-mysql', 'mysql');
    assert.equal(mysql.status, 201);
    assert.equal(mysql.body.data.status, 'active');
    assert.equal((await create('mysql', 'known-mysql', 'mysql')).body.data.id, mysql.body.data.id);
    assert.equal((await create('mysql', 'changed-name', 'mysql')).status, 409);
    provider.lost = true;
    const unknownPg = await create('postgresql', 'unknown-postgres', 'lost-pg');
    assert.equal(unknownPg.status, 201);
    assert.notEqual(unknownPg.body.data.status, 'active');
    const unknownZero = await create('mysql', 'unknown-mysql', 'lost-zero');
    assert.equal(unknownZero.status, 201);
    assert.notEqual(unknownZero.body.data.status, 'active');
    const unknownFile = await create('filesystem', 'unknown-files', 'lost-file');
    assert.equal(unknownFile.status, 201);
    assert.notEqual(unknownFile.body.data.status, 'active');
    provider.lost = false;
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    request = await start();
    const recovered = await request(base + `/resources/${unknownPg.body.data.id}/setup`, {
      method: 'POST',
      body: {},
    });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.data.status, 'active');
    assert.notEqual(
      (
        await request(base + `/resources/${unknownZero.body.data.id}/setup`, {
          method: 'POST',
          body: {},
        })
      ).body.data.status,
      'active',
    );
    await create('filesystem', 'unknown-files', 'lost-file');
    assert.deepEqual(provider.nativeCreates, { zero: 2, db9: 2, account: 1 });
    assert.equal(provider.creates, 1);
    const unavailable = await request(base + '/resources', {
      method: 'POST',
      body: { kind: 'duckdb', name: 'unavailable-duckdb', region: 'aws-ap-southeast-1' },
    });
    assert.equal(unavailable.status, 503);
    assert.equal(provider.creates, 1);
    const list = await request(base + '/resources');
    assert.equal(list.body.data.length, 5);
    assert.equal(JSON.stringify(list.body).includes(nativeSecret), false);
  },
);
