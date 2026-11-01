import assert from 'node:assert/strict';
import test from 'node:test';
import { connectAgent } from './agent-client.ts';
import { connectWorkspace } from '../generated/workspace-agent.mjs';

const global = 'http://127.0.0.1:4318';
const apiEndpoint = global + '/api';
const region = 'http://127.0.0.1:4319';
const workspace = 'ws_test';
const regionId = 'region:test';
const key = 'awk_test_private_workspace_key';

function fixture({ location = region, issuanceOrigin = region } = {}) {
  const requests = [];
  let offline = false;
  const fetcher = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.clone().json() : null;
    requests.push({
      url: url.href,
      method: request.method,
      authorization: request.headers.get('authorization'),
      body,
      redirect: request.redirect,
    });
    if (url.origin === global) {
      if (offline) throw new Error('Global offline');
      if (url.pathname === '/api/v1/token-issuances' && body.audience === 'global')
        return Response.json(
          {
            id: 'global-id',
            accessToken: 'global-token',
            tokenType: 'Bearer',
            expiresAt: 9999999999,
            scopes: ['resources:read'],
            workspaceId: workspace,
          },
          { status: 201 },
        );
      if (url.pathname.endsWith('/region-route'))
        return new Response(null, {
          status: 307,
          headers: { Location: location, 'X-Region-Id': regionId },
        });
      if (url.pathname === '/api/v1/token-issuances' && body.audience === 'region')
        return Response.json(
          {
            id: 'region-id',
            accessToken: 'region-token',
            tokenType: 'Bearer',
            expiresAt: 9999999999,
            scopes: ['resources:read'],
            keyId: 'key-1',
            principalId: 'principal-1',
            keyVersion: 1,
            workspaceId: workspace,
            region: { regionId, apiOrigin: issuanceOrigin, apiPathPrefix: '' },
            enrollmentTicket: 'ticket',
            enrollmentExpiresAt: 9999999999,
            nonce: 'enrollment-nonce',
          },
          { status: 201 },
        );
    }
    if (url.origin === region && url.pathname.endsWith('/refresh-families'))
      return Response.json(
        {
          keyId: 'key-1',
          familyId: 'family-1',
          refreshCredential: 'refresh-1',
          nonce: 'nonce-1',
          expiresAt: 9999999999,
        },
        { status: 201 },
      );
    if (url.origin === region && url.pathname.endsWith('/token-issuances'))
      return Response.json(
        {
          keyId: 'key-1',
          familyId: 'family-1',
          refreshCredential: 'refresh-2',
          nonce: 'nonce-2',
          refreshExpiresAt: 9999999999,
          accessToken: 'region-token-2',
          expiresAt: 9999999999,
        },
        { status: 201 },
      );
    if (url.origin === region && url.pathname.endsWith('/resources'))
      return Response.json({ data: [], nextCursor: null });
    if (url.origin === region && url.pathname.endsWith('/files'))
      return Response.json({ data: [], nextCursor: null });
    if (url.origin === region && url.pathname.endsWith('/queries'))
      return Response.json({ columns: ['ready'], rows: [{ ready: 1 }], rowCount: 1 });
    throw new Error(`Unexpected request ${url.origin}${url.pathname}`);
  };
  return {
    requests,
    fetcher,
    stopGlobal() {
      offline = true;
    },
  };
}

test('downloadable client connects with one endpoint and provides simple resource operations', async () => {
  const f = fixture();
  const workspaceClient = await connectWorkspace({
    endpoint: apiEndpoint,
    apiKey: key,
    fetcher: f.fetcher,
  });
  assert.deepEqual(await workspaceClient.listResources(), { data: [], nextCursor: null });
  await workspaceClient.listResources({ cursor: 'next-page', limit: 20 });
  assert.deepEqual(await workspaceClient.listFiles('fs-1', '/docs'), {
    data: [],
    nextCursor: null,
  });
  assert.deepEqual((await workspaceClient.query('db-1', 'SELECT 1')).rows, [{ ready: 1 }]);
  await workspaceClient.query('db-1', 'INSERT INTO sample VALUES (1)', { readOnly: false });
  const query = f.requests.find((request) => request.url.endsWith('/queries'));
  assert.equal(query.body.readOnly, true);
  assert.equal(
    f.requests.find((request) => request.body?.sql?.startsWith('INSERT')).body.readOnly,
    false,
  );
  assert.ok(f.requests.some((request) => request.url.includes('cursor=next-page&limit=20')));
  assert.ok(
    f.requests.some((request) => request.url.includes('/files?resourceId=fs-1&path=%2Fdocs')),
  );
});

test('one Global endpoint discovers a trusted redirect and keeps data on Region', async () => {
  const f = fixture();
  const agent = await connectAgent({ endpoint: apiEndpoint, key, fetcher: f.fetcher });
  assert.equal(agent.workspaceId, workspace);
  await agent.client.GET('/workspaces/{workspaceId}/resources', {
    params: { path: { workspaceId: agent.workspaceId } },
  });
  assert.ok(f.requests.some((r) => r.url.startsWith(region) && r.url.endsWith('/resources')));
  assert.ok(
    f.requests
      .filter((r) => r.url.startsWith(region))
      .every((r) => !r.authorization?.includes(key)),
  );
  const route = f.requests.find((r) => r.url.endsWith('/region-route'));
  assert.equal(route.redirect, 'manual');
  assert.equal(route.body, null);
  assert.equal(route.authorization, 'Bearer global-token');
  assert.ok(
    f.requests.filter((r) => r.url.startsWith(global)).every((r) => !r.url.endsWith('/resources')),
  );
});

test('untrusted redirects and tampered cached Region routes never receive credentials', async () => {
  const bad = fixture({ location: 'http://evil.example.test' });
  await assert.rejects(
    connectAgent({ endpoint: apiEndpoint, key, fetcher: bad.fetcher }),
    /Untrusted Region/,
  );
  assert.ok(bad.requests.every((r) => r.url.startsWith(global)));
  const mismatch = fixture({ location: region + '/other' });
  await assert.rejects(
    connectAgent({ endpoint: apiEndpoint, key, fetcher: mismatch.fetcher }),
    /does not match/,
  );
  assert.ok(mismatch.requests.every((r) => r.url.startsWith(global)));

  const f = fixture();
  let saved;
  const secrets = {
    async load() {
      return saved;
    },
    async save(value) {
      saved = value;
    },
  };
  const proofKey = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  await connectAgent({ endpoint: apiEndpoint, key, fetcher: f.fetcher, proofKey, secrets });
  saved = { ...saved, endpoint: { ...saved.endpoint, apiOrigin: 'https://evil.example.test' } };
  const before = f.requests.length;
  await assert.rejects(
    connectAgent({ endpoint: apiEndpoint, key, fetcher: f.fetcher, proofKey, secrets }),
    /different Global endpoint or Key/,
  );
  assert.equal(f.requests.length, before);
});

test('a saved proof-bound connection resumes and renews directly while Global is offline', async () => {
  const f = fixture();
  let saved;
  const secrets = {
    async load() {
      return saved;
    },
    async save(value) {
      saved = value;
    },
  };
  const proofKey = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  await connectAgent({ endpoint: apiEndpoint, key, fetcher: f.fetcher, proofKey, secrets });
  f.stopGlobal();
  const before = f.requests.length;
  const agent = await connectAgent({
    endpoint: apiEndpoint,
    key,
    fetcher: f.fetcher,
    proofKey,
    secrets,
  });
  await agent.client.GET('/workspaces/{workspaceId}/resources', {
    params: { path: { workspaceId: agent.workspaceId } },
  });
  assert.ok(f.requests.slice(before).every((r) => r.url.startsWith(region)));
  assert.equal(f.requests.at(-1).authorization, 'Bearer region-token-2');
});
