import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const load = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

test('Agent OpenAPI excludes Portal sessions and Key administration', async () => {
  const region = await load('../public/openapi.json');
  const global = await load('../public/global-openapi.json');
  const entry = await load('../public/agent-entry-openapi.json');
  const portal = await load('../tools/api-contract/portal-regional-openapi.json');
  const portalGlobal = await load('../tools/api-contract/portal-global-openapi.json');
  assert.ok(region.paths['/workspaces/{workspaceId}/resources']);
  assert.ok(global.paths['/api/v1/token-issuances']);
  assert.deepEqual(entry.servers, [{ url: '/api' }]);
  assert.ok(entry.paths['/v1/token-issuances']?.post);
  assert.ok(entry.paths['/v1/workspaces/{workspaceId}/region-route']?.get);
  assert.ok(entry.paths['/v1/workspaces/{workspaceId}/regions']?.get);
  assert.ok(entry.paths['/v1/workspaces/{workspaceId}/issuances/{issuanceId}']?.get);
  assert.equal(entry.paths['/v1/workspaces/{workspaceId}/keys'], undefined);
  assert.equal(region.paths['/workspaces/{workspaceId}/bootstrap'], undefined);
  assert.equal(region.paths['/api/auth/guest'], undefined);
  assert.equal(global.paths['/api/v1/workspaces/{workspaceId}/keys'], undefined);
  assert.equal(global.paths['/api/auth/session'], undefined);
  assert.ok(portal.paths['/workspaces/{workspaceId}/bootstrap']);
  assert.ok(portalGlobal.paths['/api/portal/v1/workspaces/{workspaceId}/keys']);
  for (const schema of [region, global])
    for (const entry of Object.values(schema.paths))
      for (const operation of Object.values(entry))
        for (const requirement of operation?.security || [])
          assert.equal(
            Object.keys(requirement).some((key) => /owner/i.test(key)),
            false,
          );
});
