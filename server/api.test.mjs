import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './index.mjs';
import { capabilities, createStore, seed } from './store.mjs';
import { createHash } from 'node:crypto';

let server, address, cookie, directory, dataFile;
const base = '/api/v1/workspaces/ws_agentlab';
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tidb-workspace-test-'));
  dataFile = join(directory, 'state.json');
  server = await createApp({ dataFile, mysqlProvider: 'local', filesProvider: 'local' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  address = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(address + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  cookie = response.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
});
async function request(path, method = 'GET', data, credential = cookie, extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (credential?.startsWith('aw_session=')) headers.Cookie = credential;
  else if (credential) headers.Authorization = 'Bearer ' + credential;
  const response = await fetch(address + path, {
    method,
    headers,
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
let readKey, writeKey;
test('owner discovers supported resources and receives no stored digests', async () => {
  const result = await request(base + '/bootstrap');
  assert.equal(result.status, 200);
  assert.equal(result.body.resources.length, 2);
  assert.equal(result.body.mode, 'demo');
  assert.equal(result.body.resources.filter((r) => r.kind === 'postgresql').length, 0);
});
test('unauthenticated requests and wrong workspaces cannot read data', async () => {
  assert.equal((await request(base + '/resources', 'GET', undefined, null)).status, 401);
  assert.equal((await request('/api/v1/workspaces/ws_other/resources')).status, 404);
});
test('cross-origin session creation is rejected', async () => {
  const result = await request('/api/session', 'POST', {}, null, {
    Origin: 'https://evil.invalid',
  });
  assert.equal(result.status, 403);
});
test('keys are scoped, reveal once, and persist only a digest', async () => {
  const result = await request(base + '/keys', 'POST', {
    name: 'read-agent',
    scopes: ['resources:read'],
    expiresInDays: 7,
    resourceIds: ['*'],
  });
  assert.equal(result.status, 201);
  readKey = result.body.secret;
  assert.ok(readKey.startsWith('aw_demo_'));
  assert.ok(!('digest' in result.body.data));
  const list = await request(base + '/keys');
  assert.ok(!JSON.stringify(list.body).includes(readKey));
  assert.ok(!(await readFile(dataFile, 'utf8')).includes(readKey));
  assert.equal((await request(base + '/resources', 'GET', undefined, readKey)).status, 200);
  assert.equal((await request(base + '/files', 'GET', undefined, readKey)).status, 403);
  assert.equal(
    (
      await request(
        base + '/keys',
        'POST',
        { name: 'escalate', scopes: ['files:write'], expiresInDays: 7 },
        readKey,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        base + '/resources',
        'POST',
        { name: 'blocked-db', kind: 'mysql', region: 'aws-us-east-1' },
        readKey,
      )
    ).status,
    403,
  );
});
test('reject unsupported scopes and expiration values', async () => {
  assert.equal(
    (await request(base + '/keys', 'POST', { name: 'bad-scope', scopes: ['*'], expiresInDays: 30 }))
      .status,
    400,
  );
  assert.equal(
    (
      await request(base + '/keys', 'POST', {
        name: 'bad-expiry',
        scopes: ['files:read'],
        expiresInDays: 0,
        resourceIds: ['*'],
      })
    ).status,
    400,
  );
});
test('file API round-trips data and rejects traversal, missing parents, and type collisions', async () => {
  const key = await request(base + '/keys', 'POST', {
    name: 'file-agent',
    scopes: ['files:read', 'files:write'],
    expiresInDays: 30,
    resourceIds: ['*'],
  });
  writeKey = key.body.secret;
  let result = await request(
    base + '/files',
    'PUT',
    { resourceId: 'fs_shared', path: '/test.txt', type: 'file', content: 'persistent context' },
    writeKey,
  );
  assert.equal(result.status, 200);
  result = await request(base + '/files?resourceId=fs_shared', 'GET', undefined, writeKey);
  assert.equal(result.body.data.find((f) => f.path === '/test.txt').content, 'persistent context');
  assert.equal(
    (
      await request(
        base + '/files',
        'PUT',
        { resourceId: 'fs_shared', path: '/../secret', type: 'file', content: 'x' },
        writeKey,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        base + '/files',
        'PUT',
        { resourceId: 'fs_shared', path: '/missing/test', type: 'file', content: 'x' },
        writeKey,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        base + '/files',
        'PUT',
        { resourceId: 'fs_shared', path: '/docs', type: 'file', content: 'x' },
        writeKey,
      )
    ).status,
    409,
  );
  assert.equal(
    (await request(base + '/files', 'DELETE', { resourceId: 'fs_shared', path: '/docs' }, writeKey))
      .status,
    409,
  );
});
test('file size and resource type are validated', async () => {
  assert.equal(
    (
      await request(
        base + '/files',
        'PUT',
        { resourceId: 'db_memory', path: '/test.txt', type: 'file', content: 'x' },
        writeKey,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        base + '/files',
        'PUT',
        { resourceId: 'fs_shared', path: '/large.txt', type: 'file', content: 'x'.repeat(262145) },
        writeKey,
      )
    ).status,
    413,
  );
});
test('concurrent writes are retained by the serialized atomic store', async () => {
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      request(
        base + '/files',
        'PUT',
        { resourceId: 'fs_shared', path: `/parallel-${i}.txt`, type: 'file', content: `${i}` },
        writeKey,
      ),
    ),
  );
  assert.ok(results.every((r) => r.status === 200));
  const state = JSON.parse(await readFile(dataFile, 'utf8'));
  assert.equal(state.files.filter((f) => f.path.startsWith('/parallel-')).length, 5);
});
test('resource creation supports idempotency and respects protocol capabilities', async () => {
  const input = { name: 'retry-safe-db', kind: 'mysql', region: 'aws-us-east-1' };
  const first = await request(base + '/resources', 'POST', input, cookie, {
      'Idempotency-Key': 'retry-test',
    }),
    second = await request(base + '/resources', 'POST', input, cookie, {
      'Idempotency-Key': 'retry-test',
    });
  assert.equal(first.status, 201);
  assert.equal(first.body.data.id, second.body.data.id);
  assert.equal(
    (
      await request(base + '/resources', 'POST', { ...input, name: 'different-db' }, cookie, {
        'Idempotency-Key': 'retry-test',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(base + '/resources', 'POST', {
        name: 'bad-pg-region',
        kind: 'postgresql',
        region: 'aws-us-west-2',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(base + '/resources', 'POST', {
        name: 'second-files',
        kind: 'filesystem',
        region: 'aws-ap-southeast-1',
      })
    ).status,
    409,
  );
});
test('File System defaults to Singapore, keeps Oregon, and enforces resource-specific regional limits', async () => {
  const discovery = await request(base + '/resources');
  assert.deepEqual(discovery.body.capabilities.filesystem.regions, [
    'aws-ap-southeast-1',
    'aws-us-west-2',
  ]);
  assert.equal(discovery.body.data.find((r) => r.id === 'fs_shared').region, 'aws-ap-southeast-1');
  const existingNames = new Set(discovery.body.data.map((r) => r.name));
  assert(!existingNames.has('oregon-files'));
  const input = { name: 'oregon-files', kind: 'filesystem', region: 'aws-us-west-2' };
  const oregon = await request(base + '/resources', 'POST', input);
  assert.equal(oregon.status, 201);
  assert.equal(oregon.body.data.region, 'aws-us-west-2');
  const duplicate = await request(base + '/resources', 'POST', {
    ...input,
    name: 'oregon-files-again',
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'FREE_TIER_LIMIT');
  for (const kind of ['mysql']) {
    const unsupported = await request(base + '/resources', 'POST', {
      name: `singapore-${kind}`,
      kind,
      region: 'aws-ap-southeast-1',
    });
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.body.error.code, 'UNSUPPORTED_REGION');
  }
  const unsupported = await request(base + '/resources', 'POST', {
    name: 'unknown-files',
    kind: 'filesystem',
    region: 'unknown-region',
  });
  assert.equal(unsupported.status, 400);
  const contract = (await request('/openapi.json')).body;
  const documentedRegions =
    contract.paths['/workspaces/{workspaceId}/resources'].post.requestBody.content[
      'application/json'
    ].schema.properties.region.enum;
  assert.deepEqual(
    new Set(documentedRegions),
    new Set([...Object.values(capabilities).flatMap((c) => c.regions), 'automatic']),
  );
});

test('new default never relocates persisted File Systems or rewrites their files', async () => {
  const legacy = seed();
  legacy.resources.find((r) => r.id === 'fs_shared').region = 'aws-us-west-2';
  const file = join(directory, 'legacy-region.json');
  await writeFile(file, JSON.stringify(legacy));
  const reopened = await createStore(file);
  assert.deepEqual(reopened.read(), legacy);
  await reopened.mutate((draft) => {
    draft.workspace.description = 'Keep original resource location';
  });
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(persisted.resources, legacy.resources);
  assert.deepEqual(persisted.files, legacy.files);
  const legacyServer = await createApp({ dataFile: file });
  await new Promise((resolve) => legacyServer.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${legacyServer.address().port}`;
    const session = await fetch(origin + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const response = await fetch(origin + base + '/resources', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: session.headers.get('set-cookie').split(';')[0],
      },
      body: JSON.stringify({
        name: 'singapore-files',
        kind: 'filesystem',
        region: 'aws-ap-southeast-1',
      }),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).data.region, 'aws-ap-southeast-1');
    const updated = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(updated.files, legacy.files);
    assert.equal(updated.resources.find((r) => r.id === 'fs_shared').region, 'aws-us-west-2');
  } finally {
    await new Promise((resolve) => legacyServer.close(resolve));
  }
});
test('queries execute supported patterns and reject invented cloud behavior', async () => {
  let result = await request(base + '/queries', 'POST', {
    resourceId: 'db_memory',
    sql: 'SELECT * FROM agent_events LIMIT 2;',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.rows.length, 2);
  assert.equal(result.body.mode, 'demo');
  assert.equal(
    (
      await request(base + '/queries', 'POST', {
        resourceId: 'db_memory',
        sql: 'SELECT 1 AS connected;',
      })
    ).body.rows[0].connected,
    1,
  );
  assert.equal(
    (
      await request(base + '/queries', 'POST', {
        resourceId: 'db_memory',
        sql: 'DROP TABLE agent_events;',
      })
    ).status,
    422,
  );
  assert.equal(
    (await request(base + '/queries', 'POST', { resourceId: 'fs_shared', sql: 'SELECT 1;' }))
      .status,
    404,
  );
  assert.equal(
    (
      await request(
        base + '/queries',
        'POST',
        { resourceId: 'db_memory', sql: 'SELECT 1;' },
        readKey,
      )
    ).status,
    403,
  );
});
test('usage is derived from file contents and keys cannot read owner bootstrap', async () => {
  const result = await request(base + '/usage');
  assert.ok(result.body.data.find((u) => u.kind === 'filesystem').storageBytes > 0);
  assert.equal((await request(base + '/bootstrap', 'GET', undefined, readKey)).status, 403);
});
test('revocation removes bearer access immediately', async () => {
  const keys = (await request(base + '/keys')).body.data;
  const key = keys.find((k) => k.name === 'read-agent');
  assert.equal((await request(base + '/keys/' + key.id, 'DELETE')).status, 200);
  assert.equal((await request(base + '/resources', 'GET', undefined, readKey)).status, 401);
});
test('OpenAPI paths correspond to the resource and key endpoints', async () => {
  const result = await request('/openapi.json', 'GET', undefined, null);
  assert.equal(result.status, 200);
  assert.equal(result.body.openapi, '3.1.0');
  assert.ok(result.body.paths['/workspaces/{workspaceId}/resources'].post);
  assert.ok(result.body.paths['/workspaces/{workspaceId}/keys/{keyId}'].delete);
});
test('workspace settings and file contents survive reopening the store', async () => {
  assert.equal(
    (
      await request(base + '/settings', 'PATCH', {
        name: 'Test owner',
        workspaceName: 'Test workspace',
        description: 'Saved context',
      })
    ).status,
    200,
  );
  const reopened = await createApp({ dataFile });
  await new Promise((resolve) => reopened.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${reopened.address().port}`;
    const response = await fetch(origin + base + '/files?resourceId=fs_shared', {
      headers: { Authorization: 'Bearer ' + writeKey },
    });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).data.some((f) => f.path === '/test.txt'));
  } finally {
    await new Promise((resolve) => reopened.close(resolve));
  }
  const state = JSON.parse(await readFile(dataFile, 'utf8'));
  assert.equal(state.workspace.name, 'Test workspace');
  assert.equal(state.profile.name, 'Test owner');
});

test('expired bearer keys are rejected by a newly opened server', async () => {
  const expiredFile = join(directory, 'expired.json');
  const state = JSON.parse(await readFile(dataFile, 'utf8'));
  const token = 'aw_demo_expired_fixture';
  state.keys.push({
    id: 'expired-fixture',
    name: 'expired-agent',
    digest: createHash('sha256').update(token).digest('hex'),
    scopes: ['resources:read'],
    resourceIds: ['*'],
    expiresAt: new Date(Date.now() - 60000).toISOString(),
    revokedAt: null,
  });
  await writeFile(expiredFile, JSON.stringify(state));
  const app = await createApp({ dataFile: expiredFile });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}${base}/resources`, {
      headers: { Authorization: 'Bearer ' + token },
    });
    assert.equal(response.status, 401);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
test('non-object JSON request bodies return a validation error', async () => {
  const response = await fetch(address + base + '/resources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: 'null',
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_BODY');
});

test('one key can query one MySQL resource and read/write files while another database remains inaccessible', async () => {
  const secondDatabase = await request(base + '/resources', 'POST', {
    name: 'key-scoped-mysql',
    kind: 'mysql',
    region: 'aws-us-east-1',
  });
  const secondId = secondDatabase.body.data.id;
  const created = await request(base + '/keys', 'POST', {
    name: 'mysql-and-files-agent',
    scopes: [
      'resources:read',
      'resources:write',
      'queries:execute',
      'files:read',
      'files:write',
      'usage:read',
    ],
    resourceIds: [secondId, 'fs_shared'],
    expiresInDays: 7,
  });
  assert.equal(created.status, 201);
  const key = created.body.secret;
  const discovered = await request(base + '/resources', 'GET', undefined, key);
  assert.deepEqual(discovered.body.data.map((r) => r.id).sort(), [secondId, 'fs_shared']);
  assert.equal(
    (await request(base + '/queries', 'POST', { resourceId: secondId, sql: 'SELECT 1;' }, key))
      .status,
    200,
  );
  assert.equal(
    (await request(base + '/files?resourceId=fs_shared', 'GET', undefined, key)).status,
    200,
  );
  assert.equal(
    (
      await request(
        base + '/files',
        'PUT',
        {
          resourceId: 'fs_shared',
          path: '/unified-key.txt',
          type: 'file',
          content: 'One key, two components.',
        },
        key,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request(base + '/queries', 'POST', { resourceId: 'db_memory', sql: 'SELECT 1;' }, key))
      .body.error.code,
    'RESOURCE_ACCESS_DENIED',
  );
  const usage = await request(base + '/usage', 'GET', undefined, key);
  assert.deepEqual(usage.body.data.map((u) => u.resourceId).sort(), [secondId, 'fs_shared']);
  const events = await request(base + '/events', 'GET', undefined, key);
  assert.ok(events.body.data.length > 0);
  assert.ok(events.body.data.every((e) => [secondId, 'fs_shared'].includes(e.resourceId)));
  assert.equal(
    (
      await request(
        base + '/resources',
        'POST',
        { name: 'forbidden-new-db', kind: 'mysql', region: 'aws-us-east-1' },
        key,
      )
    ).body.error.code,
    'WORKSPACE_GRANT_REQUIRED',
  );
  const keyId = created.body.data.id;
  await request(base + '/keys/' + keyId, 'DELETE');
  assert.equal(
    (await request(base + '/files?resourceId=fs_shared', 'GET', undefined, key)).status,
    401,
  );
  assert.equal(
    (await request(base + '/queries', 'POST', { resourceId: secondId, sql: 'SELECT 1;' }, key))
      .status,
    401,
  );
});

test('resource restriction and action restriction are both enforced for file operations', async () => {
  const mysqlOnly = await request(base + '/keys', 'POST', {
    name: 'mysql-only',
    scopes: ['files:read', 'files:write'],
    resourceIds: ['db_memory'],
    expiresInDays: 7,
  });
  assert.equal(
    (await request(base + '/files?resourceId=fs_shared', 'GET', undefined, mysqlOnly.body.secret))
      .status,
    403,
  );
  assert.equal(
    (
      await request(
        base + '/files',
        'PUT',
        { resourceId: 'fs_shared', path: '/blocked.txt', type: 'file', content: 'blocked' },
        mysqlOnly.body.secret,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        base + '/files',
        'DELETE',
        { resourceId: 'fs_shared', path: '/test.txt' },
        mysqlOnly.body.secret,
      )
    ).status,
    403,
  );
  const readOnly = await request(base + '/keys', 'POST', {
    name: 'files-read-only',
    scopes: ['files:read'],
    resourceIds: ['fs_shared'],
    expiresInDays: 7,
  });
  assert.equal(
    (await request(base + '/files?resourceId=fs_shared', 'GET', undefined, readOnly.body.secret))
      .status,
    200,
  );
  assert.equal(
    (
      await request(
        base + '/files',
        'PUT',
        { resourceId: 'fs_shared', path: '/blocked.txt', type: 'file', content: 'blocked' },
        readOnly.body.secret,
      )
    ).body.error.code,
    'INSUFFICIENT_SCOPE',
  );
});

test('new keys require an explicit valid resource grant and selection does not widen on creation', async () => {
  for (const resourceIds of [undefined, [], ['does-not-exist'], ['*', 'fs_shared']]) {
    const result = await request(base + '/keys', 'POST', {
      name: 'invalid-grant',
      scopes: ['resources:read'],
      resourceIds,
      expiresInDays: 7,
    });
    assert.equal(result.status, 400);
  }
  const limited = await request(base + '/keys', 'POST', {
    name: 'selected-only',
    scopes: ['resources:read'],
    resourceIds: ['db_memory'],
    expiresInDays: 7,
  });
  const wide = await request(base + '/keys', 'POST', {
    name: 'workspace-wide',
    scopes: ['resources:read', 'resources:write'],
    resourceIds: ['*'],
    expiresInDays: 7,
  });
  const added = await request(
    base + '/resources',
    'POST',
    { name: 'future-resource', kind: 'mysql', region: 'aws-us-east-1' },
    wide.body.secret,
  );
  assert.equal(added.status, 201);
  assert.equal(
    (await request(base + '/resources', 'GET', undefined, limited.body.secret)).body.data.length,
    1,
  );
  assert.ok(
    (await request(base + '/resources', 'GET', undefined, wide.body.secret)).body.data.some(
      (r) => r.id === added.body.data.id,
    ),
  );
});
