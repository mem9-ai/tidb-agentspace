import { restWorkflowCases } from './test-support/rest-workflow-cases.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { workspaceFixture } from './test-support/workspace-fixture.mjs';
import { providerFixture, nativeSecret } from './test-support/provider-fixture.mjs';
import { metaFixture, port, until } from './test-support/meta-fixture.mjs';
import { seedRecords, readState, readBinding } from './test-support/record-fixture.mjs';
import { agentRestCases } from './test-support/agent-rest-cases.mjs';
import { productApiCases } from './test-support/product-api-cases.mjs';
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
const privateWrite = (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
for (const transport of ['remote', 'inProcess']) {
  test(
    `REST workflow resources through ${transport} metadata`,
    { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
    (t) => restWorkflowCases(t, transport),
  );
  test(
    `Agent REST P0 through ${transport} metadata`,
    { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
    (t) => agentRestCases(t, transport),
  );
  test(
    `OpenAPI behavioral coverage through ${transport} metadata`,
    { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
    (t) => productApiCases(t, transport),
  );
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
function parquetImportInput() {
  return readFile(new URL('./test-support/fixtures/import.parquet', import.meta.url));
}
async function scenarios(request, provider) {
  async function run(
    path,
    options,
    expected = options?.method === 'POST' && path.split('?')[0].endsWith('-preparations')
      ? 201
      : 200,
  ) {
    const r = await request(path, options);
    assert.equal(
      r.status,
      expected,
      JSON.stringify({ path, command: options?.body?.command, status: r.status, body: r.body }),
    );
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
    const table = await run(base + `/resources/${id}/tables/demo_table`);
    if (id === 'db_live') assert.equal(provider.statements.length - beforeMetadata, 1);
    assert.equal(table.body.columns[0].key, 'PRI');
    assert.equal(table.body.indexes[0].columns[0].name, 'id');
    assert.equal(table.body.recordKind, undefined);
    await run(base + `/resources/${id}/tables/demo_table/rows`);
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
    assert.equal(r.body.bytes, Buffer.byteLength(r.body.content));
    assert.ok(r.body.filename.endsWith('.' + (format === 'jsonl' ? 'jsonl' : format)));
    if (format === 'json') {
      assert.deepEqual(JSON.parse(r.body.content), [
        { value: '=SUM(A1)', n: 1 },
        { value: 'quote"\nline', n: null },
        { value: '\ufeff=1', n: 3 },
      ]);
    }
    if (format === 'jsonl') {
      assert.deepEqual(
        r.body.content
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
        [
          { value: '=SUM(A1)', n: 1 },
          { value: 'quote"\nline', n: null },
          { value: '\ufeff=1', n: 3 },
        ],
      );
    }
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
  const preparation = await run(base + '/file-export-preparations', {
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
    preparationId: preparation.body.id,
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
  const importKey = await run(
    base + '/keys',
    {
      method: 'POST',
      body: {
        name: 'local-import-only',
        scopes: ['queries:execute'],
        resourceIds: ['db_live'],
        expiresInDays: 7,
      },
    },
    201,
  );
  const rawPath =
    base +
    '/database-import-preparations?' +
    new URLSearchParams({
      resourceId: 'db_live',
      filename: 'local.csv',
      format: 'csv',
      header: 'true',
      delimiter: ',',
    });
  const importedPreparation = await run(rawPath, {
    method: 'POST',
    token: importKey.body.secret,
    binary: true,
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('id,value\n001,9007199254740993\n'),
  });
  validateResponse(rawPath, 'POST', 200, importedPreparation.body);
  assert.equal(importedPreparation.body.rows[0].id, '001');
  assert.equal(importedPreparation.body.rows[0].value, '9007199254740993');
  const importCommit = {
    resourceId: 'db_live',
    preparationId: importedPreparation.body.id,
    confirmed: true,
    table: 'direct_import',
    fields: importedPreparation.body.fields,
  };
  await run(base + '/database-imports', { method: 'POST', body: importCommit }, 409);
  await run(
    base + '/database-imports',
    {
      method: 'POST',
      token: importKey.body.secret,
      body: { ...importCommit, resourceId: 'db_pg' },
    },
    409,
  );
  await run(
    base + '/file-exports',
    {
      method: 'POST',
      token: importKey.body.secret,
      body: {
        preparationId: importCommit.preparationId,
        confirmed: true,
        fields: importCommit.fields,
        target: { kind: 'database', resourceId: 'db_pg', table: 'bypass_import' },
      },
    },
    409,
  );
  const beforeSourceDenied = provider.calls;
  await run(
    base + '/database-import-preparations',
    {
      method: 'POST',
      token: importKey.body.secret,
      body: {
        resourceId: 'db_live',
        source: { resourceId: 'fs_live', path: '/live.csv' },
        parsing: { format: 'csv', header: true, delimiter: ',' },
      },
    },
    403,
  );
  assert.equal(provider.calls, beforeSourceDenied);
  await run(base + '/database-imports', {
    method: 'POST',
    token: importKey.body.secret,
    body: importCommit,
  });
  await run(
    base + '/database-imports',
    { method: 'POST', token: importKey.body.secret, body: importCommit },
    409,
  );
  await run(
    rawPath,
    {
      method: 'POST',
      token: importKey.body.secret,
      binary: true,
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(1024 * 1024 + 1),
    },
    413,
  );
  const parquetPath =
    base +
    '/database-import-preparations?' +
    new URLSearchParams({ resourceId: 'db_live', filename: 'sample.parquet', format: 'parquet' });
  const parquetReview = await run(parquetPath, {
    method: 'POST',
    token: importKey.body.secret,
    binary: true,
    headers: { 'Content-Type': 'application/octet-stream' },
    body: await parquetImportInput(),
  });
  validateResponse(parquetPath, 'POST', 200, parquetReview.body);
  assert.equal(parquetReview.body.rowCount, 25);
  assert.equal(parquetReview.body.rows.length, 20);
  assert.equal(parquetReview.body.fields[0].type, 'BIGINT');
  await run(base + '/database-imports', {
    method: 'POST',
    token: importKey.body.secret,
    body: {
      resourceId: 'db_live',
      preparationId: parquetReview.body.id,
      confirmed: true,
      table: 'parquet_import',
      fields: parquetReview.body.fields,
    },
  });
  const fileImport = await run(base + '/database-import-preparations', {
    method: 'POST',
    body: {
      resourceId: 'db_pg',
      source: { resourceId: 'fs_shared', path: '/orders.csv' },
      parsing: { format: 'csv', header: true, delimiter: ',' },
    },
  });
  await run(
    base + '/file-exports',
    {
      method: 'POST',
      body: {
        preparationId: fileImport.body.id,
        confirmed: true,
        fields: fileImport.body.fields,
        target: { kind: 'database', resourceId: 'db_live', table: 'file_bypass' },
      },
    },
    409,
  );
  await run(base + '/database-imports', {
    method: 'POST',
    body: {
      resourceId: 'db_pg',
      preparationId: fileImport.body.id,
      confirmed: true,
      table: 'file_import',
      fields: fileImport.body.fields,
    },
  });
  await run(
    base + '/database-imports',
    {
      method: 'POST',
      body: {
        resourceId: 'db_pg',
        preparationId: preparation.body.id,
        confirmed: true,
        table: 'legacy_ticket',
        fields: preparation.body.fields,
      },
    },
    409,
  );
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
  await run(
    base + '/files/entry?' + new URLSearchParams({ resourceId: 'fs_shared', path: '/copied.csv' }),
    { method: 'DELETE' },
  );
  await run(base + '/usage');
}
for (const transport of ['remote', 'inProcess']) {
  test(
    `Rust API satisfies data, analysis, export and credential contracts through ${transport} metadata`,
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
      const state = workspaceFixture();
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
      const global = await f.service('global');
      const region = await f.service('complete');
      await seedRecords(
        region.client,
        region.server.authorityId,
        state,
        Object.fromEntries(
          ['drive9', 'zero', 'duckdb', 'db9'].map((name, i) => [name, raw[i + 1]]),
        ),
      );
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
      try {
        await scenarios(request, provider);
      } catch (error) {
        const output = await readFile(resolve(f.directory, 'backend.log'), 'utf8');
        for (const line of output
          .split('\n')
          .filter((line) =>
            /^Compute worker (exited before a confirmed reply|returned invalid JSON)/.test(line),
          ))
          t.diagnostic(line);
        throw error;
      }
      assert.equal(provider.creates, 0);
      const schema = await fetch(`http://127.0.0.1:${bind}/openapi.json`);
      assert.equal(schema.status, 200);
      assert.deepEqual(await schema.json(), JSON.parse(await readFile('public/openapi.json')));
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
      const verifier =
        transport === 'inProcess' ? await f.service('verify', { previous: region }) : region;
      for (let i = 1; i < raw.length; i++)
        for (const [id, binding] of Object.entries(raw[i].bindings)) {
          assert.deepEqual(
            await readBinding(
              verifier.client,
              region.server.authorityId,
              ['workspace', 'drive9', 'zero', 'duckdb', 'db9'][i],
              id,
            ),
            binding,
          );
        }
      const final = await readState(verifier.client, verifier.server.authorityId);
      assert.deepEqual(final.opaque, state.opaque);
      assert.deepEqual(
        final.resources,
        state.resources.map((resource) => ({
          ...resource,
          ...(resource.id === 'fs_live' ? { uploadLimitBytes: 1048576 } : {}),
          ...(resource.id === 'db_live' ? { expiresAt: raw[2].bindings.db_live.expiresAt } : {}),
        })),
      );
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
    const state = workspaceFixture();
    state.resources = [];
    state.files = [];
    const global = await f.service('global');
    const region = await f.service('lifecycle');
    await seedRecords(region.client, region.server.authorityId, state);
    await global.stop();
    const bind = await port();
    const config = resolve(f.directory, 'rust.json');
    await privateWrite(config, {
      bind: `127.0.0.1:${bind}`,
      workspaceId: 'ws_agentlab',
      authorityId: region.server.authorityId,
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
    const recovered = await request(base + `/resources/${unknownPg.body.data.id}/setup-attempts`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'restore-pg' },
    });
    assert.equal(recovered.status, 201);
    assert.equal(recovered.body.data.status, 'succeeded');
    assert.equal(recovered.body.data.resource.status, 'active');
    assert.notEqual(
      (
        await request(base + `/resources/${unknownZero.body.data.id}/setup-attempts`, {
          method: 'POST',
          headers: { 'Idempotency-Key': 'restore-zero' },
        })
      ).body.data.status,
      'succeeded',
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
