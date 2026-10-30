import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from './regression-api.mjs';

const base = '/api/v1/workspaces/ws_agentlab';
const internalToken = 'test-only-internal-credential';
function fakeDrive9() {
  const files = new Map();
  const calls = [];
  let creates = 0;
  let failCreate = false;
  let failReads = false;
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
  return {
    calls,
    files,
    get creates() {
      return creates;
    },
    failCreate() {
      failCreate = true;
    },
    failReads(value) {
      failReads = value;
    },
    async transport(url, options) {
      assert.equal(new URL(url).origin, 'https://api.drive9.ai');
      assert.equal(options.redirect, 'error');
      const path = new URL(url).pathname;
      const method = options.method || 'GET';
      calls.push({ path, method });
      if (path === '/v1/provision') {
        creates++;
        assert.equal(options.headers.Authorization, undefined);
        if (failCreate) throw new Error(internalToken);
        return json(
          { api_key: internalToken, tenant_id: 'test-tenant', status: 'provisioning' },
          202,
        );
      }
      assert.equal(options.headers.Authorization, 'Bearer ' + internalToken);
      if (failReads) return json({ error: internalToken }, 500);
      if (path === '/v1/status')
        return json({
          status: 'active',
          max_upload_bytes: 5 * 1024 * 1024,
          inline_threshold: 1024 * 1024,
        });
      const filePath = decodeURIComponent(path.slice('/v1/fs'.length));
      const query = new URL(url).searchParams;
      const file = files.get(filePath);
      if (query.has('list')) {
        const entries = [...files]
          .filter(([name]) => (name.slice(0, name.lastIndexOf('/')) || '/') === filePath)
          .map(([name, data]) => ({
            name: name.split('/').pop(),
            size: data?.length || 0,
            isDir: data === null,
            mtime: 1700000000,
          }));
        return json({ entries });
      }
      if (method === 'POST' && query.has('mkdir')) {
        files.set(filePath, null);
        return json({});
      }
      if (method === 'PUT') {
        if (options.headers['X-Dat9-Expected-Revision'] === '0' && files.has(filePath))
          return json({}, 409);
        files.set(filePath, Buffer.from(options.body));
        return json({ revision: 1 });
      }
      if (!files.has(filePath)) return json({ error: internalToken }, 404);
      if (method === 'HEAD')
        return new Response(null, {
          headers: {
            'Content-Length': String(file?.length || 0),
            'X-Dat9-IsDir': String(file === null),
          },
        });
      if (method === 'DELETE') {
        if ([...files.keys()].some((p) => p.startsWith(filePath + '/'))) return json({}, 409);
        files.delete(filePath);
        return json({});
      }
      return new Response(file);
    },
  };
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-drive9-'));
  const dataFile = join(dir, 'workspace.json');
  const provider = fakeDrive9();
  let server, origin, cookie;
  async function start() {
    server = await createApp({
      dataFile,
      filesProvider: 'drive9-anonymous',
      drive9Transport: provider.transport,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(origin + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    cookie = response.headers.get('set-cookie').split(';')[0];
  }
  const stop = () => new Promise((resolve) => server.close(resolve));
  await start();
  t.after(async () => {
    await stop();
    await rm(dir, { recursive: true, force: true });
  });
  async function request(path, { method = 'GET', data, key, raw, headers = {} } = {}) {
    const response = await fetch(origin + base + path, {
      method,
      headers: {
        ...(key ? { Authorization: 'Bearer ' + key } : { Cookie: cookie }),
        'Content-Type': raw ? 'application/octet-stream' : 'application/json',
        ...headers,
      },
      body: raw ?? (data ? JSON.stringify(data) : undefined),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      headers: response.headers,
      bytes,
      body: response.headers.get('content-type')?.includes('json') ? JSON.parse(bytes) : undefined,
    };
  }
  const create = () =>
    request('/resources', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'trial-create' },
      data: { name: 'trial-files', kind: 'filesystem', region: 'aws-ap-southeast-1' },
    });
  async function key(scopes, resourceIds) {
    return (
      await request('/keys', {
        method: 'POST',
        data: { name: 'test agent', scopes, resourceIds, expiresInDays: 7 },
      })
    ).body;
  }
  return {
    provider,
    request,
    create,
    key,
    dataFile,
    restart: async () => {
      await stop();
      await start();
    },
  };
}

test('anonymous tenant persists once, reuses credentials after restart, and never exposes provider secrets', async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  assert.equal(created.status, 201);
  const resource = created.body.data;
  assert.equal(resource.provider, 'drive9-anonymous');
  assert.equal(resource.status, 'active');
  assert.equal(resource.uploadLimitBytes, 1024 * 1024);
  await f.create();
  await f.restart();
  await f.create();
  assert.equal(f.provider.creates, 1);
  for (const route of ['/bootstrap', '/resources', '/events', '/usage']) {
    const result = await f.request(route);
    assert.equal(result.status, 200);
    assert.ok(!result.bytes.includes(Buffer.from(internalToken)));
    assert.ok(!result.bytes.includes(Buffer.from('test-tenant')));
  }
  assert.ok(!(await readFile(f.dataFile, 'utf8')).includes(internalToken));
  assert.ok((await readFile(f.dataFile + '.providers.json', 'utf8')).includes(internalToken));
  assert.equal((await stat(f.dataFile + '.providers.json')).mode & 0o777, 0o600);
  const existing = (await f.request('/bootstrap')).body;
  assert.ok(existing.files.some((file) => file.path === '/AGENTS.md'));
  f.provider.failReads(true);
  const error = await f.request('/files?resourceId=' + resource.id);
  assert.equal(error.status, 502);
  assert.ok(!error.bytes.includes(Buffer.from(internalToken)));
});

test('Workspace Key enforces scope, resource, workspace, expiration and revocation before provider I/O', async (t) => {
  const f = await fixture(t);
  const id = (await f.create()).body.data.id;
  const reader = await f.key(['files:read'], [id]);
  const other = await f.key(['files:read', 'files:write'], ['fs_shared']);
  const expired = await f.key(['files:read'], [id]);
  const content = '/files/content?resourceId=' + id + '&path=%2Ffile.md';
  const before = f.provider.calls.length;
  assert.equal(
    (await f.request(content, { method: 'PUT', key: reader.secret, raw: Buffer.from('denied') }))
      .status,
    403,
  );
  assert.equal((await f.request(content, { key: other.secret })).status, 403);
  assert.equal((await f.request('/files?resourceId=' + id, { key: other.secret })).status, 403);
  assert.equal(
    (
      await f.request('/files', {
        method: 'DELETE',
        key: other.secret,
        data: { resourceId: id, path: '/file.md' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request('/../ws_other/files?resourceId=' + id, { key: reader.secret })).status,
    404,
  );
  await f.request('/keys/' + reader.data.id, { method: 'DELETE' });
  assert.equal((await f.request(content, { key: reader.secret })).status, 401);
  const state = JSON.parse(await readFile(f.dataFile, 'utf8'));
  state.keys.find(
    (k) => k.digest === createHash('sha256').update(expired.secret).digest('hex'),
  ).expiresAt = '2000-01-01T00:00:00.000Z';
  await writeFile(f.dataFile, JSON.stringify(state));
  await f.restart();
  assert.equal((await f.request(content, { key: expired.secret })).status, 401);
  assert.equal(f.provider.calls.length, before);
});

test('binary/text transfers preserve bytes, bounded previews avoid large reads, paths and creates are protected', async (t) => {
  const f = await fixture(t);
  const id = (await f.create()).body.data.id;
  const key = (await f.key(['files:read', 'files:write'], [id])).secret;
  const url = (path, preview = false) =>
    '/files/content?' +
    new URLSearchParams({ resourceId: id, path, ...(preview ? { preview: '1' } : {}) });
  for (const [path, bytes] of [
    ['/日本語 #?.md', Buffer.from('# Hello 世界\r\n')],
    ['/sample.bin', Buffer.from([0, 255, 1, 2, 3])],
    ['/large.md', Buffer.alloc(128 * 1024 + 1, 65)],
  ]) {
    assert.equal(
      (
        await f.request(url(path), {
          method: 'PUT',
          key,
          raw: bytes,
          headers: { 'If-None-Match': '*' },
        })
      ).status,
      200,
    );
    const downloaded = await f.request(url(path), { key });
    assert.equal(downloaded.status, 200);
    assert.deepEqual(downloaded.bytes, bytes);
    assert.ok(downloaded.headers.get('content-disposition').startsWith('attachment;'));
    assert.equal(
      (
        await f.request(url(path), {
          method: 'PUT',
          key,
          raw: bytes,
          headers: { 'If-None-Match': '*' },
        })
      ).status,
      409,
    );
  }
  const list = await f.request('/files?resourceId=' + id, { key });
  assert.equal(list.body.data.length, 3);
  assert.ok(list.body.data.every((file) => !('content' in file)));
  assert.equal(
    (await f.request(url('/日本語 #?.md', true), { key })).body.content,
    '# Hello 世界\r\n',
  );
  assert.match(
    (await f.request(url('/sample.bin', true), { key })).body.unavailableReason,
    /binary/,
  );
  const reads = f.provider.calls.filter(
    (c) => c.method === 'GET' && c.path.includes('large'),
  ).length;
  assert.match(
    (await f.request(url('/large.md', true), { key })).body.unavailableReason,
    /128 KiB/,
  );
  assert.equal(
    f.provider.calls.filter((c) => c.method === 'GET' && c.path.includes('large')).length,
    reads,
  );
  assert.equal((await f.request(url('/../secret'), { key })).status, 400);
  assert.equal(
    (await f.request('/files', { method: 'DELETE', key, data: { resourceId: id, path: '/' } }))
      .status,
    400,
  );
  assert.equal(
    (
      await f.request('/files', {
        method: 'PUT',
        key,
        data: { resourceId: id, path: '/folder', type: 'directory' },
      })
    ).status,
    200,
  );
  f.provider.files.set('/folder/keep', Buffer.from('keep'));
  assert.equal(
    (
      await f.request('/files', {
        method: 'DELETE',
        key,
        data: { resourceId: id, path: '/folder' },
      })
    ).status,
    409,
  );
});

test('uncertain provisioning is durably blocked instead of creating duplicate tenants', async (t) => {
  const f = await fixture(t);
  f.provider.failCreate();
  const first = await f.create();
  assert.match(first.body.data.connectionError, /unavailable/);
  await f.restart();
  const retry = await f.create();
  assert.match(retry.body.data.connectionError, /unknown/);
  assert.equal(f.provider.creates, 1);
});

test('upload bounds reject oversize bytes before provider writes', async (t) => {
  const f = await fixture(t);
  const id = (await f.create()).body.data.id;
  const url = '/files/content?' + new URLSearchParams({ resourceId: id, path: '/bounded.bin' });
  const before = f.provider.calls.length;
  const result = await f.request(url, { method: 'PUT', raw: Buffer.alloc(1024 * 1024 + 1) });
  assert.equal(result.status, 413);
  assert.equal(f.provider.calls.length, before);
  assert.equal(
    (await f.request(url, { method: 'PUT', raw: Buffer.alloc(1024 * 1024) })).status,
    200,
  );
});
