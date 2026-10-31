import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnose } from './diagnose-dev-api.mjs';

test('diagnostics report only safe bounded status and fixed error labels', () => {
  const calls = [];
  const result = diagnose({ namespace: 'dev', deployment: 'api', container: 'api' }, (args) => {
    calls.push(args);
    if (args[1] === 'deployment/api')
      return JSON.stringify({
        spec: { replicas: 1, selector: { matchLabels: { app: 'api' } } },
        status: {},
      });
    if (args[1] === 'pods')
      return JSON.stringify({
        items: [
          {
            metadata: { name: 'api-123' },
            status: {
              phase: 'Running',
              containerStatuses: [
                {
                  name: 'api',
                  ready: false,
                  restartCount: 3,
                  lastState: { terminated: { exitCode: 1 } },
                },
              ],
            },
          },
        ],
      });
    return 'private-synthetic-secret Workspace startup unavailable for region:private';
  });
  assert.deepEqual(result.pods[0].indicators, ['workspace-startup-unavailable']);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.ok(!calls.some((args) => ['set', 'delete', 'rollout'].includes(args[0])));
});

test('diagnostics distinguish forbidden logs without exposing private errors', () => {
  const result = diagnose({ namespace: 'dev', deployment: 'api', container: 'api' }, (args) => {
    if (args[1] === 'deployment/api')
      return JSON.stringify({
        spec: { replicas: 1, selector: { matchLabels: { app: 'api' } } },
        status: {},
      });
    if (args[1] === 'pods')
      return JSON.stringify({
        items: [{ metadata: { name: 'api-123' }, status: { phase: 'Running' } }],
      });
    const error = new Error('private value');
    error.stderr = 'Forbidden private value';
    throw error;
  });
  assert.equal(result.pods[0].logReads, 0);
  assert.equal(result.pods[0].logAccessDenied, true);
  assert.ok(!JSON.stringify(result).includes('private value'));
});

test('permission checks expose only booleans and never change cluster state', () => {
  const calls = [];
  const result = diagnose({ namespace: 'dev', deployment: 'api', container: 'api' }, (args) => {
    calls.push(args);
    if (args[1] === 'deployment/api')
      return JSON.stringify({
        spec: { replicas: 1, selector: { matchLabels: { app: 'api' } } },
        status: {},
      });
    if (args[1] === 'pods') return JSON.stringify({ items: [] });
    if (args[0] === 'auth') return args[2] === 'create' ? 'no\n' : 'yes\n';
    throw new Error('unexpected');
  });
  assert.deepEqual(result.permissions, {
    createSecrets: false,
    patchSecrets: true,
    patchDeployments: true,
  });
  assert.ok(!calls.some((args) => ['create', 'patch', 'delete', 'rollout'].includes(args[0])));
});
