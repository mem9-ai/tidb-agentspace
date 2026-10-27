import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from './index.mjs';
import { consoleOrigins } from './http-policy.mjs';

const workspace = '/api/v1/workspaces/ws_agentlab';
test('separate Console origins support credentialed sessions and retain API authorization', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'tidb-cors-'));
  const origin = 'http://127.0.0.1:41379';
  const app = await createApp({ dataFile: join(directory, 'data.json'), allowedOrigins: [origin] });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const api = `http://127.0.0.1:${app.address().port}`;
  const call = (path, options = {}) =>
    fetch(api + path, { ...options, headers: { Origin: origin, ...options.headers } });
  const preflight = await call('/api/session', {
    method: 'OPTIONS',
    headers: {
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(preflight.headers.get('vary'), 'Origin');
  const unauthenticated = await call(workspace + '/resources');
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get('access-control-allow-origin'), origin);
  const session = await call('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(session.status, 200);
  assert.match(session.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  assert.equal((await call(workspace + '/bootstrap', { headers: { Cookie: cookie } })).status, 200);
  const created = await call(workspace + '/keys', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'split-client',
      scopes: ['resources:read'],
      resourceIds: ['fs_shared'],
      expiresInDays: 7,
    }),
  });
  const key = await created.json();
  assert.equal(created.status, 201);
  const headers = { Authorization: `Bearer ${key.secret}` };
  const resources = await call(workspace + '/resources', { headers });
  assert.deepEqual(
    (await resources.json()).data.map((resource) => resource.id),
    ['fs_shared'],
  );
  assert.equal((await call(workspace + '/files?resourceId=fs_shared', { headers })).status, 403);
  assert.equal((await call('/api/v1/workspaces/ws_other/resources', { headers })).status, 404);
  assert.equal((await call(workspace + '/bootstrap', { headers })).status, 403);
  await call(workspace + '/keys/' + key.data.id, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal((await call(workspace + '/resources', { headers })).status, 401);
  const denied = await call('/api/session', {
    method: 'POST',
    headers: { Origin: 'http://127.0.0.1:41380', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.equal(denied.headers.get('set-cookie'), null);
  for (const headers of [
    { 'Access-Control-Request-Method': 'TRACE' },
    { 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'X-Untrusted' },
    { Origin: 'null', 'Access-Control-Request-Method': 'GET' },
    { Origin: 'https://evil.invalid', 'Access-Control-Request-Method': 'GET' },
  ])
    assert.equal((await call(workspace + '/files', { method: 'OPTIONS', headers })).status, 403);
  const upload = await call(workspace + '/files/content', {
    method: 'OPTIONS',
    headers: {
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers':
        'Authorization, Content-Type, If-None-Match, Idempotency-Key',
    },
  });
  assert.equal(upload.status, 204);
  for (const path of ['/', '/index.html', '/assets/app.js']) {
    const response = await call(path);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
  }
  assert.equal((await call('/openapi.json')).status, 200);
});

test('demo origin configuration accepts exact loopback origins and rejects public hosting', () => {
  assert.deepEqual(consoleOrigins('http://localhost:8888,http://127.0.0.1:8889'), [
    'http://localhost:8888',
    'http://127.0.0.1:8889',
  ]);
  assert.deepEqual(consoleOrigins(''), []);
  for (const value of [
    '*',
    'null',
    'https://example.com',
    'http://127.0.0.1:8888/path',
    'http://user@localhost:8888',
    'http://localhost:8888/',
  ])
    assert.throws(() => consoleOrigins(value));
});
