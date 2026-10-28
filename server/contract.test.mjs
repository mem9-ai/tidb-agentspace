import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { createApp } from './index.mjs';

const contract = JSON.parse(
  await readFile(new URL('../public/openapi.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });

test('standalone API responses conform to every declared JSON operation, including denials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'tidb-contract-'));
  const app = await createApp({
    dataFile: join(directory, 'state.json'),
    filesProvider: 'local',
    mysqlProvider: 'tidb-cloud-zero',
    zeroTransport: async () =>
      Response.json({
        instance: {
          id: 'contract-instance',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          connection: {
            host: 'contract.tidbcloud.com',
            port: 4000,
            username: 'prefix.root',
            password: 'fixture-private',
          },
        },
      }),
    sqlExecute: async () => ({
      columns: ['connected'],
      rows: [{ connected: 1 }],
      rowCount: 1,
      affectedRows: 0,
    }),
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${app.address().port}`;
  const covered = new Set();
  let cookie;
  async function request(
    path,
    method = 'get',
    body,
    { owner = true, suffix = '', status = 200, keyId = '', resourceId = '' } = {},
  ) {
    const operation = contract.paths[path][method];
    assert.ok(operation, `${method} ${path} is documented`);
    const root = contract.paths[path].servers?.[0].url || contract.servers[0].url;
    const route = path
      .replace('{workspaceId}', 'ws_agentlab')
      .replace('{keyId}', keyId)
      .replace('{resourceId}', resourceId);
    const response = await fetch(origin + root.replace(/\/$/, '') + route + suffix, {
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        ...(owner && cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, status, `${operation.operationId} HTTP status`);
    const schema = operation.responses[status]?.content?.['application/json']?.schema;
    assert.ok(schema, `${operation.operationId} documents status ${status}`);
    const validate = ajv.compile({ ...schema, components: contract.components });
    const result = await response.json();
    assert.ok(validate(result), `${operation.operationId}: ${ajv.errorsText(validate.errors)}`);
    if (status < 300) covered.add(operation.operationId);
    return { result, response };
  }
  await request('/api/health');
  const session = await request('/api/session', 'post', {});
  cookie = session.response.headers.get('set-cookie').split(';')[0];
  const workspace = '/workspaces/{workspaceId}';
  await request('/workspaces');
  await request(workspace);
  await request(workspace + '/bootstrap');
  await request(workspace + '/resources');
  await request(workspace + '/resources/{resourceId}/tables', 'get', undefined, {
    resourceId: 'db_memory',
  });
  await request(workspace + '/resources/{resourceId}/table', 'get', undefined, {
    resourceId: 'db_memory',
    suffix: '?name=agent_events',
  });
  await request(workspace + '/resources/{resourceId}/table/rows', 'get', undefined, {
    resourceId: 'db_memory',
    suffix: '?name=agent_events',
  });
  await request(workspace + '/resources/{resourceId}/table', 'get', undefined, {
    resourceId: 'db_memory',
    suffix: '?name=missing',
    status: 404,
  });

  await request(workspace + '/resources', 'get', undefined, { owner: false, status: 401 });
  const database = await request(
    workspace + '/resources',
    'post',
    { name: 'contract-db', kind: 'mysql', region: 'automatic' },
    { status: 201 },
  );
  await request(
    workspace + '/resources',
    'post',
    { name: 'contract-db2', kind: 'mysql', region: 'unavailable' },
    { status: 400 },
  );
  await request(workspace + '/files', 'get', undefined, { suffix: '?resourceId=fs_shared' });
  await request(workspace + '/files', 'put', {
    resourceId: 'fs_shared',
    path: '/contract.txt',
    type: 'file',
    content: 'hello',
  });
  await request(workspace + '/file-analyses/capabilities', 'get', undefined, {
    suffix: '?resourceId=fs_shared&path=/contract.txt',
  });
  await request(workspace + '/file-analyses', 'post', {
    resourceId: 'fs_shared',
    path: '/contract.txt',
    engine: 'bash',
    command: 'cat /workspace/input.log',
  });
  await request(workspace + '/files', 'delete', { resourceId: 'fs_shared', path: '/contract.txt' });
  await request(workspace + '/queries', 'post', { resourceId: 'db_memory', sql: 'SELECT 1' });
  await request(workspace + '/resources/{resourceId}/setup', 'post', undefined, {
    resourceId: database.result.data.id,
  });
  await request(workspace + '/queries', 'post', {
    resourceId: database.result.data.id,
    sql: 'SELECT 1',
  });
  for (const target of [
    { kind: 'download', format: 'csv' },
    { kind: 'download', format: 'json' },
    { kind: 'download', format: 'jsonl' },
    { kind: 'filesystem', resourceId: 'fs_shared', path: '/result.json', format: 'json' },
    { kind: 'database', resourceId: database.result.data.id, table: 'result_export' },
  ])
    await request(workspace + '/result-exports', 'post', {
      sourceResourceId: 'db_memory',
      result: { columns: ['connected'], rows: [{ connected: 1 }] },
      target,
    });
  await request(workspace + '/result-exports', 'post', {}, { status: 400 });
  await request(workspace + '/result-exports', 'post', {}, { owner: false, status: 401 });
  await request(workspace + '/bootstrap');
  await request(workspace + '/usage');
  await request(workspace + '/events');
  await request(workspace + '/keys');
  const created = await request(
    workspace + '/keys',
    'post',
    {
      name: 'contract-key',
      scopes: ['resources:read'],
      resourceIds: ['fs_shared'],
      expiresInDays: 7,
    },
    { status: 201 },
  );
  await request(workspace + '/keys/{keyId}', 'delete', undefined, {
    keyId: created.result.data.id,
  });
  await request(workspace + '/settings', 'patch', {
    workspaceName: 'Contract workspace',
    name: 'Contract owner',
  });
  // Binary transfer success/preview variants are fixture-tested in drive9.test.mjs.
  // Local resources must reject both transfer methods through the documented error contract.
  await request(workspace + '/files/content', 'get', undefined, {
    suffix: '?resourceId=fs_shared&path=/test.bin',
    status: 400,
  });
  await request(
    workspace + '/files/content',
    'put',
    {},
    { suffix: '?resourceId=fs_shared&path=/test.bin', status: 400 },
  );
  const allJsonOperations = Object.values(contract.paths)
    .flatMap((item) =>
      Object.entries(item)
        .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
        .map(([, operation]) => operation.operationId),
    )
    .filter((id) => !['uploadFile', 'downloadFile'].includes(id));
  assert.deepEqual([...covered].sort(), allJsonOperations.sort());
  const validateBootstrap = ajv.compile({
    ...contract.components.schemas.Bootstrap,
    components: contract.components,
  });
  const broken = (await request(workspace + '/bootstrap')).result;
  delete broken.workspace;
  assert.equal(
    validateBootstrap(broken),
    false,
    'contract validation catches missing mandatory fields',
  );
});
