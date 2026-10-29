import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { get, request } from 'node:http';
import test from 'node:test';
import { createApp, startServer } from './index.mjs';
import { consoleOrigins, trustedProxies } from './http-policy.mjs';

const workspace = '/api/v1/workspaces/ws_agentlab';

function statusWithHost(url, host) {
  return new Promise((resolve, reject) => {
    get(url, { headers: { Host: host } }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    }).once('error', reject);
  });
}

function demoSession(url) {
  return new Promise((resolve, reject) => {
    const req = request(
      url + '/api/session',
      {
        method: 'POST',
        headers: {
          Host: '127.0.0.1',
          Origin: 'http://127.0.0.1',
          'X-Forwarded-For': '127.0.0.1',
          'X-Real-IP': '127.0.0.1',
          Forwarded: 'for=127.0.0.1;host=localhost;proto=http',
          'Content-Type': 'application/json',
        },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response));
      },
    );
    req.once('error', reject);
    req.end('{}');
  });
}

test('API listener stays local by default and explicitly supports the Pod network', async (t) => {
  const previous = process.env.WORKSPACE_API_HOST;
  t.after(() => {
    if (previous === undefined) delete process.env.WORKSPACE_API_HOST;
    else process.env.WORKSPACE_API_HOST = previous;
  });
  const directory = await mkdtemp(join(tmpdir(), 'tidb-listener-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const host of [undefined, '127.0.0.1', '0.0.0.0']) {
    if (host === undefined) delete process.env.WORKSPACE_API_HOST;
    else process.env.WORKSPACE_API_HOST = host;
    const app = await startServer({ port: 0, dataFile: join(directory, 'data.json') });
    try {
      assert.equal(app.address().address, host ?? '127.0.0.1');
      const address =
        host === '0.0.0.0'
          ? Object.values(networkInterfaces())
              .flat()
              .find((entry) => entry.family === 'IPv4' && !entry.internal)?.address
          : '127.0.0.1';
      assert.ok(address, 'The non-loopback listener must be tested through a network interface.');
      const base = `http://${address}:${app.address().port}`;
      // Use node:http to actually send the Host header; fetch may replace it.
      assert.equal(await statusWithHost(base + '/api/health', '127.0.0.1'), 200);
      assert.equal(await statusWithHost(base + workspace + '/resources', '127.0.0.1'), 401);
      assert.equal(await statusWithHost(base + '/api/health', 'untrusted.invalid'), 403);
      const session = await demoSession(base);
      assert.equal(session.statusCode, host === '0.0.0.0' ? 403 : 200);
      if (host === '0.0.0.0') {
        assert.equal(session.headers['set-cookie'], undefined);
        const local = await demoSession(`http://127.0.0.1:${app.address().port}`);
        assert.equal(local.statusCode, 200);
        assert.match(local.headers['set-cookie'][0], /^aw_session=/);
      } else assert.match(session.headers['set-cookie'][0], /^aw_session=/);
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  }
});

test('invalid and empty listener configuration fails before starting the app', async () => {
  for (const host of ['', ' ', 'localhost', '127.0.0.1:4318', 'bad-host', '::', '10.0.0.1'])
    await assert.rejects(startServer({ host, port: 0 }), /WORKSPACE_API_HOST/);
});

test('demo owner admission uses the socket peer across IPv6 and trusted proxies', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'tidb-peer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = await createApp({
    dataFile: join(directory, 'data.json'),
    trustedProxyList: trustedProxies('0.0.0.0/0,::1'),
  });
  await new Promise((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, '::', resolve);
  });
  t.after(() => new Promise((resolve) => app.close(resolve)));
  let peer;
  app.on('request', (req) => {
    peer = req.socket.remoteAddress;
  });
  for (const [address, expectedPeer] of [
    ['[::1]', '::1'],
    ['127.0.0.1', '::ffff:127.0.0.1'],
  ]) {
    const session = await demoSession(`http://${address}:${app.address().port}`);
    assert.equal(peer, expectedPeer);
    assert.equal(session.statusCode, 200);
  }
  const network = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry.family === 'IPv4' && !entry.internal);
  assert.ok(network);
  const denied = await demoSession(`http://${network.address}:${app.address().port}`);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.headers['set-cookie'], undefined);
});

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
