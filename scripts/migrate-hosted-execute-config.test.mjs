import assert from 'node:assert/strict';
import test from 'node:test';
import { migrate } from './migrate-hosted-execute-config.mjs';

const image = `registry.example/api@sha256:${'a'.repeat(64)}`;
const options = { namespace: 'dev', deployment: 'workspace', container: 'api' };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
function fake({ ambiguous = false, duplicate = false, rejectReplace = false } = {}) {
  const calls = [];
  const config = {
    workspaceId: 'ws_agentlab',
    product: {
      providers: { privateMarker: 'unchanged' },
      compute: { extensionPath: '/private/path', extensionSha256: 'synthetic' },
      ...(ambiguous ? { execute: {} } : {}),
    },
  };
  let secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'config', resourceVersion: '17', labels: { preserved: 'yes' } },
    data: {
      'api.json': encode(config),
      'api-bootstrap.json': encode(config),
      'private-key': 'c2VjcmV0',
    },
  };
  const initial = structuredClone(secret);
  const kubectl = (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'get' && args[1] === 'deployment/workspace')
      return JSON.stringify({
        spec: {
          replicas: 1,
          strategy: { type: 'Recreate' },
          template: {
            spec: {
              containers: [{ name: 'api', image }],
              volumes: [
                { secret: { secretName: 'config' } },
                ...(duplicate ? [{ secret: { secretName: 'other' } }] : []),
              ],
            },
          },
        },
      });
    if (args[0] === 'get' && args[1] === 'secret')
      return JSON.stringify(
        args[2] === 'other'
          ? { ...secret, metadata: { ...secret.metadata, name: 'other' } }
          : secret,
      );
    if (args[0] === 'patch') {
      if (rejectReplace) throw new Error('unknown result');
      const patch = JSON.parse(input);
      assert.equal(patch.metadata.resourceVersion, secret.metadata.resourceVersion);
      secret = { ...secret, data: { ...secret.data, ...patch.data } };
    }
    return '';
  };
  return { calls, kubectl, initial, current: () => secret };
}

test('migrates only the two config fields, retaining secrets and resourceVersion via stdin', async () => {
  const f = fake();
  await migrate(options, f.kubectl, async () => ({ ok: true }));
  const after = f.current();
  assert.deepEqual(after.metadata, f.initial.metadata);
  assert.equal(after.data['private-key'], f.initial.data['private-key']);
  for (const key of ['api.json', 'api-bootstrap.json']) {
    const old = JSON.parse(Buffer.from(f.initial.data[key], 'base64'));
    const updated = JSON.parse(Buffer.from(after.data[key], 'base64'));
    assert.deepEqual(updated.product.execute, old.product.compute);
    assert.equal(Object.hasOwn(updated.product, 'compute'), false);
    assert.deepEqual(updated.product.providers, old.product.providers);
  }
  const patch = f.calls.find((call) => call.args[0] === 'patch');
  assert.ok(patch.input);
  assert.deepEqual(Object.keys(JSON.parse(patch.input).data).sort(), [
    'api-bootstrap.json',
    'api.json',
  ]);
  assert.ok(!JSON.stringify(patch.args).includes('c2VjcmV0'));
  assert.ok(f.calls.some((call) => call.args[0] === 'rollout' && call.args[1] === 'restart'));
});

test('ambiguous or duplicate configuration fails before mutation', async () => {
  for (const setting of [{ ambiguous: true }, { duplicate: true }]) {
    const f = fake(setting);
    await assert.rejects(migrate(options, f.kubectl, async () => ({ ok: true })));
    assert.ok(!f.calls.some((call) => ['patch', 'rollout'].includes(call.args[0])));
  }
});

test('an uncertain Secret update does not blindly restart or retry', async () => {
  const f = fake({ rejectReplace: true });
  await assert.rejects(migrate(options, f.kubectl, async () => ({ ok: true })));
  assert.equal(f.calls.filter((call) => call.args[0] === 'patch').length, 1);
  assert.ok(!f.calls.some((call) => call.args[0] === 'rollout'));
});
