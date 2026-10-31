import assert from 'node:assert/strict';
import test from 'node:test';
import { retireLegacy } from './retire-legacy-workspace.mjs';

const image = `registry.example/test@sha256:${'a'.repeat(64)}`;
const options = {
  namespace: 'dev',
  deployment: 'workspace',
  container: 'api',
  image,
  origin: 'https://drive9.ai',
};
function fake({ marker = true, runningImage = image, replicas = 1 } = {}) {
  let flag;
  const calls = [];
  const kubectl = (args) => {
    calls.push(args);
    if (args[0] === 'get')
      return JSON.stringify({
        spec: {
          replicas,
          strategy: { type: 'Recreate' },
          template: {
            spec: {
              containers: [
                {
                  name: 'api',
                  image: runningImage,
                  env: flag ? [{ name: 'WORKSPACE_RETIRE_LEGACY', value: flag }] : [],
                },
              ],
            },
          },
        },
      });
    if (args[0] === 'logs')
      return marker
        ? 'Legacy Workspace live metadata and credentials removed.\n'
        : 'not confirmed\n';
    if (args[0] === 'set') flag = args.at(-1).endsWith('-') ? undefined : 'ws_agentlab';
    return '';
  };
  return { calls, kubectl, flag: () => flag };
}

test('retirement requires the exact image and explicitly clears its temporary flag', async () => {
  const f = fake();
  await retireLegacy(options, f.kubectl, async () => ({ ok: true }));
  assert.equal(f.calls.filter((args) => args[0] === 'rollout').length, 2);
  assert.equal(f.flag(), undefined);
});

test('retirement fails before mutation for a different image or replica count', async () => {
  for (const settings of [
    { runningImage: `registry.example/test@sha256:${'b'.repeat(64)}` },
    { replicas: 2 },
  ]) {
    const f = fake(settings);
    await assert.rejects(retireLegacy(options, f.kubectl, async () => ({ ok: true })));
    assert.ok(!f.calls.some((args) => args[0] === 'set'));
  }
});

test('unconfirmed retirement keeps its retry flag and never rolls back', async () => {
  const f = fake({ marker: false });
  await assert.rejects(
    retireLegacy(options, f.kubectl, async () => ({ ok: true })),
    /not confirmed/,
  );
  assert.equal(f.flag(), 'ws_agentlab');
  assert.ok(!f.calls.some((args) => args.includes('undo')));
});
