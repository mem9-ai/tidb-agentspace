import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { nativeProductFixture } from './test-support/native-product-fixture.mjs';
import { assertSessionContract } from './test-support/assert-session-contract.mjs';

const contract = JSON.parse(
  await readFile(
    new URL('../tools/api-contract/portal-regional-openapi.json', import.meta.url),
    'utf8',
  ),
);
const ownerContract = JSON.parse(
  await readFile(new URL('../public/owner-openapi.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });

test('resource name contract accepts underscores only for PostgreSQL', () => {
  const schema =
    contract.paths['/workspaces/{workspaceId}/resources'].post.requestBody.content[
      'application/json'
    ].schema;
  const validate = ajv.compile({ ...schema, components: contract.components });
  assert.equal(
    validate({ kind: 'postgresql', name: 'tidb_pg-example', region: 'automatic' }),
    true,
  );
  assert.equal(validate({ kind: 'mysql', name: 'tidb_pg-example', region: 'automatic' }), false);
  assert.equal(validate({ kind: 'postgresql', name: '_tidb-pg', region: 'automatic' }), false);
  assert.equal(validate({ kind: 'mysql', name: 'tidb-pg', region: 'automatic' }), true);
});

test('published regional owner contract exposes only owner-authenticated history operations', () => {
  assert.deepEqual(Object.keys(ownerContract.paths).sort(), [
    '/workspaces/{workspaceId}/audit-history',
    '/workspaces/{workspaceId}/request-history',
  ]);
  assert.equal(ownerContract.components.securitySchemes.workspaceKey, undefined);
  for (const entry of Object.values(ownerContract.paths)) {
    assert.deepEqual(entry.get.security, [
      { localOwner: [] },
      { accountOwner: [] },
      { guestOwner: [] },
    ]);
  }
});

test(
  'native API responses conform to every declared JSON operation, including denials',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 120000 },
  async (t) => {
    const { origin } = await nativeProductFixture(t);
    const publishedOwner = await fetch(origin + '/owner-openapi.json');
    assert.equal(publishedOwner.status, 200);
    assert.deepEqual(await publishedOwner.json(), ownerContract);
    const covered = new Set();
    let cookie;
    async function request(
      path,
      method = 'get',
      body,
      {
        owner = true,
        suffix = '',
        status = method === 'post' &&
        (path.endsWith('-preparations') || path.endsWith('/setup-attempts'))
          ? 201
          : 200,
        keyId = '',
        resourceId = '',
        tableName = '',
        preparationId = '',
        attemptId = '',
        headers = {},
      } = {},
    ) {
      const operation = contract.paths[path][method];
      assert.ok(operation, `${method} ${path} is documented`);
      const root = contract.paths[path].servers?.[0].url || contract.servers[0].url;
      const route = path
        .replace('{workspaceId}', 'ws_agentlab')
        .replace('{keyId}', keyId)
        .replace('{resourceId}', resourceId)
        .replace('{tableName}', encodeURIComponent(tableName))
        .replace('{preparationId}', preparationId)
        .replace('{attemptId}', attemptId);
      const response = await fetch(origin + root.replace(/\/$/, '') + route + suffix, {
        method: method.toUpperCase(),
        headers: {
          'Content-Type': 'application/json',
          ...(owner && cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, status, `${operation.operationId} HTTP status`);
      if (status === 204) {
        assert.equal(await response.text(), '');
        covered.add(operation.operationId);
        return { result: undefined, response };
      }
      const schema = operation.responses[status]?.content?.['application/json']?.schema;
      assert.ok(schema, `${operation.operationId} documents status ${status}`);
      const validate = ajv.compile({ ...schema, components: contract.components });
      const result = await response.json();
      assert.ok(validate(result), `${operation.operationId}: ${ajv.errorsText(validate.errors)}`);
      if (status < 300) covered.add(operation.operationId);
      return { result, response };
    }
    await request('/api/health');
    await request('/api/auth/config');
    // The default host disables Guest; the isolated Guest HTTP probe exercises success.
    await request('/api/auth/guest', 'post', undefined, { status: 404 });
    await request('/api/auth/tidbcloud/logout', 'post');
    await request('/api/auth/tidbcloud/logout');
    const session = await request('/api/session', 'post', {});
    cookie = session.response.headers.get('set-cookie').split(';')[0];
    assertSessionContract(cookie);
    const workspace = '/workspaces/{workspaceId}';
    await request('/workspaces');
    await request(workspace);
    await request(workspace + '/bootstrap');
    await request(workspace + '/sales-sample-attempts', 'get', undefined, {
      suffix: '?fixture=us-sales-v1',
    });
    const salesSample = await request(
      workspace + '/sales-sample-attempts',
      'post',
      { fixture: 'us-sales-v1' },
      { status: 201, headers: { 'Idempotency-Key': randomUUID() } },
    );
    // This shared fixture already uses its File System allowance; a failed attempt is still
    // a successful creation of the durable attempt record and must match the same contract.
    assert.equal(salesSample.result.data.status, 'failed');
    assert.equal(salesSample.result.data.errorCode, 'FREE_TIER_LIMIT');
    await request(workspace + '/sales-sample-attempts/{attemptId}', 'get', undefined, {
      attemptId: salesSample.result.data.id,
    });
    await request(workspace + '/tutorials');
    const tutorial = await request(
      workspace + '/tutorials/{resourceId}',
      'put',
      { sampleId: 'a'.repeat(32), state: 'attempted' },
      { resourceId: 'db_memory', status: 201, headers: { 'If-None-Match': '*' } },
    );
    assert.equal(tutorial.response.headers.get('etag'), tutorial.result.data.version);
    await request(workspace + '/tutorials/{resourceId}', 'get', undefined, {
      resourceId: 'db_memory',
    });
    await request(
      workspace + '/tutorials/{resourceId}',
      'put',
      { sampleId: 'a'.repeat(32), state: 'completed' },
      { resourceId: 'db_memory', headers: { 'If-Match': tutorial.result.data.version } },
    );
    await request(
      workspace + '/tutorials/{resourceId}',
      'put',
      { sampleId: 'a'.repeat(32), state: 'ready' },
      { resourceId: 'db_memory', status: 428 },
    );
    await request(workspace + '/resources');
    await request(workspace + '/context');
    await request(workspace + '/resources/{resourceId}', 'get', undefined, {
      resourceId: 'db_memory',
    });
    await request(workspace + '/resources/{resourceId}/tables', 'get', undefined, {
      resourceId: 'db_memory',
    });
    await request(workspace + '/resources/{resourceId}/tables/{tableName}', 'get', undefined, {
      resourceId: 'db_memory',
      tableName: 'agent_events',
    });
    await request(workspace + '/resources/{resourceId}/tables/{tableName}/rows', 'get', undefined, {
      resourceId: 'db_memory',
      tableName: 'agent_events',
    });
    await request(workspace + '/resources/{resourceId}/tables/{tableName}', 'get', undefined, {
      resourceId: 'db_memory',
      tableName: 'missing',
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
    await request(workspace + '/files/metadata', 'get', undefined, {
      suffix: '?resourceId=fs_shared&path=/contract.txt',
    });
    await request(workspace + '/files', 'put', {
      resourceId: 'fs_shared',
      path: '/preview.csv',
      type: 'file',
      content: 'id,region\n1,APAC\n',
    });
    await request(workspace + '/files/tabular-preview', 'get', undefined, {
      suffix: '?resourceId=fs_shared&path=/preview.csv',
    });
    await request(workspace + '/file-exports', 'post', {
      source: { kind: 'output', resourceId: 'fs_shared', stream: 'stdout', text: 'hello\n' },
      target: { kind: 'download' },
    });
    await request(workspace + '/file-exports', 'post', {
      source: { kind: 'original', resourceId: 'fs_shared', path: '/preview.csv' },
      target: { kind: 'filesystem', resourceId: 'fs_shared', path: '/copied.csv' },
    });
    const fileReview = await request(workspace + '/file-export-preparations', 'post', {
      source: { kind: 'output', resourceId: 'fs_shared', stream: 'stdout', text: 'id\n001\n' },
      parsing: { format: 'csv', header: true, delimiter: ',' },
    });
    await request(workspace + '/file-export-preparations/{preparationId}', 'get', undefined, {
      preparationId: fileReview.result.id,
    });
    await request(workspace + '/file-export-preparations/{preparationId}', 'delete', undefined, {
      preparationId: fileReview.result.id,
      status: 204,
    });
    const textCapabilities = await request(
      workspace + '/file-analyses/capabilities',
      'get',
      undefined,
      {
        suffix: '?resourceId=fs_shared&path=/contract.txt',
      },
    );
    assert.deepEqual(textCapabilities.result.engines[0].input, {
      path: '/contract.txt',
      workingDirectory: '/workspace',
      aliases: ['/workspace/input.log'],
      fileVariable: 'FILE',
    });
    await request(workspace + '/file-analyses', 'post', {
      resourceId: 'fs_shared',
      path: '/contract.txt',
      engine: 'bash',
      command: 'cat "$FILE"',
    });
    await request(workspace + '/files', 'put', {
      resourceId: 'fs_shared',
      path: '/contract.csv',
      type: 'file',
      content: 'n\n1\n2\n',
    });
    const csvCapabilities = await request(
      workspace + '/file-analyses/capabilities',
      'get',
      undefined,
      {
        suffix: '?resourceId=fs_shared&path=/contract.csv',
      },
    );
    assert.deepEqual(
      csvCapabilities.result.engines.map((e) => e.engine),
      ['duckdb', 'bash'],
    );
    for (const query of [
      { engine: 'duckdb', sql: 'SELECT * FROM file' },
      { engine: 'bash', command: 'cat /contract.csv' },
    ])
      await request(workspace + '/file-analyses', 'post', {
        resourceId: 'fs_shared',
        path: '/contract.csv',
        ...query,
      });
    await request(workspace + '/files/entry', 'delete', undefined, {
      suffix: '?resourceId=fs_shared&path=/contract.txt',
    });
    await request(workspace + '/queries', 'post', { resourceId: 'db_memory', sql: 'SELECT 1' });
    const setup = await request(
      workspace + '/resources/{resourceId}/setup-attempts',
      'post',
      undefined,
      {
        resourceId: database.result.data.id,
        headers: { 'Idempotency-Key': 'contract-setup' },
      },
    );
    await request(workspace + '/resources/{resourceId}/setup-attempts', 'get', undefined, {
      resourceId: database.result.data.id,
    });
    await request(
      workspace + '/resources/{resourceId}/setup-attempts/{attemptId}',
      'get',
      undefined,
      { resourceId: database.result.data.id, attemptId: setup.result.data.id },
    );
    await request(workspace + '/queries', 'post', {
      resourceId: database.result.data.id,
      sql: 'SELECT 1',
    });
    const imported = await request(workspace + '/database-import-preparations', 'post', {
      resourceId: database.result.data.id,
      source: { resourceId: 'fs_shared', path: '/preview.csv' },
      parsing: { format: 'csv', header: true, delimiter: ',' },
    });
    await request(workspace + '/database-import-preparations/{preparationId}', 'get', undefined, {
      preparationId: imported.result.id,
    });
    await request(workspace + '/database-imports', 'post', {
      resourceId: database.result.data.id,
      preparationId: imported.result.id,
      confirmed: true,
      table: 'database_import',
      fields: imported.result.fields,
    });
    const cancelled = await request(workspace + '/database-import-preparations', 'post', {
      resourceId: database.result.data.id,
      source: { resourceId: 'fs_shared', path: '/preview.csv' },
      parsing: { format: 'csv', header: true, delimiter: ',' },
    });
    await request(
      workspace + '/database-import-preparations/{preparationId}',
      'delete',
      undefined,
      { preparationId: cancelled.result.id, status: 204 },
    );
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
    await request(workspace + '/request-history');
    await request(workspace + '/audit-history');
    await request(workspace + '/settings', 'patch', {
      workspaceName: 'Contract workspace',
      name: 'Contract owner',
    });
    // Binary transfer success/preview variants are fixture-tested in rust-product.test.mjs.
    // Local downloads reject unsupported resources; JSON uploads fail the media check first.
    await request(workspace + '/files/content', 'get', undefined, {
      suffix: '?resourceId=fs_shared&path=/test.bin',
      status: 400,
    });
    await request(
      workspace + '/files/content',
      'put',
      {},
      { suffix: '?resourceId=fs_shared&path=/test.bin', status: 415 },
    );
    await request(workspace + '/resources/{resourceId}', 'delete', undefined, {
      resourceId: 'db_memory',
    });
    const allJsonOperations = Object.values(contract.paths)
      .flatMap((item) =>
        Object.entries(item)
          .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
          .map(([, operation]) => operation.operationId),
      )
      .filter(
        (id) =>
          ![
            // Success/schema coverage is exercised by the actual security-profile listener
            // in region-security-cases.mjs, including native data calls and Global API loss.
            'enrollRegionalRefreshFamily',
            'issueRegionalToken',
            'getRegionalRefreshFamily',
            'revokeRegionalRefreshFamily',
            'getRegionalTokenIssuance',
            'revokeRegionalAccessToken',
            'exchangePortalRegionSession', // Covered by the isolated distributed SSO fixture.
            'uploadFile',
            'downloadFile',
            'startGuestSession', // Success is covered by guest_http_probe.
            'logoutGuestSession', // Success is covered by guest-host.test.mjs.
            'startTidbLogin',
            'completeTidbLogin',
          ].includes(id),
      );
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
  },
);
