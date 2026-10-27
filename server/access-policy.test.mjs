import assert from 'node:assert/strict';
import test from 'node:test';
import { canAccessResource, normalizeResourceGrant } from './access-policy.mjs';

const resources = [{ id: 'mysql' }, { id: 'pg' }, { id: 'files' }];
test('resource grants fail closed and exact grants do not include other components', () => {
  assert.equal(canAccessResource(undefined, 'mysql'), false);
  assert.equal(canAccessResource([], 'mysql'), false);
  assert.equal(canAccessResource(['pg', 'files'], 'mysql'), false);
  assert.equal(canAccessResource(['pg', 'files'], 'files'), true);
  assert.equal(canAccessResource(['*'], 'future-resource'), true);
});
test('resource grants validate known IDs and an explicit wildcard', () => {
  assert.deepEqual(normalizeResourceGrant(['pg', 'pg', 'files'], resources), ['pg', 'files']);
  assert.deepEqual(normalizeResourceGrant(['*'], resources), ['*']);
  for (const input of [undefined, [], 'files', ['missing'], ['*', 'pg'], [null]]) {
    assert.throws(() => normalizeResourceGrant(input, resources), {
      code: 'INVALID_RESOURCE_GRANT',
    });
  }
});
