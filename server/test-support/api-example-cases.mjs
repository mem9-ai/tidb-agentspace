import assert from 'node:assert/strict';
import { connectWorkspace } from '../../src/generated/workspace-agent.mjs';
import { productApiFixture } from './product-api-fixture.mjs';

// Exercise the downloaded client with the same endpoint and Key shown by the Console.
export async function apiExampleCases(t) {
  const fixture = await productApiFixture(t, 'remote');
  const issued = await fixture.issueKey({
    name: 'documented-examples',
    scopes: ['resources:read', 'queries:read', 'files:read'],
    resourceIds: ['db_live', 'fs_live'],
    expiresInDays: 7,
  });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const key = issued.body.workspaceKey;
  const endpoint = new URL(fixture.endpoints.global).origin + '/api';
  const requests = [];
  const client = await connectWorkspace({
    endpoint,
    apiKey: key,
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, authorization: request.headers.get('authorization') });
      return fetch(request);
    },
  });
  const resources = await client.listResources();
  assert.ok(resources.data.some((resource) => resource.id === 'db_live'));
  assert.ok(resources.data.some((resource) => resource.id === 'fs_live'));
  assert.ok(requests.some((request) => request.url === endpoint + '/v1/token-issuances'));
  assert.ok(
    requests.some(
      (request) =>
        request.url.startsWith(fixture.endpoints.region) && request.url.endsWith('/resources'),
    ),
  );
  assert.ok(requests.every((request) => !request.url.includes('/api/global')));
  assert.ok(
    requests
      .filter((request) => request.url !== endpoint + '/v1/token-issuances')
      .every((request) => !request.authorization?.includes(key)),
  );
}
