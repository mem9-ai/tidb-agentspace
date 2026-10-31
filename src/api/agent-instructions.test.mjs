import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { agentInstructions } from './agent-instructions.ts';

test('downloaded agent instructions reference current OpenAPI operations and mounted origins', async () => {
  const contract = JSON.parse(
    await readFile(new URL('../../public/openapi.json', import.meta.url), 'utf8'),
  );
  const text = agentInstructions('personal-workspace', 'https://region.example/api-proxy');
  assert.ok(text.includes('https://region.example/api-proxy/api/v1/workspaces/personal-workspace'));
  for (const [, method, path] of text.matchAll(
    /\b(GET|POST|PUT|DELETE) (\/[a-zA-Z0-9/{}?=&*-]+)/g,
  )) {
    const canonical = '/workspaces/{workspaceId}' + path.split('?')[0];
    assert.ok(contract.paths[canonical]?.[method.toLowerCase()], `${method} ${canonical}`);
  }
  assert.equal(
    /\/database-imports\/prepare|\/file-exports\/prepare|\/table\?name=|\/table\/rows/.test(text),
    false,
  );
  assert.match(text, /Idempotency-Key/);
  assert.match(text, /If-Match/);
});
