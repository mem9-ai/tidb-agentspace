import assert from 'node:assert/strict';
import test from 'node:test';
import { createGlobalApiClient } from './global-client.ts';

const origin = 'https://workspace.example';

test('Global client accepts bounded origin paths', () => {
  for (const endpoint of [origin, `${origin}/`, `${origin}/studio/api`, `${origin}/studio/api/`])
    assert.doesNotThrow(() => createGlobalApiClient(endpoint, [origin]), endpoint);
});

test('Global client rejects hostile or ambiguous origin paths', { timeout: 1000 }, () => {
  for (const endpoint of [
    `${origin}/studio//api`,
    `${origin}/studio%2fapi`,
    `${origin}/studio/api?next=other`,
    `${origin}/studio/api#other`,
    `${origin}/${'-'.repeat(100_000)}!`,
  ])
    assert.throws(() => createGlobalApiClient(endpoint, [origin]), endpoint);
});
