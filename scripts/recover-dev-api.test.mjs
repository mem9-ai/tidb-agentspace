import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { recover } from './recover-dev-api.mjs';

const image = `registry.example/api@sha256:${'a'.repeat(64)}`;
const previous = `registry.example/api@sha256:${'b'.repeat(64)}`;
const options = { namespace: 'dev', deployment: 'workspace', container: 'api', image };
function fake({ actual = image, retirement = false } = {}) {
  const calls = [];
  const kubectl = (args) => {
    calls.push(args);
    if (args[0] === 'get')
      return JSON.stringify({
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: 'api',
                  image: actual,
                  env: retirement
                    ? [{ name: 'WORKSPACE_RETIRE_LEGACY', value: 'ws_agentlab' }]
                    : [],
                },
              ],
            },
          },
        },
      });
    if (args[1] === 'undo') actual = previous;
    return '';
  };
  return { calls, kubectl };
}

test('rollback checks the failed image and verifies the prior image and public health', async () => {
  const f = fake();
  await recover(options, f.kubectl, async () => ({ ok: true }));
  assert.ok(f.calls.some((args) => args[1] === 'undo'));
});

test('rollback refuses changed deployments and any legacy retirement state', async () => {
  for (const setting of [{ actual: previous }, { retirement: true }]) {
    const f = fake(setting);
    await assert.rejects(recover(options, f.kubectl, async () => ({ ok: true })));
    assert.ok(!f.calls.some((args) => args[1] === 'undo'));
  }
});

test('rollback reports an unhealthy public API', async () => {
  const f = fake();
  await assert.rejects(
    recover(options, f.kubectl, async () => ({ ok: false })),
    /health remains unavailable/,
  );
});

test('incident workflow uses the immutable digest confirmed by deployment without ECR read privileges', () => {
  const workflow = parse(readFileSync('.github/workflows/recover-dev-api.yml', 'utf8'));
  assert.ok(
    workflow.jobs.recover.env.FAILED_IMAGE.endsWith(
      '@sha256:4cf10b1618ae25b8e4e9772ae3755cb67bf5c2d3409d100049f1fdb7a9291dbe',
    ),
  );
  assert.ok(!workflow.jobs.recover.steps.some((step) => step.run?.includes('describe-images')));
});
