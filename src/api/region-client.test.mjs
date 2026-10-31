import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createRegionClient, validateRegionEndpoint } from './region-client.ts';

test('regional credentials go only to the pinned Region origin and API prefix', async () => {
  const endpoint = {
    regionId: 'region:ap-southeast-1',
    apiOrigin: 'https://region.example',
    apiPathPrefix: '/gateway',
  };
  const requests = [];
  const client = createRegionClient(endpoint, [endpoint.apiOrigin], 'region-secret', async (r) => {
    requests.push(r);
    return Response.json({ data: [] });
  });
  await client.GET('/workspaces/{workspaceId}/resources', {
    params: { path: { workspaceId: 'ws_a' } },
  });
  assert.equal(requests[0].url, 'https://region.example/gateway/api/v1/workspaces/ws_a/resources');
  assert.equal(requests[0].headers.get('authorization'), 'Bearer region-secret');
  assert.equal(requests[0].credentials, 'omit');
  assert.equal(requests[0].redirect, 'error');
  for (const value of [
    { ...endpoint, apiOrigin: 'https://attacker.example' },
    { ...endpoint, apiOrigin: 'https://region.example/redirect' },
    { ...endpoint, apiOrigin: 'http://region.example' },
    { ...endpoint, apiPathPrefix: '/../admin' },
    { ...endpoint, regionId: 'invalid' },
  ])
    assert.throws(() => validateRegionEndpoint(value, [endpoint.apiOrigin]));
});

test('a regional response cannot redirect credentials to another origin', async (t) => {
  let leaked = false;
  const sink = http.createServer((_, res) => {
    leaked = true;
    res.end();
  });
  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
  t.after(() => sink.close());
  const target = http.createServer((_, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${sink.address().port}/stolen` });
    res.end();
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  t.after(() => target.close());
  const apiOrigin = `http://127.0.0.1:${target.address().port}`;
  const client = createRegionClient(
    { regionId: 'region:test', apiOrigin, apiPathPrefix: '' },
    [apiOrigin],
    'secret',
  );
  await assert.rejects(() => client.GET('/workspaces'));
  assert.equal(leaked, false);
});
