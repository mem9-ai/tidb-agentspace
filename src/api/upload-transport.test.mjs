import assert from 'node:assert/strict';
import test from 'node:test';
import { createUploadFetch } from './upload-transport.ts';
import { createWorkspaceClient, responseData, WorkspaceApiError } from './transport.ts';

class UploadRequest {
  upload = {};
  sent = Promise.withResolvers();
  headers = new Headers();
  sends = 0;
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(key, value) {
    this.headers.set(key, value);
  }
  getAllResponseHeaders() {
    return 'Content-Type: application/json\r\nX-Request-Id: upload-trace\r\n';
  }
  send(body) {
    this.body = body;
    this.sends++;
    this.sent.resolve();
  }
  abort() {
    this.onabort();
  }
  complete(status, body) {
    this.status = status;
    this.statusText = '';
    this.response = new TextEncoder().encode(JSON.stringify(body)).buffer;
    this.onload();
  }
}

async function setup(bytes = [0, 127, 255, 10], signal) {
  const xhr = new UploadRequest();
  const progress = [];
  const client = createWorkspaceClient(
    'http://localhost:4330',
    createUploadFetch(
      (update) => progress.push(update),
      () => xhr,
    ),
  );
  const pending = responseData(
    client.PUT('/workspaces/{workspaceId}/files/content', {
      params: {
        path: { workspaceId: 'ws_agentlab' },
        query: { resourceId: 'fs_live', path: '/hello world.bin' },
        header: { 'If-None-Match': '*' },
      },
      body: new Blob([new Uint8Array(bytes)]),
      bodySerializer: (body) => body,
      headers: { 'Content-Type': 'application/octet-stream' },
      signal,
    }),
  );
  await Promise.race([xhr.sent.promise, pending]);
  return { xhr, progress, pending };
}

test('upload transport preserves generated raw request, credentials and bytes; transfer completion is not persistence', async () => {
  const { xhr, progress, pending } = await setup();
  assert.equal(xhr.method, 'PUT');
  const url = new URL(xhr.url);
  assert.equal(url.origin, 'http://localhost:4330');
  assert.equal(url.pathname, '/api/v1/workspaces/ws_agentlab/files/content');
  assert.equal(url.searchParams.get('path'), '/hello world.bin');
  assert.equal(xhr.withCredentials, true);
  assert.equal(xhr.headers.get('if-none-match'), '*');
  assert.equal(xhr.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual([...new Uint8Array(await xhr.body.arrayBuffer())], [0, 127, 255, 10]);
  let acknowledged = false;
  void pending.then(() => {
    acknowledged = true;
  });
  xhr.upload.onprogress({ loaded: 2, total: 4, lengthComputable: true });
  xhr.upload.onload();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(progress, [{ phase: 'uploading', loaded: 2, total: 4 }, { phase: 'saving' }]);
  assert.equal(acknowledged, false);
  xhr.complete(201, { saved: true, size: 4 });
  assert.deepEqual(await pending, { saved: true, size: 4 });
  assert.equal(xhr.sends, 1);
});

test('unknown lengths and empty uploads do not invent a transfer percentage', async () => {
  const { xhr, progress, pending } = await setup([]);
  xhr.upload.onprogress({ loaded: 0, total: 0, lengthComputable: false });
  assert.deepEqual(progress, [{ phase: 'uploading', loaded: 0, total: undefined }]);
  assert.equal(xhr.body.size, 0);
  xhr.complete(200, { saved: true, size: 0 });
  assert.equal((await pending).size, 0);
});

test('upload keeps structured authorization, collision, size and provider errors through generated middleware', async () => {
  for (const [status, code] of [
    [403, 'INSUFFICIENT_SCOPE'],
    [409, 'ALREADY_EXISTS'],
    [413, 'FILE_TOO_LARGE'],
    [502, 'PROVIDER_UNAVAILABLE'],
  ]) {
    const { xhr, pending } = await setup();
    const rejection = assert.rejects(pending, (error) => {
      assert.ok(error instanceof WorkspaceApiError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.equal(error.requestId, 'upload-trace');
      return true;
    });
    xhr.complete(status, { error: { code, message: 'Upload rejected.' } });
    await rejection;
    assert.equal(xhr.sends, 1);
  }
});

test('network and timeout failures explain uncertain acknowledgement and never retry writes', async () => {
  for (const event of ['onerror', 'ontimeout']) {
    const { xhr, pending } = await setup();
    const rejection = assert.rejects(pending, /Refresh the folder before trying again/);
    xhr[event]();
    await rejection;
    assert.equal(xhr.sends, 1);
  }
});

test('an abort interrupts the transfer without a retry or success', async () => {
  const controller = new AbortController();
  const { xhr, pending } = await setup([1, 2], controller.signal);
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await rejection;
  assert.equal(xhr.sends, 1);
});
