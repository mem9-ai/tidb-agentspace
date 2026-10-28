import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorkspaceClient,
  resolveApiOrigin,
  responseData,
  WorkspaceApiError,
} from './transport.ts';

test('runtime API configuration validates the origin and supports same-origin gateways', () => {
  assert.equal(
    resolveApiOrigin({ apiOrigin: 'http://127.0.0.1:4318' }, 'http://127.0.0.1:4173'),
    'http://127.0.0.1:4318',
  );
  assert.equal(
    resolveApiOrigin({ apiOrigin: '' }, 'https://console.example.com'),
    'https://console.example.com',
  );
  for (const apiOrigin of [
    'https://example.com/api',
    'https://example.com/',
    'javascript:alert(1)',
    'https://user:password@example.com',
    '//example.com',
    123,
  ])
    assert.throws(() => resolveApiOrigin({ apiOrigin }, 'http://localhost:4173'));
  assert.throws(() => resolveApiOrigin({}, 'http://localhost:4173'));
});

test('generated client sends requests to the API origin with credentials, typed paths, queries, and raw uploads', async () => {
  const requests = [];
  const client = createWorkspaceClient('http://127.0.0.1:4318', async (request) => {
    requests.push(request);
    return Response.json({ saved: true, size: 3 });
  });
  await responseData(
    client.PUT('/workspaces/{workspaceId}/files/content', {
      params: {
        path: { workspaceId: 'ws_agentlab' },
        query: { resourceId: 'fs_shared', path: '/hello world.bin' },
        header: { 'If-None-Match': '*' },
      },
      body: new Blob([new Uint8Array([0, 127, 255])]),
      bodySerializer: (body) => body,
      headers: { 'Content-Type': 'application/octet-stream' },
    }),
  );
  const request = requests[0];
  const url = new URL(request.url);
  assert.equal(url.origin, 'http://127.0.0.1:4318');
  assert.equal(url.pathname, '/api/v1/workspaces/ws_agentlab/files/content');
  assert.equal(url.searchParams.get('path'), '/hello world.bin');
  assert.equal(request.credentials, 'include');
  assert.equal(request.headers.get('if-none-match'), '*');
  assert.deepEqual([...new Uint8Array(await request.arrayBuffer())], [0, 127, 255]);
});

test('transport exposes structured errors and handles a proxy returning non-JSON', async () => {
  for (const response of [
    Response.json(
      { error: { code: 'INSUFFICIENT_SCOPE', message: 'Denied', requestId: 'trace-1' } },
      { status: 403 },
    ),
    new Response('<html>Unavailable</html>', {
      status: 502,
      headers: { 'X-Request-Id': 'proxy-1' },
    }),
  ]) {
    const client = createWorkspaceClient('http://127.0.0.1:4318', async () => response);
    await assert.rejects(
      () => client.GET('/workspaces'),
      (error) => {
        assert.ok(error instanceof WorkspaceApiError);
        assert.equal(error.status, response.status);
        assert.equal(error.requestId, response.status === 403 ? 'trace-1' : 'proxy-1');
        if (response.status === 403) {
          assert.equal(error.code, 'INSUFFICIENT_SCOPE');
          assert.equal(error.message, 'Denied');
        }
        return true;
      },
    );
  }
});

test('subpath API configuration preserves the origin boundary and binary requests', async () => {
  const { resolveApiBaseUrl } = await import('./transport.ts');
  const origin = 'https://console.example.com';
  assert.equal(resolveApiBaseUrl({ apiOrigin: '' }, origin), origin);
  assert.equal(
    resolveApiBaseUrl({ apiOrigin: '', apiPathPrefix: '/studio' }, origin),
    origin + '/studio',
  );
  for (const prefix of [
    '/studio/',
    '//evil.invalid',
    '/..',
    '/a/../b',
    '/a%2fb',
    '/a?b',
    '/a#b',
    '/a\\b',
    1,
  ])
    assert.throws(() => resolveApiBaseUrl({ apiOrigin: '', apiPathPrefix: prefix }, origin));
  const requests = [];
  const client = createWorkspaceClient(origin + '/studio', async (request) => {
    requests.push(request);
    return Response.json({ saved: true, size: 3 });
  });
  await client.PUT('/workspaces/{workspaceId}/files/content', {
    params: {
      path: { workspaceId: 'ws_agentlab' },
      query: { resourceId: 'fs_shared', path: '/a.bin' },
    },
    body: new Blob([new Uint8Array([0, 127, 255])]),
    bodySerializer: (body) => body,
  });
  assert.equal(
    new URL(requests[0].url).pathname,
    '/studio/api/v1/workspaces/ws_agentlab/files/content',
  );
  assert.equal(requests[0].credentials, 'include');
  assert.deepEqual([...new Uint8Array(await requests[0].arrayBuffer())], [0, 127, 255]);
});
