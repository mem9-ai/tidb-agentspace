import assert from 'node:assert/strict';
import test from 'node:test';
import { enableGuest } from './enable-guest.mjs';

const config = {
  namespace: 'dev',
  deployment: 'workspace',
  container: 'api',
  origin: 'https://studio.example',
};
const target = JSON.stringify({
  spec: { template: { spec: { containers: [{ name: 'api', env: [] }] } } },
});
const good = async (url) => {
  if (url.endsWith('/api/auth/config')) return new Response(JSON.stringify({ guestEnabled: true }));
  if (url.endsWith('/api/auth/guest'))
    return new Response(JSON.stringify({ workspaceId: 'workspace-id' }), {
      headers: {
        'Set-Cookie': `aw_guest=fixture; Secure; HttpOnly; SameSite=Strict; Path=/studio/; Expires=${new Date(Date.now() + 86400_000).toUTCString()}`,
      },
    });
  return new Response(JSON.stringify({ data: [{ id: 'workspace-id' }] }));
};

test('Guest enablement verifies cookie and Workspace after rollout', async () => {
  const calls = [];
  await enableGuest(
    config,
    (args) => {
      calls.push(args);
      return target;
    },
    good,
  );
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['get', 'set', 'rollout'],
  );
});
test('failed Guest verification rolls back and checks readiness', async () => {
  const calls = [];
  await assert.rejects(
    enableGuest(
      config,
      (args) => {
        calls.push(args);
        return target;
      },
      async () => new Response('{}'),
    ),
    /rolled back/,
  );
  assert.deepEqual(
    calls.map((call) => call.slice(0, 2)),
    [
      ['get', 'deployment/workspace'],
      ['set', 'env'],
      ['rollout', 'status'],
      ['rollout', 'undo'],
      ['rollout', 'status'],
    ],
  );
});
test('unsafe target and secret-backed Guest settings fail before mutation', async () => {
  await assert.rejects(
    enableGuest({ ...config, namespace: 'bad/value' }, () => assert.fail('kubectl called'), good),
    /DNS/,
  );
  const secretTarget = JSON.stringify({
    spec: {
      template: {
        spec: {
          containers: [{ name: 'api', env: [{ name: 'WORKSPACE_GUEST_ENABLED', valueFrom: {} }] }],
        },
      },
    },
  });
  let count = 0;
  await assert.rejects(
    enableGuest(
      config,
      () => {
        count++;
        return secretTarget;
      },
      good,
    ),
    /supported value/,
  );
  assert.equal(count, 1);
});

test('uncertain configuration update does not undo an unrelated deployment', async () => {
  const calls = [];
  await assert.rejects(
    enableGuest(
      config,
      (args) => {
        calls.push(args);
        if (args[0] === 'set') throw new Error('network timeout');
        return target;
      },
      good,
    ),
    /outcome is uncertain/,
  );
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['get', 'set'],
  );
});
