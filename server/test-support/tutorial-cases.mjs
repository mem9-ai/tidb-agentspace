import assert from 'node:assert/strict';
import { productApiFixture } from './product-api-fixture.mjs';
import { revokeAndConfirmRegion } from './revoke-confirm.mjs';

export async function tutorialCases(t, transport) {
  const f = await productApiFixture(t, transport);
  const request = async (path, options = {}, status = 200, code, workspace = 0) => {
    const result = await f.request(path, options, workspace);
    assert.equal(result.status, status, `${path}: ${JSON.stringify(result.body)}`);
    if (code) assert.equal(result.body.error.code, code);
    return result;
  };
  const input = { sampleId: 'a'.repeat(32), state: 'attempted' };
  const create = { method: 'PUT', headers: { 'If-None-Match': '*' }, body: input };
  const before = {
    calls: f.provider.calls,
    statements: f.provider.statements.length,
    creates: f.provider.creates,
  };
  assert.deepEqual((await request('/tutorials')).body, { data: [], nextCursor: null });
  await request('/tutorials/db_memory', {}, 404);
  await request('/tutorials', { token: null }, 401);
  await request('/tutorials/db_memory', { ...create, token: null }, 401);
  await request('/tutorials/db_memory', { ...create, headers: {} }, 428, 'PRECONDITION_REQUIRED');
  for (const headers of [
    { 'If-Match': '*' },
    { 'If-Match': 'W/"tutorial-' + 'a'.repeat(32) + '"' },
    { 'If-None-Match': 'other' },
    { 'If-None-Match': '*', 'If-Match': '"tutorial-' + 'a'.repeat(32) + '"' },
  ])
    await request('/tutorials/db_memory', { ...create, headers }, 400, 'INVALID_PRECONDITION');
  for (const body of [
    { ...input, sampleId: '../other' },
    { ...input, state: 'unknown' },
    { ...input, workspaceId: 'ws_other' },
    { sampleId: input.sampleId },
  ])
    await request('/tutorials/db_memory', { ...create, body }, 400, 'INVALID_TUTORIAL');
  await request('/tutorials/db_memory', { ...create, body: null }, 400, 'INVALID_BODY');
  await request('/tutorials/hidden-storage', create, 404);
  await request('/tutorials?limit=0', {}, 400);
  await request('/tutorials?limit=101', {}, 400);
  await request('/tutorials?cursor=../other', {}, 400);
  await request('/tutorials?unknown=true', {}, 400);

  const first = await request('/tutorials/db_memory', create, 201);
  assert.equal(first.headers.get('etag'), first.body.data.version);
  assert.match(first.body.data.version, /^"tutorial-[a-f0-9]{32}"$/);
  assert.equal(
    new URL(first.headers.get('location'), first.url).pathname,
    '/api/portal/v1/workspaces/ws_agentlab/tutorials/db_memory',
  );
  assert.equal(first.body.data.resourceId, 'db_memory');
  assert.equal(first.body.data.sampleId, input.sampleId);
  assert.equal(first.body.data.state, 'attempted');
  assert.ok(Number.isFinite(Date.parse(first.body.data.updatedAt)));
  await request('/tutorials/db_memory', create, 412, 'PRECONDITION_FAILED');
  const ready = await request('/tutorials/db_memory', {
    method: 'PUT',
    headers: { 'If-Match': first.body.data.version },
    body: { ...input, state: 'ready' },
  });
  assert.notEqual(ready.body.data.version, first.body.data.version);
  await request(
    '/tutorials/db_memory',
    { ...create, headers: { 'If-Match': first.body.data.version } },
    412,
  );
  const competing = await Promise.all(
    ['completed', 'pending'].map((state) =>
      f.request('/tutorials/db_memory', {
        method: 'PUT',
        headers: { 'If-Match': ready.body.data.version },
        body: { ...input, state },
      }),
    ),
  );
  assert.deepEqual(competing.map((r) => r.status).sort(), [200, 412]);
  const winner = competing.find((r) => r.status === 200).body.data;
  assert.deepEqual((await request('/tutorials/db_memory')).body.data, winner);

  await request(
    '/tutorials/fs_shared',
    { ...create, body: { sampleId: 'b'.repeat(32), state: 'completed' } },
    201,
  );
  const page = (await request('/tutorials?limit=1')).body;
  assert.equal(page.data.length, 1);
  assert.equal(page.data[0].resourceId, 'db_memory');
  assert.equal(page.nextCursor, 'db_memory');
  const last = (
    await request('/tutorials?' + new URLSearchParams({ limit: '1', cursor: page.nextCursor }))
  ).body;
  assert.deepEqual(
    last.data.map((record) => record.resourceId),
    ['fs_shared'],
  );
  assert.equal(last.nextCursor, null);
  await request('/tutorials/db_memory', {}, 404, undefined, 1);
  await request('/api/portal/v1/workspaces/ws_other/tutorials', {}, 404);
  await request(
    '/tutorials/db_memory',
    { ...create, body: { sampleId: 'c'.repeat(32), state: 'ready' } },
    201,
    undefined,
    1,
  );
  assert.equal(
    (await request('/tutorials', {}, 200, undefined, 1)).body.data[0].sampleId,
    'c'.repeat(32),
  );

  const issued = await f.issueKey({
    name: 'tutorial-denial',
    scopes: ['resources:read', 'queries:execute'],
    resourceIds: ['*'],
    expiresInDays: 7,
  });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const key = issued.body;
  for (const path of ['/tutorials', '/tutorials/db_memory'])
    await request(path, { token: key.secret }, 403, 'OWNER_REQUIRED');
  await request('/tutorials/db_memory', { ...create, token: key.secret }, 403, 'OWNER_REQUIRED');
  await revokeAndConfirmRegion(f, key.data);
  for (const token of [key.secret, 'expired-coverage-key', 'revoked-coverage-key', 'invalid']) {
    await request('/tutorials', { token }, 401);
    await request('/tutorials/db_memory', { ...create, token }, 401);
  }
  const retained = (await request('/tutorials')).body;
  const stored = await f.records(['tutorials/progress/db_memory']);
  assert.deepEqual(stored['tutorials/progress/db_memory'].value, winner);
  await f.restart({ crash: true });
  assert.deepEqual((await request('/tutorials')).body, retained);
  assert.deepEqual((await request('/tutorials/db_memory')).body.data, winner);
  assert.equal(
    (await request('/tutorials', {}, 200, undefined, 1)).body.data[0].sampleId,
    'c'.repeat(32),
  );
  assert.deepEqual(
    {
      calls: f.provider.calls,
      statements: f.provider.statements.length,
      creates: f.provider.creates,
    },
    before,
    'progress reads, writes, denials and restart perform no provider/sample I/O',
  );
}
