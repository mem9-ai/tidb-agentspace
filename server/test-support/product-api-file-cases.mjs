import assert from 'node:assert/strict';

export async function fileCases(t, { request, token, provider }) {
  await t.test(
    'local file paths, UTF-8 writes, conflicts and deletion preserve exact state',
    async () => {
      const file = { resourceId: 'fs_shared', path: '/notes', type: 'directory' };
      await request('/files', { method: 'PUT', token, body: file });
      const saved = await request('/files', {
        method: 'PUT',
        token,
        body: { ...file, path: '/notes//测试.txt', type: 'file', content: 'first\n😀\0end' },
      });
      assert.equal(saved.body.data.path, '/notes/测试.txt');
      assert.equal(saved.body.data.size, Buffer.byteLength('first\n😀\0end'));
      await request('/files', {
        method: 'PUT',
        token,
        body: { ...file, path: '/notes/测试.txt', type: 'file', content: 'updated\r\n😀' },
      });
      assert.equal(
        (await request('/files?resourceId=fs_shared&path=/notes', { token })).body.data[0].content,
        'updated\r\n😀',
      );
      await request(
        '/files',
        { method: 'DELETE', token, body: { resourceId: 'fs_shared', path: '/notes' } },
        409,
        'DIRECTORY_NOT_EMPTY',
      );
      await request(
        '/files',
        { method: 'PUT', token, body: { ...file, path: '/notes/测试.txt' } },
        409,
        'TYPE_CONFLICT',
      );
      await request(
        '/files',
        {
          method: 'PUT',
          token,
          body: { ...file, path: '/missing/file.txt', type: 'file', content: 'x' },
        },
        404,
        'PARENT_MISSING',
      );
      const before = provider.calls;
      for (const path of ['relative', '/a/../b', '/a/./b', '/a\\b', '/nul\0file'])
        await request(
          '/files',
          {
            method: 'PUT',
            token,
            body: { resourceId: 'fs_live', path, type: 'file', content: 'x' },
          },
          400,
          'INVALID_PATH',
        );
      assert.equal(provider.calls, before);
      await request('/files', {
        method: 'DELETE',
        token,
        body: { resourceId: 'fs_shared', path: '/notes/测试.txt' },
      });
      await request(
        '/files',
        { method: 'DELETE', token, body: { resourceId: 'fs_shared', path: '/notes/测试.txt' } },
        404,
        'NOT_FOUND',
      );
      assert.deepEqual(
        (await request('/files?resourceId=fs_shared&path=/notes', { token })).body.data,
        [],
      );
    },
  );

  await t.test(
    'native binary transfer and create-only conflicts preserve bytes and headers',
    async () => {
      const bytes = Buffer.from([0, 255, 13, 10, 128, 34]);
      const path =
        '/files/content?' + new URLSearchParams({ resourceId: 'fs_live', path: '/二进制.bin' });
      const sent = await request(path, {
        method: 'PUT',
        token,
        raw: bytes,
        headers: { 'Content-Type': 'application/octet-stream', 'If-None-Match': '*' },
      });
      assert.equal(sent.body.size, bytes.length);
      await request(
        path,
        {
          method: 'PUT',
          token,
          raw: Buffer.from('replacement'),
          headers: { 'Content-Type': 'application/octet-stream', 'If-None-Match': '*' },
        },
        412,
        'PRECONDITION_FAILED',
      );
      const download = await request(path, { token });
      assert.deepEqual(download.body, bytes);
      assert.equal(download.headers.get('content-type'), 'application/octet-stream');
      assert.equal(download.headers.get('content-length'), String(bytes.length));
      assert.equal(
        download.headers.get('content-disposition'),
        "attachment; filename*=UTF-8''%E4%BA%8C%E8%BF%9B%E5%88%B6%2Ebin",
      );
      await request(path, {
        method: 'PUT',
        token,
        raw: Buffer.from('updated'),
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      assert.deepEqual((await request(path, { token })).body, Buffer.from('updated'));
      await request('/files', {
        method: 'DELETE',
        token,
        body: { resourceId: 'fs_live', path: '/二进制.bin' },
      });
      await request(path, { token }, 404, 'NOT_FOUND');
    },
  );
}
