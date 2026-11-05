import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

export async function privateCsvCases(origin, browserGuest) {
  const key = randomBytes(32).toString('hex');
  const call = (route, method = 'GET', body, headers = {}) =>
    fetch(origin + '/api/v1/agent-csv/' + route, {
      method,
      body,
      headers: { Host: 'studio.example.test', Authorization: 'CsvWorkspace ' + key, ...headers },
    });
  assert.equal(
    (await call('workspaces', 'POST', undefined, { Cookie: browserGuest.cookie })).status,
    400,
  );
  assert.equal(
    (await call('workspaces', 'POST', undefined, { Authorization: 'Trial invalid' })).status,
    401,
  );
  const enroll = async () => {
    const response = await call('workspaces', 'POST');
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('set-cookie'), null);
    return response.json();
  };
  const workspace = await enroll();
  assert.deepEqual(await enroll(), workspace);
  assert.notEqual(workspace.workspaceId, browserGuest.workspaceId);
  assert.ok(Math.abs(workspace.expiresAt - Date.now() / 1000 - 86400) < 30);
  const source = 'workspaces/' + workspace.workspaceId + '/sources/' + workspace.resourceId + '/';
  const content = source + 'content';
  assert.ok(
    [401, 403].includes(
      (
        await call(content, 'GET', undefined, {
          Authorization: 'CsvWorkspace ' + randomBytes(32).toString('hex'),
        })
      ).status,
    ),
  );
  assert.ok(
    [401, 403].includes(
      (await call(content.replace(workspace.workspaceId, browserGuest.workspaceId))).status,
    ),
  );
  assert.equal((await call(source + 'metadata')).status, 404);
  const data = 'city,sales\nOakland,40\n';
  const put = (value, precondition) =>
    call(content, 'PUT', value, { 'Content-Type': 'text/csv', ...precondition });
  assert.equal((await put(data, {})).status, 428);
  const saved = await put(data, { 'If-None-Match': '*' });
  assert.equal(saved.status, 200, await saved.text());
  const metadata = await (await call(source + 'metadata')).json();
  const version = metadata.data.version;
  assert.ok(version);
  assert.equal(await (await call(content)).text(), data);
  assert.equal((await put('different', { 'If-None-Match': '*' })).status, 412);
  assert.equal((await put('different', { 'If-Match': '"stale"' })).status, 412);
  const updated = data + 'Austin,20\n';
  assert.equal((await put(updated, { 'If-Match': version })).status, 200);
  assert.equal((await call(content, 'DELETE')).status, 404);
  return async () => {
    assert.equal(await (await call(content)).text(), updated);
    assert.notEqual((await (await call(source + 'metadata')).json()).data.version, version);
  };
}
