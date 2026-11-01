import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { agentInstructions } from './agent-instructions.ts';

test('downloaded agent instructions reference current OpenAPI operations and mounted origins', async () => {
  const contract = JSON.parse(
    await readFile(new URL('../../public/openapi.json', import.meta.url), 'utf8'),
  );
  const global = JSON.parse(
    await readFile(new URL('../../public/agent-entry-openapi.json', import.meta.url), 'utf8'),
  );
  const text = agentInstructions('https://workspace.example/studio/api');
  assert.ok(text.includes('API endpoint: https://workspace.example/studio/api'));
  assert.ok(global.paths['/v1/token-issuances']?.post);
  assert.ok(global.paths['/v1/workspaces/{workspaceId}/region-route']?.get);
  for (const [, method, path] of text.matchAll(
    /\b(GET|POST|PUT|DELETE) (\/[a-zA-Z0-9/{}?=&*-]+)/g,
  )) {
    if (path.startsWith('/v1/')) {
      assert.ok(global.paths[path]?.[method.toLowerCase()], `${method} ${path}`);
    } else {
      const canonical = '/workspaces/{workspaceId}' + path.split('?')[0];
      assert.ok(contract.paths[canonical]?.[method.toLowerCase()], `${method} ${canonical}`);
    }
  }
  assert.equal(
    /\/database-imports\/prepare|\/file-exports\/prepare|\/table\?name=|\/table\/rows/.test(text),
    false,
  );
  assert.match(text, /Idempotency-Key/);
  assert.match(text, /If-Match/);
});
