import assert from 'node:assert/strict';
import test from 'node:test';
import { migrate } from './migrate-hosted-execute-config.mjs';

const image = `registry.example/api@sha256:${'a'.repeat(64)}`;
const options = { namespace: 'dev', deployment: 'workspace', container: 'api' };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
function fake({
  ambiguous = false,
  duplicate = false,
  rejectReplace = false,
  immutable = false,
  rejectDeployment = false,
} = {}) {
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
    immutable,
    data: {
      'api.json': encode(config),
      'api-bootstrap.json': encode(config),
      'private-key': 'c2VjcmV0',
    },
  };
  const initial = structuredClone(secret);
  let volumes = [
    { name: 'config-volume', secret: { secretName: 'config' } },
    ...(duplicate ? [{ name: 'other-volume', secret: { secretName: 'other' } }] : []),
  ];
  const kubectl = (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'get' && args[1] === 'deployment/workspace')
      return JSON.stringify({
        metadata: { resourceVersion: '34' },
        spec: {
          replicas: 1,
          strategy: { type: 'Recreate' },
          template: {
            spec: {
              containers: [{ name: 'api', image }],
              volumes,
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
    if (args[0] === 'patch' && args[1] === 'secret') {
      if (rejectReplace) throw new Error('unknown result');
      const patch = JSON.parse(input);
      assert.equal(patch.metadata.resourceVersion, secret.metadata.resourceVersion);
      secret = { ...secret, data: { ...secret.data, ...patch.data } };
    }
    if (args[0] === 'patch' && args[1] === 'deployment/workspace') {
      if (rejectDeployment) throw new Error('unknown deployment update');
      volumes = JSON.parse(input).spec.template.spec.volumes;
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

test('immutable configuration creates a private copy and switches only its volume', async () => {
  const f = fake({ immutable: true });
  await migrate(options, f.kubectl, async () => ({ ok: true }));
  const create = f.calls.find((call) => call.args[0] === 'create');
  const replacement = JSON.parse(create.input);
  assert.equal(replacement.immutable, true);
  assert.equal(replacement.data['private-key'], f.initial.data['private-key']);
  assert.equal(
    Object.hasOwn(
      JSON.parse(Buffer.from(replacement.data['api.json'], 'base64')).product,
      'compute',
    ),
    false,
  );
  const patch = f.calls.find(
    (call) => call.args[0] === 'patch' && call.args[1] === 'deployment/workspace',
  );
  const value = JSON.parse(patch.input);
  assert.equal(value.metadata.resourceVersion, '34');
  assert.equal(value.spec.template.spec.volumes[0].secret.secretName, replacement.metadata.name);
  assert.ok(!f.calls.some((call) => call.args[0] === 'rollout' && call.args[1] === 'restart'));
  assert.ok(!JSON.stringify(create.args).includes('c2VjcmV0'));
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

test('an uncertain immutable-volume update does not retry or remove the original Secret', async () => {
  const f = fake({ immutable: true, rejectDeployment: true });
  await assert.rejects(migrate(options, f.kubectl, async () => ({ ok: true })));
  assert.equal(f.calls.filter((call) => call.args[0] === 'create').length, 1);
  assert.equal(
    f.calls.filter((call) => call.args[0] === 'patch' && call.args[1] === 'deployment/workspace')
      .length,
    1,
  );
  assert.ok(!f.calls.some((call) => ['delete', 'rollout'].includes(call.args[0])));
});
