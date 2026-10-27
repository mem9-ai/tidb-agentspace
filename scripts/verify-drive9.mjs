// Explicit opt-in smoke test: generated files only; never runs as part of npm test/check.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const [origin, resourceId] = process.argv.slice(2);
if (!origin || !resourceId || !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname))
  throw new Error('Usage: node scripts/verify-drive9.mjs <loopback-origin> <existing-resource-id>');
const base = origin + '/api/v1/workspaces/ws_agentlab';
const session = await fetch(origin + '/api/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
});
assert.equal(session.status, 200);
const cookie = session.headers.get('set-cookie').split(';')[0];
async function json(path, method = 'GET', data, key) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: 'Bearer ' + key } : { Cookie: cookie }),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  return { status: response.status, body: await response.json() };
}
const resources = (await json('/resources')).body.data;
assert.equal(resources.find((r) => r.id === resourceId)?.provider, 'drive9-anonymous');
const keys = [];
try {
  for (const scopes of [['files:read', 'files:write'], ['files:read']]) {
    const result = await json('/keys', 'POST', {
      name: 'Drive9 verification',
      scopes,
      resourceIds: [resourceId],
      expiresInDays: 7,
    });
    assert.equal(result.status, 201);
    keys.push(result.body);
  }
  const folder = '/verification-' + new Date().toISOString().replace(/[:.]/g, '-');
  assert.equal(
    (await json('/files', 'PUT', { resourceId, path: folder, type: 'directory' }, keys[0].secret))
      .status,
    200,
  );
  const fixtures = [
    [
      'README.md',
      Buffer.from(
        '# Live Singapore files\n\nUploaded through a **Workspace Key** to the real Drive9 anonymous trial.\n\n## Formats\n\n- Markdown renders in the side panel.\n- JSON and CSV have structured previews.\n- Large or binary files keep a download action.\n\n| Path | Purpose |\n| --- | --- |\n| workspace.json | Structured context |\n| resources.csv | Tabular context |\n| large.md | Preview limit |\n| sample.bin | Original binary bytes |\n',
      ),
    ],
    ['workspace.json', Buffer.from('{"region":"Singapore","counter":9007199254740993}\n')],
    [
      'resources.csv',
      Buffer.from('name,type,mode\nfiles,filesystem,live\n"memory, local",mysql,demo\n'),
    ],
    ['sample.bin', Buffer.from([0, 255, 1, 2, 127, 128, 254, 13, 10])],
    [
      'large.md',
      Buffer.from(
        '# Large file\n\n' +
          'Preview is bounded; download preserves the whole file.\n'.repeat(3000),
      ),
    ],
  ];
  const results = [];
  for (const [name, bytes] of fixtures) {
    const url =
      base + '/files/content?' + new URLSearchParams({ resourceId, path: folder + '/' + name });
    const headers = {
      Authorization: 'Bearer ' + keys[0].secret,
      'Content-Type': 'application/octet-stream',
      'If-None-Match': '*',
    };
    assert.equal((await fetch(url, { method: 'PUT', headers, body: bytes })).status, 200);
    const download = await fetch(url, { headers: { Authorization: 'Bearer ' + keys[1].secret } });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    const preview = await fetch(url + '&preview=1', {
      headers: { Authorization: 'Bearer ' + keys[1].secret },
    });
    const data = await preview.json();
    assert.equal(preview.status, 200);
    if (['sample.bin', 'large.md'].includes(name)) assert.ok(data.unavailableReason);
    else assert.equal(data.content, bytes.toString());
    assert.equal(
      (
        await fetch(url, {
          method: 'PUT',
          headers: { ...headers, Authorization: 'Bearer ' + keys[1].secret },
          body: bytes,
        })
      ).status,
      403,
    );
    results.push({
      name,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      preview: data.unavailableReason ? 'download-only' : 'text',
    });
  }
  await json('/keys/' + keys[1].data.id, 'DELETE');
  const denied = await fetch(base + '/files?resourceId=' + resourceId, {
    headers: { Authorization: 'Bearer ' + keys[1].secret },
  });
  assert.equal(denied.status, 401);
  console.log(
    JSON.stringify(
      { resourceId, folder, results, readOnlyWriteDenied: true, revocationVerified: true },
      null,
      2,
    ),
  );
} finally {
  for (const key of keys) assert.equal((await json('/keys/' + key.data.id, 'DELETE')).status, 200);
}
