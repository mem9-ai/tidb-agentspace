import assert from 'node:assert/strict';
import test from 'node:test';
import { revokeAndConfirmRegion } from './revoke-confirm.mjs';

test('a pending revocation is confirmed for the same Key version before proceeding', async () => {
  const calls = [];
  const fixture = {
    revokeKey: async (id) => {
      calls.push(['revoke', id]);
      return { status: 202, body: { regionalStatus: 'pending' } };
    },
    deliver: async (id, version) => {
      calls.push(['deliver', id, version]);
      return {
        status: 201,
        body: { data: { regionalStatus: calls.length === 2 ? 'pending' : 'applied' } },
      };
    },
  };
  await revokeAndConfirmRegion(fixture, { id: 'test-key', keyVersion: 4 }, { delayMs: 0 });
  assert.deepEqual(calls, [
    ['revoke', 'test-key'],
    ['deliver', 'test-key', 5],
    ['deliver', 'test-key', 5],
  ]);
});

test('an applied revocation is not repeated and an unconfirmed one fails', async () => {
  const fixture = {
    revokeKey: async () => ({ status: 202, body: { regionalStatus: 'applied' } }),
    deliver: async () => assert.fail('already applied'),
  };
  await revokeAndConfirmRegion(fixture, { id: 'test-key', keyVersion: 1 });
  fixture.revokeKey = async () => ({ status: 202, body: { regionalStatus: 'pending' } });
  await assert.rejects(
    revokeAndConfirmRegion(fixture, { id: 'test-key', keyVersion: 1 }, { timeoutMs: 0 }),
    /must be applied/,
  );
});
